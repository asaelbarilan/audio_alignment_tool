"""Publish the human-labeled clips of a dataset (see DATASET_SPEC.md) as a Hugging Face
AudioFolder dataset (https://huggingface.co/docs/hub/datasets-audio).

    python -m hebrew_training.publish_labeled_dataset --dataset ivrit-ai \\
        --datasets-bucket my-bucket --hf-target someuser/ivrit-ai-gold

Only clips an annotator has marked *done* are included -- see align_tag_server.py's
claim/finish flow. Marks come from wherever align_tag_server.py itself reads them: a
Postgres database when DATABASE_URL is set (the same env var align_tag_server.py checks),
or the --out directory's `_claims.json` + `<annotator>.jsonl` files otherwise (pass that
same directory here as --annotations-out).

A clip's `claims` row is unique per (dataset, clip), so at most one annotator's claim can
be `done` for it at any moment -- if a clip was ever finished by someone else first and
later reclaimed, only the current claim survives. Still, since several annotators' saved
marks for the same clip can coexist (an earlier annotator's `<name>.jsonl` row is never
deleted just because someone else later reclaimed and finished it), this script resolves
ties defensively: were more than one done claim ever found for the same clip, the one
with the earliest `claimed_at` wins.

Only the words the annotator actually kept are used -- align_tag_server.py's gold rows
already carry exactly that set (an ASR word the annotator corrected keeps its corrected
text and gains a `was` field for the original; a word they added is flagged `added`; a
word they deleted is simply absent). The clip's `text` is therefore *not* reused from the
manifest -- it is recomposed by joining those kept words, so it reflects the human fix.

Output layout (an AudioFolder repo -- https://huggingface.co/docs/hub/datasets-audio):

    <target>/
      metadata.jsonl        one row per published clip, auto-detected by the Hub
      audio/<id>.wav         the clip's audio, copied from the dataset

Each metadata.jsonl row:

    {"audio_file_name": "audio/<id>.wav", "id": "...", "metadata": {...},
     "text": "...", "words": [{"word": "...", "start": 0.0, "end": 0.0}, ...],
     "annotator": "<name>"}

`annotator` is who produced the row's words. By default each clip appears once, with the
annotator whose claim is `done`. With --all-annotators, every other annotator who also saved
marks for a done clip gets a row of their own for it too -- same `id` and audio, their own
words -- so two people's timings of one clip can be compared. The evaluation project
(eval-forced-alignment) reads both shapes and computes its human-agreement floor from the
clips that have more than one row.

`audio_file_name` (matching the Hub's `*_file_name` convention) is what makes the Hub's
AudioFolder loader link each row back to its audio file with no extra config.

Pass --local-target to build the dataset in a folder you keep, --hf-target to push it to
a hub dataset repo (full name, e.g. "someuser/some-dataset"), or both to build once locally
and publish that same folder. At least one is required.

Credentials: S3_ENDPOINT / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (or
--datasets-folder for a local dataset copy), DATABASE_URL for the Postgres marks store,
and HF_TOKEN for the Hub push -- all loaded from .env via python-dotenv if present, never
read or printed by this script beyond what each library needs to authenticate.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from hebrew_training.align_tag_server import (  # noqa: E402
    FileClaims,
    PostgresStore,
    resolve_dataset,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--dataset",
        required=True,
        help="Dataset name -- the S3/local prefix holding manifest.jsonl and audio/, and "
        "the Postgres `dataset` column the marks/claims were saved under.",
    )
    parser.add_argument(
        "--datasets-folder",
        type=Path,
        help="Local folder holding one subfolder per dataset (manifest + audio source). "
        "Mutually exclusive with --datasets-bucket; that one wins if both are set.",
    )
    parser.add_argument(
        "--datasets-bucket",
        default=os.environ.get("DATASETS_BUCKET") or os.environ.get("S3_BUCKET", ""),
        help="Read the manifest/audio from this S3 bucket instead of --datasets-folder -- "
        "same layout upload_dataset.py writes. Defaults to DATASETS_BUCKET or S3_BUCKET "
        "from the environment / .env.",
    )
    parser.add_argument(
        "--annotations-out",
        type=Path,
        help="The --out directory align_tag_server.py was run with (holds _claims.json "
        "and <annotator>.jsonl). Required unless DATABASE_URL is set, in which case marks "
        "and claims are read from Postgres instead.",
    )
    parser.add_argument(
        "--hf-target",
        help="Full hub dataset repo id to publish to, e.g. 'someuser/some-dataset'.",
    )
    parser.add_argument(
        "--local-target",
        type=Path,
        help="Local folder to build (and keep) the AudioFolder dataset in. Used as the "
        "working directory even when --hf-target is also given, instead of a temp folder.",
    )
    parser.add_argument(
        "--hf-token",
        default=os.environ.get("HF_TOKEN", ""),
        help="Hub token for the push. Defaults to HF_TOKEN from the environment / .env, "
        "or huggingface_hub's own cached login if neither is set.",
    )
    parser.add_argument(
        "--private",
        action="store_true",
        help="Create the hub dataset repo as private (only takes effect the first time "
        "the repo is created).",
    )
    parser.add_argument(
        "--all-annotators",
        action="store_true",
        help="Also publish, for every done clip, the marks of each other annotator who saved "
        "some, as extra rows with the same id. Default: only the done claimant's.",
    )
    parser.add_argument(
        "--workers", type=int, default=8, help="Parallel audio-download threads (default: 8)."
    )
    args = parser.parse_args()
    if not args.hf_target and not args.local_target:
        parser.error("pass --hf-target, --local-target, or both")
    return args


def resolve_done_claims(args: argparse.Namespace) -> tuple[dict[str, list], str | None, Path | None]:
    """Returns (done -> {clip_id: [(annotator, claimed_at), ...]} sorted earliest-first,
    the PostgresStore's dataset name if Postgres-backed, the annotations dir if file-backed).

    Only one of the last two is not None -- whichever store the marks actually come from.
    """
    database_url = os.environ.get("DATABASE_URL", "")
    if database_url:
        store: PostgresStore | FileClaims = PostgresStore(database_url, args.dataset)
        backend: tuple[str | None, Path | None] = (args.dataset, None)
    else:
        if not args.annotations_out:
            raise SystemExit(
                "no marks source: pass --annotations-out (align_tag_server.py's --out "
                "directory), or set DATABASE_URL to read from Postgres instead"
            )
        store = FileClaims(args.annotations_out)
        backend = (None, args.annotations_out)

    by_clip: dict[str, list[tuple[str, float]]] = {}
    for clip_id, (annotator, claimed_at, _touched_at, done) in store.claims().items():
        if done:
            by_clip.setdefault(clip_id, []).append((annotator, claimed_at))
    for entries in by_clip.values():
        entries.sort(key=lambda pair: pair[1])  # earliest claimed_at first
    return by_clip, store, backend


def load_file_marks(out_dir: Path) -> dict[str, dict[str, list]]:
    """annotator -> {clip_id: words}, one pass over every <annotator>.jsonl in out_dir."""
    marks: dict[str, dict[str, list]] = {}
    if not out_dir.exists():
        return marks
    for f in sorted(out_dir.glob("*.jsonl")):
        if f.name.startswith("_"):
            continue
        annotator = f.stem
        rows: dict[str, list] = {}
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in row and "words" in row:
                rows[row["id"]] = row["words"]
        marks[annotator] = rows
    return marks


def compose_row(clip: dict, words: list[dict], annotator: str) -> dict:
    kept = [{"word": w["word"], "start": w["start"], "end": w["end"]} for w in words]
    return {
        "audio_file_name": clip["audio"],
        "id": clip["id"],
        "metadata": clip.get("metadata", {}),
        "text": " ".join(w["word"] for w in kept),
        "words": kept,
        "annotator": annotator,
    }


def main() -> None:
    args = parse_args()

    dataset = resolve_dataset(args)
    manifest_by_id = {clip["id"]: clip for clip in dataset.manifest()}

    done_by_clip, store, (pg_dataset, file_out) = resolve_done_claims(args)
    if not done_by_clip:
        raise SystemExit(f"no clip in {args.dataset!r} is marked done -- nothing to publish")

    file_marks = load_file_marks(file_out) if file_out is not None else None

    rows: list[dict] = []
    missing_manifest = 0
    missing_marks = 0
    extra_rows = 0
    for clip_id, entries in done_by_clip.items():
        annotator, _claimed_at = entries[0]  # earliest-claimed among ties, see docstring
        clip = manifest_by_id.get(clip_id)
        if clip is None:
            missing_manifest += 1
            continue
        if file_marks is not None:
            by_who = {who: m[clip_id] for who, m in file_marks.items() if m.get(clip_id)}
        else:
            by_who = store.clip_marks(clip_id)  # type: ignore[union-attr]
        words = by_who.get(annotator)
        if not words:
            missing_marks += 1
            continue
        rows.append(compose_row(clip, words, annotator))
        if args.all_annotators:
            for other in sorted(by_who):
                if other != annotator and by_who[other]:
                    rows.append(compose_row(clip, by_who[other], other))
                    extra_rows += 1

    if missing_manifest:
        print(f"skipping {missing_manifest} done clip(s) no longer in the manifest", file=sys.stderr)
    if missing_marks:
        print(
            f"skipping {missing_marks} done clip(s) with no saved marks for their claiming "
            "annotator",
            file=sys.stderr,
        )
    if not rows:
        raise SystemExit("nothing left to publish once unresolved clips were skipped")

    rows.sort(key=lambda r: (r["id"], r["annotator"]))
    print(f"{len(rows)} labeled row(s) to publish"
          + (f", {extra_rows} of them second annotators' marks" if extra_rows else ""))

    keep_local = args.local_target is not None
    working_dir = args.local_target or Path(tempfile.mkdtemp(prefix="publish_labeled_dataset_"))
    working_dir.mkdir(parents=True, exist_ok=True)

    try:
        def fetch(row: dict) -> None:
            dest = working_dir / row["audio_file_name"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(dataset.read_bytes(row["audio_file_name"]))

        fetched = 0
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            unique = list({row["audio_file_name"]: row for row in rows}.values())
            futures = {pool.submit(fetch, row): row["id"] for row in unique}
            for future in as_completed(futures):
                future.result()
                fetched += 1
                if fetched % 25 == 0 or fetched == len(unique):
                    print(f"  {fetched}/{len(unique)} audio file(s) fetched")

        metadata_path = working_dir / "metadata.jsonl"
        with metadata_path.open("w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"wrote {metadata_path}")

        if args.hf_target:
            from huggingface_hub import HfApi

            api = HfApi(token=args.hf_token or None)
            api.create_repo(
                repo_id=args.hf_target, repo_type="dataset", private=args.private, exist_ok=True
            )
            api.upload_folder(
                folder_path=str(working_dir),
                repo_id=args.hf_target,
                repo_type="dataset",
                commit_message=f"Publish {len(unique)} labeled clip(s) from {args.dataset}",
            )
            print(f"published to https://huggingface.co/datasets/{args.hf_target}")
    finally:
        if not keep_local:
            shutil.rmtree(working_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
