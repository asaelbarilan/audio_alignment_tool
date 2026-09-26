"""A browser tool for hand-marking Hebrew word boundaries, to build the alignment gold set.

There is no Hebrew corpus with human word timings, so the gold set has to be made by hand,
and hand-marking is the expensive step. Praat can do it but costs a lot of friction per
boundary. This is built around the observation that makes the job cheap:

    most boundaries are already right in one of the aligners

So each word shows both proposals, and the common case is one keypress to accept the better
one. Dragging is the fallback, not the default.

    python -m hebrew_training.align_tag_server \\
        --datasets-folder data/datasets --dataset plenum --out gold.jsonl

then open http://localhost:8080. Clips are served worst-disagreement-first, because that is
where a human judgement is worth the most; agreement regions teach nothing.

Saves after every clip, so it can be closed and reopened. Standard library plus soundfile —
no web framework, no CDN, works offline.

Datasets live under a folder or a bucket (see --datasets-folder / --datasets-bucket): each
top-level entry is one dataset, holding a metadata.json, a manifest.jsonl (one row per clip,
each carrying a `labels` array -- one entry per annotation source, e.g. two forced aligners),
and an audio/ folder. The `labels[0]` entry seeds the marks; a second label, when present, is
only used to rank clips by disagreement.
"""

from __future__ import annotations

import argparse
import base64
import http.client
import io
import hashlib
import json
import os
import re
import socket
import threading
import time
import unicodedata
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from dotenv import load_dotenv

# When a .env file is present - load that
load_dotenv()


_WS = re.compile(r"\s+")
LOCK = threading.Lock()
# Set in main() when the host provides a database. Marks then live there instead of
# on the container disk, which does not survive a redeploy.
STORE = None
CLAIMS = None
RESULTS = None  # EvalResults, set in main()
BLOCK = 10  # clips a person holds at once; refilled as they work
# A claim nobody has finished can go back in the pool, so a person who opens the page and
# wanders off does not strand their share -- but how long it gets to sit depends on whether
# anyone actually did anything with it. A claim that was never saved to is dead weight and
# goes stale fast; one with real work in progress gets a much longer grace period so a slow
# or interrupted annotator does not lose their seat to someone else mid-clip. A claim marked
# `done` is never reclaimed by either clock -- see assign().
NEVER_TOUCHED_STALE_SECONDS = 12 * 3600
TOUCHED_STALE_SECONDS = 36 * 3600


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--datasets-folder",
        type=Path,
        help="Local folder whose top-level subfolders are datasets. Ignored when "
        "--datasets-bucket is also given.",
    )
    parser.add_argument(
        "--datasets-bucket",
        default=os.environ.get("DATASETS_BUCKET") or os.environ.get("S3_BUCKET", ""),
        help="Read datasets from this S3 bucket instead of the filesystem -- same layout, "
        "one top-level key prefix per dataset. Takes priority over --datasets-folder. "
        "Endpoint and credentials come from S3_ENDPOINT / S3_REGION / S3_ACCESS_KEY_ID / "
        "S3_SECRET_ACCESS_KEY.",
    )
    parser.add_argument(
        "--dataset",
        default=os.environ.get("DATASET", ""),
        help="Which dataset to serve -- a top-level folder name under --datasets-folder / "
        "--datasets-bucket. Falls back to the DATASET environment variable when the "
        "--dataset arg is not given.",
    )
    parser.add_argument(
        "--eval-results-bucket",
        default=os.environ.get("EVAL_RESULTS_BUCKET")
        or os.environ.get("DATASETS_BUCKET")
        or os.environ.get("S3_BUCKET", ""),
        help="Bucket that keeps uploaded aligner-eval results, under eval-results/. Defaults "
        "to the datasets bucket. Without one they go to <out>/_eval-results/, which a "
        "redeploy wipes.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Gold manifest. With several annotators this becomes a directory: "
        "each writes <out>/<name>.jsonl, so nobody overwrites anyone.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("HOST", "127.0.0.1"),
        help="0.0.0.0 to accept connections from other machines.",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("TAG_TOKEN", ""),
        help="If set, every request must carry ?t=<token>. Not real auth -- it "
        "just stops a stray crawler writing to your gold set.",
    )
    parser.add_argument(
        "--auth",
        choices=["xhost"],
        help="Require Google sign-in, verifying xhostd's signed cookie. Identity then comes "
        "from the cookie and ?who= is ignored, which is what stops an annotator writing as "
        "someone else. Needs a database for the name bindings.",
    )
    parser.add_argument(
        "--local-auth",
        action="store_true",
        help="Stand in for --auth when xhostd's proxy is not reachable, e.g. running "
        "locally. Signing in is a form on this server asking only for an email, not "
        "Google -- there is no real identity check, so the whole approval queue and "
        "TAG_ADMINS gate can be exercised without xhostd. Needs DATABASE_URL, same as "
        "--auth. Never point this at a host anyone else can reach: whatever email a "
        "browser types in is who the server believes signed in.",
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    args = parser.parse_args()
    if args.local_auth:
        if args.auth:
            parser.error("--auth and --local-auth are two ways to identify people; pick one")
        args.auth = "local"  # not one of --auth's own choices; everything below just
        # tests args.auth for truthiness and only identity() branches on which kind
    return args


def clean(text: str) -> str:
    return _WS.sub(" ", unicodedata.normalize("NFC", text)).strip()


# ---- datasets --------------------------------------------------------------
#
# A dataset is a folder (local or in a bucket) of:
#   metadata.json     {"name": ...}
#   manifest.jsonl     one row per clip: {id, metadata, labels: [...]}
#   audio/<file>.wav    referenced by each label's `audio` field
#
# `labels` is one entry per annotation source (what used to be "the A file" and "the B
# file"), each with its own words -- the same clip, several people's or aligners' opinions
# of where the boundaries are.


class Dataset:
    name: str

    def manifest(self) -> list[dict]:
        raise NotImplementedError

    def metadata(self) -> dict:
        raise NotImplementedError

    def read_bytes(self, relpath: str) -> bytes:
        raise NotImplementedError

    def audio_exists(self, relpath: str) -> bool | None:
        """True/False when checkable up front, None when it can only be known by trying
        (a bucket read costs a round trip, so it is not worth doing 100 times at startup)."""
        return None


def _read_jsonl(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


class LocalDataset(Dataset):
    def __init__(self, root: Path, name: str):
        self.name = name
        self.dir = root / name
        if not self.dir.is_dir():
            available = (
                sorted(p.name for p in root.iterdir() if p.is_dir())
                if root.is_dir()
                else []
            )
            raise SystemExit(
                f"no dataset {name!r} under {root}"
                + (f" (found: {', '.join(available)})" if available else "")
            )

    def manifest(self) -> list[dict]:
        path = self.dir / "manifest.jsonl"
        if not path.exists():
            raise SystemExit(f"missing manifest.jsonl in {self.dir}")
        return _read_jsonl(path.read_text(encoding="utf-8"))

    def metadata(self) -> dict:
        path = self.dir / "metadata.json"
        if not path.exists():
            raise SystemExit(f"missing metadata.json in {self.dir}")
        return json.loads(path.read_text(encoding="utf-8"))

    def read_bytes(self, relpath: str) -> bytes:
        return (self.dir / relpath).read_bytes()

    def audio_exists(self, relpath: str) -> bool | None:
        return (self.dir / relpath).exists()


class BucketDataset(Dataset):
    def __init__(self, bucket: str, name: str):
        self.name = name
        self.bucket = bucket
        self.prefix = f"{name}/"

    def manifest(self) -> list[dict]:
        return _read_jsonl(
            s3_bytes(self.bucket, self.prefix + "manifest.jsonl").decode("utf-8")
        )

    def metadata(self) -> dict:
        return json.loads(
            s3_bytes(self.bucket, self.prefix + "metadata.json").decode("utf-8")
        )

    def read_bytes(self, relpath: str) -> bytes:
        return s3_bytes(self.bucket, self.prefix + relpath)


def resolve_dataset(args) -> Dataset:
    if args.datasets_bucket:
        return BucketDataset(args.datasets_bucket, args.dataset)
    if args.datasets_folder:
        return LocalDataset(args.datasets_folder, args.dataset)
    raise SystemExit("one of --datasets-folder or --datasets-bucket is required")


def timed(label: dict) -> list[dict]:
    return [
        w
        for w in (label.get("words") or [])
        if w.get("start") is not None and w.get("end") is not None
    ]


def disagreement(a: dict, b: dict | None) -> float:
    """How far apart two label sources are on this clip, used to order the work."""
    if not b:
        return 0.0
    wa, wb = timed(a), timed(b)
    if len(wa) != len(wb) or not wa:
        return 0.0
    ends = sorted(abs(float(x["end"]) - float(y["end"])) for x, y in zip(wa, wb))
    return ends[int(0.9 * (len(ends) - 1))]


def build_clips(rows: list[dict]) -> list[dict]:
    """Only clips whose first label's words reproduce its transcript exactly.

    A clip whose words are a subset of what is spoken is worse than useless here: the
    annotator hears seven words, sees four, and has nowhere to put the boundaries for the
    missing three. A second label, when the row has one, is used only to rank the work --
    it is shown for comparison but never has to pass this check itself.
    """
    clips = []
    skipped = 0
    for row in rows:
        labels = row.get("labels") or []
        if not labels:
            continue
        primary = labels[0]
        words = timed(primary)
        if len(words) < 2:
            continue
        text = clean(row.get("text", ""))
        if text and " ".join(clean(w["word"]) for w in words) != text:
            skipped += 1
            continue
        secondary = labels[1] if len(labels) > 1 else None
        other_words = timed(secondary) if secondary else []
        clips.append(
            {
                "id": row["id"],
                "metadata": row.get("metadata") or {},
                "duration": float(row["duration"]),
                "text": row.get("text", ""),
                "audio": row["audio"],
                "labels": [
                    {
                        "source": label.get("source", ""),
                        "words": [
                            {
                                "word": clean(w["word"]),
                                "start": float(w["start"]),
                                "end": float(w["end"]),
                            }
                            for w in timed(label)
                        ],
                    }
                    for label in labels
                ],
                "a": [
                    {
                        "word": clean(w["word"]),
                        "start": float(w["start"]),
                        "end": float(w["end"]),
                    }
                    for w in words
                ],
                "b": (
                    [
                        {
                            "word": clean(w["word"]),
                            "start": float(w["start"]),
                            "end": float(w["end"]),
                        }
                        for w in other_words
                    ]
                    if secondary and len(other_words) == len(words)
                    else None
                ),
                "score": disagreement(primary, secondary),
            }
        )
    if skipped:
        print(f"skipped {skipped} clips whose words do not reproduce the transcript")
    clips.sort(key=lambda c: c["score"], reverse=True)
    return clips


_S3_CACHE: dict[str, bytes] = {}
_S3_ORDER: list[str] = []
S3_CACHE_MAX = (
    48  # ~15 MB of wav; enough that a person working through a block re-reads
)
#                    nothing, small enough not to hold the whole corpus in memory


_S3 = None


def s3_client():
    """Built from the injected environment only. S3_ENDPOINT inside the container is a
    platform-internal address, so constructing it from the hostname would point at the
    wrong place.

    Made once: botocore builds a signer and loads service models per client, which is not
    something to repeat on every clip.
    """
    global _S3
    if _S3 is not None:
        return _S3
    import boto3

    _S3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        region_name=os.environ.get("S3_REGION", "us-east-1"),
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
    )
    return _S3


def s3_bytes(bucket: str, key: str) -> bytes:
    cache_key = f"{bucket}/{key}"
    hit = _S3_CACHE.get(cache_key)
    if hit is not None:
        return hit
    body = s3_client().get_object(Bucket=bucket, Key=key)["Body"].read()
    _S3_CACHE[cache_key] = body
    _S3_ORDER.append(cache_key)
    while len(_S3_ORDER) > S3_CACHE_MAX:
        _S3_CACHE.pop(_S3_ORDER.pop(0), None)
    return body


def clip_wav(clip: dict, dataset: Dataset) -> tuple[bytes, float]:
    """The clip's audio as wav bytes.

    The dataset's audio already is exactly the clip -- no more context pad either side, that
    was a serving-time convenience of the old per-clip files, not part of the clip itself.
    Read through soundfile regardless of source, so a non-wav or stereo file still comes out
    as the mono 16-bit wav the page's <audio> element expects.
    """
    import soundfile

    raw = dataset.read_bytes(clip["audio"])
    with soundfile.SoundFile(io.BytesIO(raw)) as handle:
        rate = handle.samplerate
        wav = handle.read(dtype="float32", always_2d=False)
    if getattr(wav, "ndim", 1) > 1:
        wav = wav.mean(axis=1)
    buffer = io.BytesIO()
    soundfile.write(buffer, wav, rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue(), 0.0


ALIGNER_SAMPLE_RATE = 16000  # the aligner service hard-asserts this; see api-client-guide.md §2


def resample_linear(wav, orig_rate: int, target_rate: int):
    """Plain linear-interpolation resample -- no scipy/librosa dependency for what is,
    in practice, a rare path: most clips in these datasets are already 16kHz, so this only
    runs on the odd one that is not. Good enough for feeding a forced aligner, not meant
    for anything that cares about audio fidelity."""
    import numpy as np

    if orig_rate == target_rate or len(wav) == 0:
        return wav
    duration = len(wav) / orig_rate
    n_target = max(1, int(round(duration * target_rate)))
    x_old = np.linspace(0, duration, num=len(wav), endpoint=False)
    x_new = np.linspace(0, duration, num=n_target, endpoint=False)
    return np.interp(x_new, x_old, wav).astype("float32")


def clip_wav_16k_mono(clip: dict, dataset: Dataset) -> bytes:
    """The clip's audio as mono 16kHz PCM16 wav bytes -- exactly what the aligner service
    requires (api-client-guide.md §2), regardless of what the dataset's own audio is."""
    import soundfile

    raw = dataset.read_bytes(clip["audio"])
    with soundfile.SoundFile(io.BytesIO(raw)) as handle:
        rate = handle.samplerate
        wav = handle.read(dtype="float32", always_2d=False)
    if getattr(wav, "ndim", 1) > 1:
        wav = wav.mean(axis=1)
    if rate != ALIGNER_SAMPLE_RATE:
        wav = resample_linear(wav, rate, ALIGNER_SAMPLE_RATE)
        rate = ALIGNER_SAMPLE_RATE
    buffer = io.BytesIO()
    soundfile.write(buffer, wav, rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


class AlignerError(Exception):
    """The aligner service could not be reached, or answered with something unusable."""


class AlignerCancelled(Exception):
    """The annotator cancelled this align while it was in flight."""


# Punctuation that is never a real Hebrew letter (unlike the geresh/gershayim ' and " used
# inside real words, e.g. צה"ל) but that the deployed aligner's uroman step turns into its
# own token with no matching audio -- observed directly against the endpoint as a 500
# ("speech file ... failed for '.'") on ordinary sentence-final periods. Stripped only from
# the copy sent to the aligner; the transcript kept in `clip`/the gold row is untouched, and
# nothing here changes the space-separated word *count*, which is what has to keep matching.
_ALIGNER_STRIP = str.maketrans("", "", ".,;:!?…")


def sanitize_transcript_for_aligner(text: str) -> str:
    return text.translate(_ALIGNER_STRIP)


def aligner_config() -> tuple[str, str, str | None, str]:
    endpoint_id = os.environ.get("ENDPOINT_ID", "")
    api_key = os.environ.get("RP_API_KEY") or os.environ.get("RUNPOD_API_KEY", "")
    if not endpoint_id or not api_key:
        raise AlignerError("Aligner disabled")
    model_name = os.environ.get("ALIGNER_MODEL_NAME") or None
    language = os.environ.get("ALIGNER_LANGUAGE", "heb")
    return endpoint_id, api_key, model_name, language


ALIGN_TIMEOUT = 180  # seconds -- cold starts can take a couple of minutes, see guide §4


class AlignJob:
    """One in-flight (or finished) call to the aligner service.

    `conn` is the live HTTP connection while a request is in flight, guarded by `lock` so
    a cancel from another thread never races the request thread over the same socket.
    Cancelling a Load-Balancer HTTP call has no API of its own -- the call itself *is* the
    job, so ending it means shutting the socket out from under whichever thread is blocked
    reading the response. `shutdown()` (not `close()`) is what makes that safe: it acts on
    the underlying kernel socket rather than just this thread's handle to it, so it reliably
    interrupts a concurrent blocking read instead of racing a possibly-reused fd.
    """

    def __init__(self, job_id: str, who: str, clip_key: str, user_words: list[str]):
        self.id = job_id
        self.who = who
        self.clip_key = clip_key
        self.user_words = user_words
        self.status = "running"  # running | done | error | cancelled
        self.words: list[dict] | None = None
        self.error: str | None = None
        self.created_at = time.time()
        self.finished_at: float | None = None
        self.cancel_event = threading.Event()
        self.lock = threading.Lock()
        self.conn: http.client.HTTPConnection | None = None

    def cancel(self) -> None:
        self.cancel_event.set()
        with self.lock:
            conn = self.conn
        if conn is None:
            return
        sock = getattr(conn, "sock", None)
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # already closed, or never got past connect(); nothing to interrupt
        try:
            conn.close()
        except Exception:  # noqa: BLE001 -- cancellation must not itself raise
            pass


ALIGN_LOCK = threading.Lock()
ALIGN_JOBS: dict[str, AlignJob] = {}
ALIGN_ACTIVE: dict[tuple[str, str], str] = {}  # (who, clip_key) -> running job id
ALIGN_JOB_MAX_AGE = 3600  # prune finished jobs an hour after they finish


def prune_align_jobs() -> None:
    now = time.time()
    for job_id, job in list(ALIGN_JOBS.items()):
        if job.finished_at is not None and now - job.finished_at > ALIGN_JOB_MAX_AGE:
            ALIGN_JOBS.pop(job_id, None)


def call_aligner(wav_bytes: bytes, transcript: str, job: AlignJob) -> list[dict]:
    """POST /align on the RunPod load-balancer endpoint (see api-client-guide.md). Blocks
    the calling thread for as long as the call takes -- run this on a background thread,
    never on the request-handler thread, since a cold start can take minutes.
    """
    endpoint_id, api_key, model_name, language = aligner_config()
    payload = {
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
        "transcript": transcript,
        "language": language,
    }
    if model_name:
        payload["model_name"] = model_name
    body = json.dumps(payload).encode("utf-8")
    conn = http.client.HTTPSConnection(f"{endpoint_id}.api.runpod.ai", timeout=ALIGN_TIMEOUT)
    with job.lock:
        if job.cancel_event.is_set():
            conn.close()
            raise AlignerCancelled()
        job.conn = conn
    try:
        conn.request(
            "POST",
            "/align",
            body=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            },
        )
        resp = conn.getresponse()
        raw = resp.read()
    except (OSError, http.client.HTTPException) as exc:
        if job.cancel_event.is_set():
            raise AlignerCancelled() from exc
        raise AlignerError(f"could not reach aligner service: {exc}") from exc
    finally:
        with job.lock:
            job.conn = None
        conn.close()
    if job.cancel_event.is_set():
        raise AlignerCancelled()
    if resp.status != 200:
        detail = raw.decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except (json.JSONDecodeError, AttributeError):
            pass
        raise AlignerError(f"aligner service returned {resp.status}: {detail}")
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise AlignerError("aligner service returned invalid JSON") from exc
    words = data.get("words")
    if not isinstance(words, list) or not words:
        raise AlignerError("aligner service returned no words")
    return words


def run_align_job(
    job: AlignJob,
    dataset: Dataset,
    clip: dict,
    clips: list[dict],
    args: argparse.Namespace,
) -> None:
    """Runs on a background thread, started by POST /api/align. Talks to the aligner
    service using the words from the annotator's markings (not the dataset baseline), then
    files the outcome on `job` and updates the annotator's saved marks if successful.
    """
    try:
        wav_bytes = clip_wav_16k_mono(clip, dataset)
        transcript_raw = " ".join(job.user_words)
        transcript = sanitize_transcript_for_aligner(transcript_raw)
        words = call_aligner(wav_bytes, transcript, job)
        cleaned = [
            {
                "word": clean(str(w.get("word", ""))),
                "start": float(w["start"]),
                "end": float(w["end"]),
            }
            for w in words
            if w.get("start") is not None and w.get("end") is not None
        ]
        if not cleaned:
            raise AlignerError("aligner returned no timed words")
        # Ensure the user's exact word tokens (spelling, punctuation) are preserved on the
        # aligned timings.
        if len(job.user_words) == len(cleaned):
            for uw, cw in zip(job.user_words, cleaned):
                cw["word"] = uw
        with job.lock:
            if job.cancel_event.is_set():
                job.status = "cancelled"
            else:
                job.words = cleaned
                job.status = "done"

        with job.lock:
            is_done = (job.status == "done")
        if is_done and job.words:
            with LOCK:
                idx_match = [i for i, c in enumerate(clips) if clip_key(c) == job.clip_key]
                if idx_match:
                    index = idx_match[0]
                    if STORE is not None:
                        mine = STORE.load(job.who, clips)
                        mine[index] = job.words
                        STORE.save(job.who, clips, mine)
                    else:
                        path = gold_path(args, job.who)
                        mine = load_saved(path, clips)
                        mine[index] = job.words
                        write_gold(path, clips, mine)
                    if CLAIMS is not None:
                        CLAIMS.touch(job.who, job.clip_key)
    except AlignerCancelled:
        with job.lock:
            job.status = "cancelled"
    except AlignerError as exc:
        with job.lock:
            job.status = "cancelled" if job.cancel_event.is_set() else "error"
            if job.status == "error":
                job.error = str(exc)
    except Exception as exc:  # noqa: BLE001 -- surface it, don't hang the client's spinner
        with job.lock:
            job.status = "cancelled" if job.cancel_event.is_set() else "error"
            if job.status == "error":
                job.error = f"unexpected error: {exc}"
    finally:
        job.finished_at = time.time()
        with ALIGN_LOCK:
            if ALIGN_ACTIVE.get((job.who, job.clip_key)) == job.id:
                del ALIGN_ACTIVE[(job.who, job.clip_key)]


PAGE_FILE = Path(__file__).with_name("align_tag_page.html")


def page_build() -> str:
    """A short id for the exact UI this server would serve right now."""
    return hashlib.sha256(PAGE_FILE.read_bytes()).hexdigest()[:8]


def page() -> bytes:
    """Read the UI from disk on every request, so editing the page needs no restart.

    The build is stamped in, and /api/progress reports the same value, so a browser holding
    an older copy can notice and reload past its cache instead of silently misbehaving
    against a server that has moved on -- which is exactly how the empty dashboard looked.
    """
    raw = PAGE_FILE.read_bytes()
    return raw.replace(b"__BUILD__", page_build().encode("ascii"), 1)


_NAME = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def admins() -> set[str]:
    """The Google addresses allowed to let new annotators in, from TAG_ADMINS.

    Kept in the environment rather than the code: it is a list of real people's addresses,
    and the repository is public.
    """
    return {e.strip().lower() for e in os.environ.get("TAG_ADMINS", "").split(",") if e.strip()}

AUTH_ISSUER = "https://auth.xhostd.com"
JWKS_URL = "https://auth.xhostd.com/xhost-auth/jwks"
COOKIE = "__Host-xhost_id"
_JWKS: dict = {"keys": [], "fetched": 0.0}


def jwks() -> dict:
    """The signing keys, cached for an hour. Refetched on an unknown kid so a rotation does
    not lock everybody out until the cache expires."""
    import urllib.request

    if _JWKS["keys"] and time.time() - _JWKS["fetched"] < 3600:
        return _JWKS
    with urllib.request.urlopen(JWKS_URL, timeout=10) as handle:
        _JWKS["keys"] = json.loads(handle.read().decode("utf-8")).get("keys", [])
    _JWKS["fetched"] = time.time()
    return _JWKS


def identity(cookie_header: str, host: str) -> dict | None:
    """The signed-in user, or None.

    The token is verified properly -- RS256 pinned, issuer and audience checked, signature
    against the published keys. A decode-only read would accept anything a caller cared to
    forge, and the whole point of this is that an annotator cannot write as someone else.
    """
    import jwt
    from jwt import PyJWKSet

    token = ""
    for part in (cookie_header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE:
            token = value
            break
    if not token:
        return None

    try:
        kid = jwt.get_unverified_header(token).get("kid")
        keys = PyJWKSet.from_dict(jwks())
        signing = next((k for k in keys.keys if k.key_id == kid), None)
        if signing is None:
            _JWKS["fetched"] = 0.0  # a rotated key; refetch once before giving up
            keys = PyJWKSet.from_dict(jwks())
            signing = next((k for k in keys.keys if k.key_id == kid), None)
        if signing is None:
            return None
        claims = jwt.decode(
            token,
            signing.key,
            algorithms=["RS256"],
            issuer=AUTH_ISSUER,
            audience=host,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except Exception:  # noqa: BLE001 -- any failure is simply "not signed in"
        return None
    return {
        "sub": claims["sub"],
        "email": claims.get("email", ""),
        "display": claims.get("name") or claims.get("email", ""),
    }


# ---- --local-auth ------------------------------------------------------------
#
# Stands in for the block above when xhostd's proxy is not reachable, i.e. running this
# server on a laptop. There is no identity provider to verify against, so the trade is
# explicit: whatever email a browser types into the form at /local-auth/login is who the
# server believes signed in. Everything downstream of signed_in() -- who(), standing(),
# the approval queue, the admin check -- takes a plain {sub, email, display} dict either
# way and does not know or care which path produced it.

LOCAL_COOKIE = "tag_local_id"
_LOCAL_SESSIONS: dict[str, dict] = {}  # cookie value -> {"sub", "email", "display"}


def local_sub(email: str) -> str:
    """A stable id per email, the same way a Google account's sub is stable per account --
    signing in twice with the same address returns to the same queued/approved identity,
    which is what lets the approval flow be tested more than once with the same person."""
    return "local:" + email


def local_identity(cookie_header: str) -> dict | None:
    """The --local-auth session, or None. No signature, no issuer, no expiry -- just a
    random id this process handed out, looked up in memory."""
    token = ""
    for part in (cookie_header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == LOCAL_COOKIE:
            token = value
            break
    return _LOCAL_SESSIONS.get(token)


_LOCAL_LOGIN_HTML = b"""<!doctype html>
<meta charset="utf-8">
<title>local sign-in</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 16px}
  input{font:inherit;padding:6px 8px;width:100%;box-sizing:border-box;margin:8px 0}
  button{font:inherit;padding:6px 14px}
  .err{color:#b00}
</style>
<h2>Local sign-in</h2>
<p>Stands in for Google sign-in -- the server was started with <code>--local-auth</code>.
Whatever email you type here is who it believes signed in; there is no real identity
check behind it.</p>
__ERROR__
<form method="post" action="/local-auth/login">
  <label>email<input name="email" type="email" required autofocus></label>
  <button type="submit">sign in</button>
</form>
"""


def local_login_page(error: bool = False) -> bytes:
    msg = b'<p class="err">Type a real-looking email address.</p>' if error else b""
    return _LOCAL_LOGIN_HTML.replace(b"__ERROR__", msg)


class PostgresStore:
    """Marks in Postgres, for hosts whose container disk does not survive a redeploy.

    One row per annotator holding their whole mark set. At 134 clips that is a few KB, so
    rewriting the blob per save costs nothing and removes every question about partial
    writes -- the same reasoning as rewriting the jsonl file in full.

    `claims` and `marks` are scoped by `dataset` -- a clip's `id` is only unique *within*
    its dataset, and the same database can outlive one dataset (a later run points the
    same DATABASE_URL at a different --dataset, or in principle several are served at
    once). Without the dataset column, two unrelated datasets sharing a database would
    either collide on a repeated id or, more mundanely, just get counted together in
    every claim/progress/export query -- there would be no way to tell whose clip a row
    belonged to. `identities` stays global: an annotator's name binding is a property of
    their account, not of whatever dataset they happen to be marking.
    """

    def __init__(self, url: str, dataset: str):
        import psycopg

        self.psycopg = psycopg
        self.url = url
        self.dataset = dataset
        self.pending_migration = False
        with self.connect() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS identities ("
                "  sub     TEXT PRIMARY KEY,"
                "  name    TEXT NOT NULL UNIQUE,"
                "  email   TEXT,"
                "  display TEXT)"
            )
            self._ensure_identity_approval(conn)
            self._ensure_claims_table(conn)
            self._ensure_marks_table(conn)

    def _ensure_identity_approval(self, conn) -> None:
        """Add the approval columns, and let the people already annotating carry on.

        Turning a gate on must not lock out the annotators whose marks are already in the
        table. The grandfathering therefore runs exactly once, at the moment the column is
        created, and never again -- so a later restart cannot silently approve somebody who
        is genuinely waiting.
        """
        already = conn.execute(
            "SELECT 1 FROM information_schema.columns"
            " WHERE table_name = 'identities' AND column_name = 'approved_at'"
        ).fetchone()
        if already:
            return
        conn.execute("ALTER TABLE identities ADD COLUMN approved_at TIMESTAMPTZ")
        conn.execute("ALTER TABLE identities ADD COLUMN approved_by TEXT")
        conn.execute("ALTER TABLE identities ADD COLUMN first_seen TIMESTAMPTZ DEFAULT now()")
        conn.execute(
            "UPDATE identities SET approved_at = now(), approved_by = 'already annotating'"
        )

    def is_approved(self, sub: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT approved_at FROM identities WHERE sub = %s", (sub,)
            ).fetchone()
        return bool(row and row[0])

    def waiting(self) -> list[dict]:
        """Everyone who has picked a name but has not been let in yet."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT sub, name, email, display, first_seen FROM identities"
                " WHERE approved_at IS NULL ORDER BY first_seen"
            ).fetchall()
        return [
            {"sub": r[0], "name": r[1], "email": r[2], "display": r[3],
             "since": r[4].isoformat() if r[4] else None}
            for r in rows
        ]

    def approve(self, sub: str, by: str) -> bool:
        with self.connect() as conn:
            done = conn.execute(
                "UPDATE identities SET approved_at = now(), approved_by = %s"
                " WHERE sub = %s AND approved_at IS NULL",
                (by, sub),
            )
            return bool(getattr(done, "rowcount", 0))

    def _ensure_claims_table(self, conn) -> None:
        if conn.execute("SELECT to_regclass('claims')").fetchone()[0] is None:
            conn.execute(
                "CREATE TABLE claims ("
                "  dataset    TEXT NOT NULL,"
                "  clip_key   TEXT NOT NULL,"
                "  annotator  TEXT NOT NULL,"
                "  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),"
                "  touched_at TIMESTAMPTZ,"
                "  done       BOOLEAN NOT NULL DEFAULT false,"
                "  PRIMARY KEY (dataset, clip_key))"
            )
            return
        has_dataset = conn.execute(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_name = 'claims' AND column_name = 'dataset'"
        ).fetchone()
        if has_dataset is None:
            # Pre-dates multi-dataset serving. Nothing is lost rebuilding it in place if
            # it is empty; if it is not, a person needs to confirm the migration first --
            # same gate as the marks blob migration below.
            if conn.execute("SELECT count(*) FROM claims").fetchone()[0] == 0:
                conn.execute("DROP TABLE claims")
                self._ensure_claims_table(conn)
            else:
                self.pending_migration = True
            return
        # Additive and nullable, so no migration gate is needed: a claim from before
        # touch-tracking existed just reads back as "never touched" until its owner
        # saves again, which is the same as the truth.
        has_touched = conn.execute(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_name = 'claims' AND column_name = 'touched_at'"
        ).fetchone()
        if has_touched is None:
            conn.execute("ALTER TABLE claims ADD COLUMN touched_at TIMESTAMPTZ")

    def _ensure_marks_table(self, conn) -> None:
        # marks: one row per (dataset, annotator, clip), so a save only rewrites the clip
        # that changed. A pre-existing table without the clip_key column is the old
        # schema (one JSONB blob per annotator); one without the dataset column pre-dates
        # multi-dataset serving. Either is served read-only until a user confirms the
        # migration -- see migrate().
        if conn.execute("SELECT to_regclass('marks')").fetchone()[0] is None:
            conn.execute(
                "CREATE TABLE marks ("
                "  dataset    TEXT NOT NULL,"
                "  annotator  TEXT NOT NULL,"
                "  clip_key   TEXT NOT NULL,"
                "  payload    JSONB NOT NULL,"
                "  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),"
                "  PRIMARY KEY (dataset, annotator, clip_key))"
            )
            return
        columns = {
            r[0]
            for r in conn.execute(
                "SELECT column_name FROM information_schema.columns"
                " WHERE table_name = 'marks'"
            ).fetchall()
        }
        if "dataset" in columns:
            return
        if "clip_key" not in columns:
            self.pending_migration = True  # ancient one-blob-per-annotator shape
            return
        if conn.execute("SELECT count(*) FROM marks").fetchone()[0] == 0:
            conn.execute("DROP TABLE marks")
            self._ensure_marks_table(conn)
        else:
            self.pending_migration = True

    def connect(self):
        return self.psycopg.connect(self.url, autocommit=True)

    def load(self, who: str, clips: list[dict]) -> dict[int, list]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM marks WHERE dataset = %s AND annotator = %s",
                (self.dataset, who),
            ).fetchall()
        if not rows:
            return {}
        return index_rows([r[0] for r in rows], clips)

    def claims(self) -> dict[str, tuple[str, float, float | None, bool]]:
        """clip_key -> (annotator, claimed_at, touched_at, done). `touched_at` is None
        for a claim nobody has ever saved to."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT clip_key, annotator, EXTRACT(EPOCH FROM claimed_at),"
                "       EXTRACT(EPOCH FROM touched_at), done"
                "  FROM claims WHERE dataset = %s",
                (self.dataset,),
            ).fetchall()
        return {
            r[0]: (r[1], float(r[2]), float(r[3]) if r[3] is not None else None, r[4])
            for r in rows
        }

    def claim(self, who: str, keys: list[str]) -> set[str]:
        """Take these clips for `who`, skipping any another annotator still holds.

        ON CONFLICT is what makes this safe: two people refilling at the same instant race
        for the same row, and the loser takes none of it rather than both walking away
        believing they own the clip. A claim is only stealable once it has gone stale
        without being finished -- and never once it is `done`, at any age.

        Returns the keys actually taken. The caller must not assume ownership of a key
        this WHERE clause silently refused (still fresh, or already done) -- that
        mismatch between what was asked for and what the database actually granted is
        exactly the bug this return value exists to prevent.
        """
        if not keys:
            return set()
        now = time.time()
        never_cutoff = now - NEVER_TOUCHED_STALE_SECONDS
        touched_cutoff = now - TOUCHED_STALE_SECONDS
        taken = set()
        with self.connect() as conn:
            for key in keys:
                cur = conn.execute(
                    "INSERT INTO claims (dataset, clip_key, annotator) VALUES (%s, %s, %s)"
                    " ON CONFLICT (dataset, clip_key) DO UPDATE"
                    "   SET annotator = EXCLUDED.annotator, claimed_at = now(),"
                    "       touched_at = NULL, done = false"
                    " WHERE claims.annotator = %s"
                    "    OR (claims.done = false AND ("
                    "         (claims.touched_at IS NULL"
                    "          AND claims.claimed_at < to_timestamp(%s))"
                    "      OR (claims.touched_at IS NOT NULL"
                    "          AND claims.touched_at < to_timestamp(%s))"
                    "    ))",
                    (self.dataset, key, who, who, never_cutoff, touched_cutoff),
                )
                if cur.rowcount:
                    taken.add(key)
        return taken

    def touch(self, who: str, key: str) -> None:
        """Record that `who` actually saved this clip just now. Resets the 36h grace
        clock so someone mid-way through a clip does not lose it to a reclaim just
        because they are working slowly."""
        with self.connect() as conn:
            conn.execute(
                "UPDATE claims SET touched_at = now()"
                " WHERE dataset = %s AND clip_key = %s AND annotator = %s",
                (self.dataset, key, who),
            )

    def finish(self, who: str, key: str) -> None:
        """Mark a claim done, so it is never handed to anyone else."""
        with self.connect() as conn:
            conn.execute(
                "UPDATE claims SET done = true"
                " WHERE dataset = %s AND clip_key = %s AND annotator = %s",
                (self.dataset, key, who),
            )

    def done_keys(self, who: str) -> set:
        """Clip keys whose claim `who` has finished. Everything they saved but did not
        finish -- `done=false` -- is the in-progress list the page offers to resume."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT clip_key FROM claims"
                " WHERE dataset = %s AND annotator = %s AND done = true",
                (self.dataset, who),
            ).fetchall()
        return {r[0] for r in rows}

    def unfinish(self, who: str, key: str) -> None:
        """Pull a claim back into progress, so the clip is offered again for finishing."""
        with self.connect() as conn:
            conn.execute(
                "UPDATE claims SET done = false"
                " WHERE dataset = %s AND clip_key = %s AND annotator = %s",
                (self.dataset, key, who),
            )

    def binding(self, sub: str) -> str | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT name FROM identities WHERE sub = %s", (sub,)
            ).fetchone()
        return row[0] if row else None

    def bind(self, sub: str, name: str, email: str, display: str) -> str | None:
        """Tie a Google account to an annotator name. Returns the bound name, or None when
        the name already belongs to somebody else.

        The existing marks are filed under short names chosen before there was any sign-in,
        so the first login has to be able to claim one -- otherwise turning auth on orphans
        everybody's work.
        """
        with self.connect() as conn:
            held = conn.execute(
                "SELECT sub FROM identities WHERE name = %s", (name,)
            ).fetchone()
            if held and held[0] != sub:
                return None
            conn.execute(
                # approved_at is deliberately absent from the UPDATE: signing in again
                # must neither grant approval nor take it away.
                "INSERT INTO identities (sub, name, email, display) VALUES (%s,%s,%s,%s)"
                " ON CONFLICT (sub) DO UPDATE SET name = EXCLUDED.name,"
                "   email = EXCLUDED.email, display = EXCLUDED.display",
                (sub, name, email, display),
            )
        return name

    def migrate(self) -> None:
        """Bring marks/claims up to the current, dataset-scoped schema.

        Runs only after a user confirms on the page; both tables are left untouched until
        then. Two independent gaps can be pending, and either or both are fixed here:

          - marks is still the ancient one-blob-per-annotator shape (no clip_key column).
            Split into one row per clip, same as before, `clip_key` rebuilt exactly as it
            was computed when that record was saved (id, or path/start under the legacy
            per-source dataset).
          - marks and/or claims exist but have no `dataset` column yet, from before a
            database could ever hold more than one dataset's rows. Every row from that
            era was written against whichever dataset this process is currently
            configured for -- the only dataset any of them could have belonged to at the
            time -- so that is what backfills the new column.
        """
        with self.connect() as conn:
            marks_columns = {
                r[0]
                for r in conn.execute(
                    "SELECT column_name FROM information_schema.columns"
                    " WHERE table_name = 'marks'"
                ).fetchall()
            }
            if "clip_key" not in marks_columns:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS marks_new ("
                    "  dataset    TEXT NOT NULL,"
                    "  annotator  TEXT NOT NULL,"
                    "  clip_key   TEXT NOT NULL,"
                    "  payload    JSONB NOT NULL,"
                    "  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),"
                    "  PRIMARY KEY (dataset, annotator, clip_key))"
                )
                old = conn.execute(
                    "SELECT annotator, payload, updated_at FROM marks ORDER BY annotator"
                ).fetchall()
                for annotator, payload, updated_at in old:
                    rows = payload if isinstance(payload, list) else [payload]
                    for row in rows:
                        if "id" in row:
                            key = row["id"]
                        else:
                            name = str(row["path"]).replace("\\", "/").rsplit("/", 1)[-1]
                            key = f"{name}@{round(float(row['start']), 3)}"
                        conn.execute(
                            "INSERT INTO marks_new (dataset, annotator, clip_key, payload, updated_at)"
                            " VALUES (%s, %s, %s, %s, %s)",
                            (
                                self.dataset,
                                annotator,
                                key,
                                json.dumps(row, ensure_ascii=False),
                                updated_at,
                            ),
                        )
                conn.execute("DROP TABLE marks")
                conn.execute("ALTER TABLE marks_new RENAME TO marks")
            elif "dataset" not in marks_columns:
                conn.execute("ALTER TABLE marks ADD COLUMN dataset TEXT")
                conn.execute("UPDATE marks SET dataset = %s", (self.dataset,))
                conn.execute("ALTER TABLE marks ALTER COLUMN dataset SET NOT NULL")
                conn.execute("ALTER TABLE marks DROP CONSTRAINT marks_pkey")
                conn.execute("ALTER TABLE marks ADD PRIMARY KEY (dataset, annotator, clip_key)")

            claims_columns = {
                r[0]
                for r in conn.execute(
                    "SELECT column_name FROM information_schema.columns"
                    " WHERE table_name = 'claims'"
                ).fetchall()
            }
            if claims_columns and "dataset" not in claims_columns:
                conn.execute("ALTER TABLE claims ADD COLUMN dataset TEXT")
                conn.execute("UPDATE claims SET dataset = %s", (self.dataset,))
                conn.execute("ALTER TABLE claims ALTER COLUMN dataset SET NOT NULL")
                conn.execute("ALTER TABLE claims DROP CONSTRAINT claims_pkey")
                conn.execute("ALTER TABLE claims ADD PRIMARY KEY (dataset, clip_key)")
        self.pending_migration = False

    def everything(self) -> list[tuple[str, list]]:
        """Every annotator's marks for this dataset, for export."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT annotator, jsonb_agg(payload ORDER BY clip_key)"
                "  FROM marks WHERE dataset = %s GROUP BY annotator",
                (self.dataset,),
            ).fetchall()
        return [(r[0], r[1]) for r in rows]

    def saved_by_clip(self) -> dict[str, list[str]]:
        """clip_key -> list of annotators who saved marks for this dataset."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT clip_key, annotator FROM marks WHERE dataset = %s",
                (self.dataset,),
            ).fetchall()
        out: dict[str, list[str]] = {}
        for clip_key, annotator in rows:
            out.setdefault(clip_key, []).append(annotator)
        return out

    def clip_marks(self, key: str) -> dict[str, list]:
        """annotator -> words list for a specific clip key."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT annotator, payload FROM marks WHERE dataset = %s AND clip_key = %s",
                (self.dataset, key),
            ).fetchall()
        out: dict[str, list] = {}
        for annotator, payload in rows:
            if isinstance(payload, dict) and "words" in payload:
                out[annotator] = payload["words"]
            elif isinstance(payload, str):
                try:
                    p = json.loads(payload)
                    out[annotator] = p.get("words", [])
                except Exception:
                    pass
        return out

    def progress(self) -> list[dict]:
        """Who has marked what in this dataset. With the tool open to more than one
        person there is otherwise no way to see that anyone has been working, or who."""
        with self.connect() as conn:
            marks = conn.execute(
                "SELECT annotator, count(*),"
                "       EXTRACT(EPOCH FROM max(updated_at))"
                "  FROM marks WHERE dataset = %s GROUP BY annotator",
                (self.dataset,),
            ).fetchall()
            held = conn.execute(
                "SELECT annotator, count(*) FROM claims"
                " WHERE dataset = %s AND done = false GROUP BY annotator",
                (self.dataset,),
            ).fetchall()
        holding = {r[0]: int(r[1]) for r in held}
        rows = [
            {
                "name": r[0],
                "marked": int(r[1]),
                "holding": holding.get(r[0], 0),
                "last": float(r[2]),
            }
            for r in marks
        ]
        for name, count in holding.items():
            if not any(r["name"] == name for r in rows):
                rows.append({"name": name, "marked": 0, "holding": count, "last": None})
        return sorted(rows, key=lambda r: r["last"] or 0, reverse=True)

    def save(self, who: str, clips: list[dict], saved: dict[int, list]) -> None:
        """Upsert one row per saved clip, so a save touches only what changed."""
        with self.connect() as conn:
            for index in sorted(saved):
                conn.execute(
                    "INSERT INTO marks (dataset, annotator, clip_key, payload, updated_at)"
                    " VALUES (%s, %s, %s, %s, now())"
                    " ON CONFLICT (dataset, annotator, clip_key) DO UPDATE"
                    "   SET payload = EXCLUDED.payload, updated_at = now()",
                    (
                        self.dataset,
                        who,
                        clip_key(clips[index]),
                        json.dumps(
                            gold_row(clips[index], saved[index]), ensure_ascii=False
                        ),
                    ),
                )


class FileClaims:
    """The same claim bookkeeping as PostgresStore, in a json file next to the marks.

    Only used when there is no database, i.e. running locally. One process, so the module
    LOCK is all the mutual exclusion needed.
    """

    def __init__(self, directory: Path):
        self.path = directory / "_claims.json"

    def read(self) -> dict:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}

    def claims(self) -> dict[str, tuple[str, float, float | None, bool]]:
        """clip_key -> (annotator, claimed_at, touched_at, done). `touched_at` is None
        for a claim nobody has ever saved to."""
        return {
            k: (v["annotator"], v["claimed_at"], v.get("touched_at"), v.get("done", False))
            for k, v in self.read().items()
        }

    def claim(self, who: str, keys: list[str]) -> set[str]:
        """Take these clips for `who`. Returns the keys actually taken -- see
        PostgresStore.claim for why the caller must not assume the rest."""
        if not keys:
            return set()
        now = time.time()
        rows = self.read()
        taken = set()
        for key in keys:
            held = rows.get(key)
            if held and held["annotator"] != who:
                if held.get("done"):
                    continue
                touched_at = held.get("touched_at")
                cutoff = (
                    touched_at + TOUCHED_STALE_SECONDS
                    if touched_at is not None
                    else held["claimed_at"] + NEVER_TOUCHED_STALE_SECONDS
                )
                if now < cutoff:
                    continue
            rows[key] = {
                "annotator": who,
                "claimed_at": now,
                "touched_at": None,
                "done": False,
            }
            taken.add(key)
        if taken:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        return taken

    def touch(self, who: str, key: str) -> None:
        """Record that `who` actually saved this clip just now, resetting the 36h grace
        clock (see PostgresStore.touch)."""
        rows = self.read()
        if key in rows and rows[key]["annotator"] == who:
            rows[key]["touched_at"] = time.time()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    def finish(self, who: str, key: str) -> None:
        rows = self.read()
        if key in rows and rows[key]["annotator"] == who:
            rows[key]["done"] = True
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    def done_keys(self, who: str) -> set:
        rows = self.read()
        return {
            k
            for k, v in rows.items()
            if v.get("annotator") == who and v.get("done")
        }

    def unfinish(self, who: str, key: str) -> None:
        rows = self.read()
        if key in rows and rows[key]["annotator"] == who:
            rows[key]["done"] = False
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")


def clip_key(clip: dict) -> str:
    """Stable id for a clip: the dataset's own id, generated once at conversion time.

    Simpler than it used to be -- the legacy manifests carried no id of their own, so a key
    was built from the clip's file name and offset. A dataset row has an id already.
    """
    return clip["id"]


def is_clip_claimable(
    owner_info: tuple[str, float, float | None, bool] | None, now: float
) -> bool:
    """A clip is claimable if it was never claimed, or if unfinished and its claim expired."""
    if owner_info is None:
        return True
    owner_who, claimed_at, touched_at, done = owner_info
    if done:
        return False
    cutoff = (
        touched_at + TOUCHED_STALE_SECONDS
        if touched_at is not None
        else claimed_at + NEVER_TOUCHED_STALE_SECONDS
    )
    return now > cutoff


def get_saved_annotators_by_clip(
    store: PostgresStore | None, out_dir: Path, dataset_name: str
) -> dict[str, list[str]]:
    """Returns clip_key -> [annotator1, annotator2, ...] for all saved marks in this dataset."""
    by_clip: dict[str, list[str]] = {}
    if store is not None:
        return store.saved_by_clip()
    if out_dir.exists():
        for f in sorted(out_dir.glob("*.jsonl")):
            if f.name.startswith("_"):
                continue
            annotator = f.stem
            for line in f.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    if "id" in row:
                        by_clip.setdefault(row["id"], []).append(annotator)
                except json.JSONDecodeError:
                    continue
    return by_clip


def get_clip_annotator_marks(
    store: PostgresStore | None, out_dir: Path, dataset_name: str, key: str
) -> dict[str, list]:
    """Returns {annotator: words} for a specific clip key."""
    if store is not None:
        return store.clip_marks(key)
    out: dict[str, list] = {}
    if out_dir.exists():
        for f in sorted(out_dir.glob("*.jsonl")):
            if f.name.startswith("_"):
                continue
            annotator = f.stem
            for line in f.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    if row.get("id") == key and "words" in row:
                        out[annotator] = row["words"]
                except json.JSONDecodeError:
                    continue
    return out


def assign(claimer, who: str, clips: list[dict], marked: set[int]) -> set[int]:
    """Indices this annotator owns, topping their block up from the unclaimed pool.

    Everyone works the same worst-disagreement-first order, so the pool hands out the most
    valuable unclaimed clip next regardless of who asks.
    """
    held = claimer.claims()
    now = time.time()
    # Work you have already marked is yours whatever the claim table says. Claims can be
    # absent for marks that arrived another way -- imported from a local session, say --
    # and dropping them from your list would look like the work had been lost.
    mine, free = set(marked), []
    for index, clip in enumerate(clips):
        key = clip_key(clip)
        owner = held.get(key)
        if index in marked:
            continue  # already yours; never offer it as fresh work
        if owner is None:
            free.append((index, key))
            continue
        owner_who, claimed_at, touched_at, done = owner
        if owner_who == who:
            mine.add(index)  # yours regardless of age -- you do not steal from yourself
            continue
        if done:
            continue  # someone finished this; it is never handed to anyone else, at any age
        # Untouched work is dead weight fast; work someone actually saved to gets a much
        # longer grace period before it is offered up as free again.
        cutoff = (
            touched_at + TOUCHED_STALE_SECONDS
            if touched_at is not None
            else claimed_at + NEVER_TOUCHED_STALE_SECONDS
        )
        if now > cutoff:
            free.append((index, key))
    outstanding = len(mine - marked)
    if outstanding < BLOCK and free:
        take = free[: BLOCK - outstanding]
        # claim() tells us what it actually granted -- a key it refused (because the SQL/
        # file guard saw it was no longer stale, or done, by the time we got there) must
        # not be added to `mine`, or this session would believe it owns a clip whose real
        # claim row still belongs to someone else. That mismatch was the original bug.
        taken = claimer.claim(who, [key for _, key in take])
        mine.update(index for index, key in take if key in taken)
    return mine


def gold_row(clip: dict, words: list) -> dict:
    """One output record: the clip's id plus the human words, so a gold file can be scored
    against any dataset export with no path/offset guessing."""
    return {
        "id": clip["id"],
        "text": clip["text"],
        "duration": clip["duration"],
        "words": [
            {
                "word": w["word"],
                "start": round(float(w["start"]), 4),
                "end": round(float(w["end"]), 4),
                # Present only where the annotator corrected the ASR text. Downstream has to
                # be able to separate a corrected clip from one that was right already.
                **({"was": w["was"]} if w.get("was") is not None else {}),
                # A word the transcript never had. A word it had and should not have is
                # simply absent -- the clip keeps its original `text`, so a deletion
                # stays recoverable without a flag of its own.
                **({"added": True} if w.get("added") else {}),
            }
            for w in words
        ],
    }


def index_rows(rows: list[dict], clips: list[dict]) -> dict[int, list]:
    """Saved records -> {clip index: words}, matched on id."""
    by_key = {r["id"]: r["words"] for r in rows if "id" in r}
    out = {}
    for index, clip in enumerate(clips):
        hit = by_key.get(clip["id"])
        if hit:
            out[index] = hit
    return out


def gold_path(args, who: str | None) -> Path:
    """One file per annotator: nobody overwrites anyone."""
    args.out.mkdir(parents=True, exist_ok=True)
    return args.out / f"{who or 'anon'}.jsonl"


def load_saved(path: Path, clips: list[dict]) -> dict[int, list]:
    if not path.exists():
        return {}
    by_key = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "id" in row:
            by_key[row["id"]] = row["words"]
    out = {}
    for index, clip in enumerate(clips):
        hit = by_key.get(clip["id"])
        if hit:
            out[index] = hit
    return out


EVAL_SCHEMA = "efa-result/"
EVAL_PREFIX = "eval-results/"
EVAL_MAX_BYTES = 64 * 1024 * 1024
_EVAL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")


class EvalResults:
    """Scored results uploaded from eval-forced-alignment, which this site only displays.

    Kept in the bucket, because a deploy restarts the container and its disk with it; a
    folder when there is no bucket, which is the local case. An index object lists what is
    stored, so the picker does not have to fetch every result -- each carries the whole gold
    set and is a few megabytes.
    """

    def __init__(self, bucket: str | None, folder: Path):
        self.bucket = bucket
        self.folder = folder
        self.lock = threading.Lock()

    def where(self) -> str:
        return f"s3://{self.bucket}/{EVAL_PREFIX}" if self.bucket else str(self.folder)

    def _get(self, name: str) -> bytes | None:
        if self.bucket:
            try:
                return s3_client().get_object(Bucket=self.bucket, Key=EVAL_PREFIX + name)["Body"].read()
            except Exception as exc:  # noqa: BLE001
                if "NoSuchKey" in type(exc).__name__ or "NoSuchKey" in str(exc) or "404" in str(exc):
                    return None
                raise
        f = self.folder / name
        return f.read_bytes() if f.exists() else None

    def _put(self, name: str, body: bytes) -> None:
        if self.bucket:
            s3_client().put_object(Bucket=self.bucket, Key=EVAL_PREFIX + name, Body=body,
                                   ContentType="application/json")
        else:
            self.folder.mkdir(parents=True, exist_ok=True)
            (self.folder / name).write_bytes(body)

    def _drop(self, name: str) -> None:
        if self.bucket:
            s3_client().delete_object(Bucket=self.bucket, Key=EVAL_PREFIX + name)
        else:
            (self.folder / name).unlink(missing_ok=True)

    def index(self) -> list[dict]:
        raw = self._get("index.json")
        return json.loads(raw) if raw else []

    def get(self, rid: str) -> bytes | None:
        return self._get(f"{rid}.json") if _EVAL_ID.match(rid) else None

    def add(self, result: dict, body: bytes, uploader: str | None) -> dict:
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        rid = f"{stamp}-{hashlib.sha256(body).hexdigest()[:8]}"
        aligners = result.get("aligners") or {}
        entry = {
            "id": rid,
            "title": str(result.get("title") or rid)[:200],
            "created_at": result.get("created_at"),
            "uploaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "uploaded_by": uploader,
            "input": result.get("input"),
            "clips": result.get("marked_clips"),
            "aligners": sorted(aligners),
            "bytes": len(body),
        }
        self._put(f"{rid}.json", body)
        with self.lock:
            idx = [e for e in self.index() if e.get("id") != rid]
            idx.insert(0, entry)
            self._put("index.json", json.dumps(idx, ensure_ascii=False).encode("utf-8"))
        return entry

    def delete(self, rid: str) -> bool:
        if not _EVAL_ID.match(rid):
            return False
        with self.lock:
            idx = self.index()
            kept = [e for e in idx if e.get("id") != rid]
            if len(kept) == len(idx):
                return False
            self._put("index.json", json.dumps(kept, ensure_ascii=False).encode("utf-8"))
        self._drop(f"{rid}.json")
        return True


def check_result(result) -> str | None:
    """Why this upload is not a result the viewer can show, or None."""
    if not isinstance(result, dict):
        return "not a JSON object"
    if not str(result.get("schema", "")).startswith(EVAL_SCHEMA):
        return (f"schema is {result.get('schema')!r}, expected {EVAL_SCHEMA}N -- upload the "
                "result.json eval-forced-alignment writes")
    if not isinstance(result.get("aligners"), dict):
        return "no aligners in it"
    return None


def make_handler(args, dataset: Dataset, clips):
    by_key = {clip_key(c): c for c in clips}
    for c in clips:
        by_key[c["id"]] = c

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # noqa: A003 -- quiet; progress is in the page
            pass

        def send(self, code, body, ctype, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def signed_in(self):
            """The signed-in account, when auth is on -- a verified Google account under
            --auth, or a self-declared local one under --local-auth."""
            if args.auth == "local":
                return local_identity(self.headers.get("Cookie", ""))
            if not args.auth:
                return None
            host = self.headers.get("Host", "").split(":")[0]
            return identity(self.headers.get("Cookie", ""), host)

        def who(self):
            """The annotator whose marks this request touches.

            With auth on this comes from the verified cookie, so `?who=` is ignored -- it is
            what let anyone write as anyone.
            """
            if args.auth:
                person = self.signed_in()
                if not person or STORE is None:
                    return None
                return STORE.binding(person["sub"])
            from urllib.parse import parse_qs

            name = (parse_qs(urlparse(self.path).query).get("who") or [""])[0]
            return name if _NAME.match(name) else None

        def standing(self):
            """(may this person save, may they approve others).

            Without --auth there is nobody to gate, so everything is allowed; that is the
            local single-user case and adding a gate to it would only be in the way.
            """
            if not args.auth or STORE is None:
                return True, False
            # No approver configured means no one could ever let anybody in, so the gate
            # stays open rather than stranding the next person who signs in. Setting
            # TAG_ADMINS is what turns it on; leaving it unset keeps today's behaviour.
            if not admins():
                return True, False
            person = self.signed_in()
            if not person:
                return False, False
            email = (person.get("email") or "").lower()
            # An approver is approved by definition. Without this, the first person named in
            # TAG_ADMINS would sign in, land in the queue, and have nobody able to let them
            # out of it.
            admin = email in admins()
            return (admin or STORE.is_approved(person["sub"])), admin

        def authorised(self):
            from urllib.parse import parse_qs

            if not args.token:
                return True
            return (parse_qs(urlparse(self.path).query).get("t") or [""])[
                0
            ] == args.token

        def do_GET(self):
            route = urlparse(self.path).path
            # The page itself is served without a token: a managed host probes GET / for a
            # 2xx to decide the app is alive, and a 403 there reads as a dead app. Nothing
            # is exposed by this -- the HTML carries no clips and no marks, and every /api
            # route below still demands the token.
            if route == "/":
                # Never let a browser keep an old copy. The page and the API are deployed
                # together, so a cached page talking to a new API misreads it -- a stale
                # page took the new "computing" reply for a result and reported "no marked
                # clips" while 76 sat in the database.
                return self.send(
                    200,
                    page(),
                    "text/html; charset=utf-8",
                    {"Cache-Control": "no-store, must-revalidate"},
                )
            # Stands in for the redirect to xhostd's hosted login page, so it is reachable
            # the same way -- before the token gate, since a signed-out browser has no
            # token yet either.
            if route == "/local-auth/login" and args.auth == "local":
                return self.send(200, local_login_page(), "text/html; charset=utf-8")
            if route == "/local-auth/logout" and args.auth == "local":
                token = ""
                for part in self.headers.get("Cookie", "").split(";"):
                    name, _, value = part.strip().partition("=")
                    if name == LOCAL_COOKIE:
                        token = value
                _LOCAL_SESSIONS.pop(token, None)
                return self.send(
                    302,
                    b"",
                    "text/plain",
                    {
                        "Location": "/",
                        "Set-Cookie": f"{LOCAL_COOKIE}=; Path=/; Max-Age=0",
                    },
                )
            if not self.authorised():
                return self.send(403, b"bad or missing token", "text/plain")
            if route == "/api/me":
                person = self.signed_in()
                local = args.auth == "local"
                body = {
                    "auth": bool(args.auth),
                    "local_auth": local,
                    "logged_in": bool(person),
                    "migrate": bool(STORE is not None and STORE.pending_migration),
                    "login_url": (
                        "/local-auth/login" if local else "/xhost-auth/login?return_to=/"
                    ),
                    "logout_url": (
                        "/local-auth/logout" if local else "/xhost-auth/logout?return_to=/"
                    ),
                }
                if person:
                    approved, admin = self.standing()
                    body.update(
                        {
                            "display": person["display"],
                            "email": person["email"],
                            "name": STORE.binding(person["sub"]) if STORE else None,
                            "approved": approved,
                            "admin": admin,
                            "waiting": len(STORE.waiting()) if (admin and STORE) else 0,
                        }
                    )
                return self.send(
                    200,
                    json.dumps(body, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            if STORE is not None and STORE.pending_migration:
                # The old marks schema is not writable. Nothing is lost by refusing:
                # the page shows the migration gate, and until a user confirms there is
                # no safe way to write a fix without overwriting another annotator's blob.
                return self.send(
                    503, b'{"error":"database migration required"}', "application/json"
                )
            if args.auth and route.startswith("/api/") and route != "/api/progress":
                if not self.signed_in():
                    return self.send(401, b'{"error":"sign in"}', "application/json")
                if not self.who():
                    return self.send(
                        409, b'{"error":"pick a name"}', "application/json"
                    )
            if route == "/api/meta":
                aligner_ok = bool(
                    os.environ.get("ENDPOINT_ID")
                    and (os.environ.get("RP_API_KEY") or os.environ.get("RUNPOD_API_KEY"))
                )
                meta = {
                    "multi": True,
                    "clips": len(clips),
                    "dataset": dataset.name,
                    "aligner": aligner_ok,
                }
                return self.send(
                    200, json.dumps(meta).encode("utf-8"), "application/json"
                )
            if route == "/api/align":
                try:
                    aligner_config()
                    return self.send(200, b'{"ok":true}', "application/json")
                except AlignerError as exc:
                    return self.send(
                        400,
                        json.dumps({"error": str(exc), "message": str(exc)}).encode("utf-8"),
                        "application/json",
                    )
            if route == "/api/eval-results":
                try:
                    listing = RESULTS.index()
                except Exception as exc:  # noqa: BLE001
                    return self.send(502, json.dumps({"error": f"{type(exc).__name__}: {exc}"}).encode("utf-8"),
                                     "application/json")
                _, admin = self.standing()
                return self.send(
                    200,
                    json.dumps({"results": listing, "can_upload": admin or not args.auth or not admins()},
                               ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            if route.startswith("/api/eval-results/"):
                body = RESULTS.get(route.rsplit("/", 1)[1])
                if body is None:
                    return self.send(404, b'{"error":"no such result"}', "application/json")
                return self.send(200, body, "application/json; charset=utf-8",
                                 {"Cache-Control": "private, max-age=3600"})
            if route == "/api/export":
                # The marks live in Postgres once hosted, but the rest of the pipeline reads
                # jsonl keyed on clip id. So export in exactly that shape, with the
                # annotator added, and nothing else: a file that needs converting before it
                # can be scored is a file that will be scored wrong.
                lines = []
                if STORE is not None:
                    for name, payload in STORE.everything():
                        for row in payload:
                            lines.append(
                                json.dumps(
                                    {**row, "annotator": name}, ensure_ascii=False
                                )
                            )
                else:
                    directory = args.out
                    for f in sorted(directory.glob("*.jsonl")):
                        for line in f.read_text(encoding="utf-8").splitlines():
                            if line.strip():
                                lines.append(
                                    json.dumps(
                                        {**json.loads(line), "annotator": f.stem},
                                        ensure_ascii=False,
                                    )
                                )
                blob = ("\n".join(lines) + "\n").encode("utf-8")
                return self.send(
                    200,
                    blob,
                    "application/x-ndjson; charset=utf-8",
                    {"Content-Disposition": 'attachment; filename="gold.jsonl"'},
                )
            if route == "/api/progress":
                if STORE is not None:
                    rows = STORE.progress()
                else:
                    rows = []
                    directory = args.out
                    for f in sorted(directory.glob("*.jsonl")):
                        lines = [
                            ln
                            for ln in f.read_text(encoding="utf-8").splitlines()
                            if ln.strip()
                        ]
                        rows.append(
                            {
                                "name": f.stem,
                                "marked": len(lines),
                                "holding": 0,
                                "last": f.stat().st_mtime,
                            }
                        )
                body = {
                    "clips": len(clips),
                    # The page compares this with its own stamp and reloads past its cache
                    # if it is running an older copy.
                    "build": page_build(),
                    "annotators": rows,
                    "marked_total": sum(r["marked"] for r in rows),
                    # What the scorer is actually working with. Without this, a dashboard
                    # reporting "no marked clips" while marks plainly exist can only be
                    # guessed at from outside, since every other route needs a sign-in.
                    "labels": sorted({lb["source"] for c in clips for lb in c.get("labels", [])}),
                    "eval_results": RESULTS.where(),
                }
                # Where the audio is actually coming from. Without this there is no way to
                # tell from outside which dataset source is live.
                if isinstance(dataset, BucketDataset):
                    body["audio"] = {
                        "source": "bucket",
                        "bucket": dataset.bucket,
                        "dataset": dataset.name,
                    }
                else:
                    body["audio"] = {"source": "folder", "dataset": dataset.name}
                return self.send(
                    200,
                    json.dumps(body, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            if route == "/api/waiting":
                approved, admin = self.standing()
                if not admin:
                    return self.send(403, b'{"error":"not an approver"}', "application/json")
                return self.send(
                    200,
                    json.dumps(STORE.waiting() if STORE else [], ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            if route == "/api/clips":
                who = self.who() or "anon"
                if STORE is not None:
                    mine = STORE.load(who, clips)
                else:
                    mine = load_saved(gold_path(args, self.who()), clips)
                # Split is always on: each annotator is handed their own clips, so two
                # people never mark the same sentence.
                with LOCK:
                    owned = assign(CLAIMS, who, clips, set(mine))
                done = CLAIMS.done_keys(who)
                payload = []
                for index, clip in enumerate(clips):
                    if index not in owned:
                        continue
                    payload.append(
                        {
                            "id": clip["id"],
                            "key": clip["id"],
                            "metadata": clip["metadata"],
                            "text": clip["text"],
                            "duration": clip["duration"],
                            "words": clip["a"],
                            "labels": clip["labels"],
                            "saved": mine.get(index),
                            "done": clip["id"] in done,
                        }
                    )
                return self.send(
                    200,
                    json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            if route == "/api/overview":
                who = self.who() or "anon"
                held = CLAIMS.claims() if CLAIMS is not None else {}
                saved_by_clip = get_saved_annotators_by_clip(STORE, args.out, dataset.name)
                now = time.time()

                annotators_set = set()
                overall_duration = 0.0
                saved_duration = 0.0
                done_duration = 0.0
                saved_count = 0
                done_count = 0

                clip_summaries = []
                for clip in clips:
                    ckey = clip_key(clip)
                    owner_info = held.get(ckey)
                    owner_who = owner_info[0] if owner_info else None
                    done = bool(owner_info[3]) if owner_info else False
                    saved_users = saved_by_clip.get(ckey, [])
                    saved = done or bool(saved_users)

                    if owner_who:
                        annotators_set.add(owner_who)
                    for u in saved_users:
                        annotators_set.add(u)

                    dur = float(clip["duration"])
                    overall_duration += dur
                    if saved:
                        saved_count += 1
                        saved_duration += dur
                    if done:
                        done_count += 1
                        done_duration += dur

                    claimable = is_clip_claimable(owner_info, now)
                    claimed_by_me = (owner_who == who)

                    clip_summaries.append(
                        {
                            "id": clip["id"],
                            "text": clip["text"],
                            "duration": round(dur, 2),
                            "claimant": owner_who,
                            "done": done,
                            "saved": saved,
                            "saved_by": saved_users,
                            "claimable": claimable,
                            "claimed_by_me": claimed_by_me,
                        }
                    )

                body = {
                    "dataset": dataset.name,
                    "stats": {
                        "overall_clips": len(clips),
                        "saved_clips": saved_count,
                        "done_clips": done_count,
                        "overall_minutes": round(overall_duration / 60.0, 1),
                        "saved_minutes": round(saved_duration / 60.0, 1),
                        "done_minutes": round(done_duration / 60.0, 1),
                    },
                    "annotators": sorted(annotators_set),
                    "clips": clip_summaries,
                }
                return self.send(
                    200,
                    json.dumps(body, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            if route == "/api/clip-marks":
                who = self.who() or "anon"
                from urllib.parse import parse_qs

                key = (parse_qs(urlparse(self.path).query).get("key") or [""])[0]
                clip = by_key.get(key)
                if clip is None:
                    try:
                        clip = clips[int(key)]
                    except (ValueError, IndexError):
                        return self.send(
                            404, b'{"error":"clip not found"}', "application/json"
                        )
                key = clip_key(clip)
                held = CLAIMS.claims() if CLAIMS is not None else {}
                owner_info = held.get(key)
                owner_who = owner_info[0] if owner_info else None
                done = bool(owner_info[3]) if owner_info else False
                now = time.time()
                claimable = is_clip_claimable(owner_info, now)
                marks_by_annotator = get_clip_annotator_marks(
                    STORE, args.out, dataset.name, key
                )
                body = {
                    "id": clip["id"],
                    "key": clip["id"],
                    "text": clip["text"],
                    "duration": clip["duration"],
                    "words": clip["a"],
                    "labels": clip["labels"],
                    "marks": marks_by_annotator,
                    "claim": {
                        "claimant": owner_who,
                        "done": done,
                        "claimable": claimable,
                        "claimed_by_me": (owner_who == who),
                    },
                }
                return self.send(
                    200,
                    json.dumps(body, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            if route == "/api/align-status":
                who = self.who() or "anon"
                from urllib.parse import parse_qs

                job_id = (parse_qs(urlparse(self.path).query).get("job") or [""])[0]
                job = ALIGN_JOBS.get(job_id)
                if job is None or job.who != who:
                    return self.send(
                        404, b'{"error":"unknown align job"}', "application/json"
                    )
                with job.lock:
                    body = {
                        "status": job.status,
                        "words": job.words,
                        "error": job.error,
                    }
                return self.send(
                    200,
                    json.dumps(body, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            if route.startswith("/api/audio/"):
                target = unquote(route[len("/api/audio/") :])
                clip = by_key.get(target)
                if clip is None:
                    try:
                        clip = clips[int(target)]
                    except (ValueError, IndexError):
                        return self.send(404, b"clip not found", "text/plain")
                try:
                    data, lead = clip_wav(clip, dataset)
                except Exception as exc:  # noqa: BLE001 -- a bad clip must not kill the server
                    return self.send(500, str(exc).encode(), "text/plain")
                headers = {"X-Lead": f"{lead:.4f}", "Accept-Ranges": "bytes"}
                # An <audio> element cannot seek without byte ranges: setting currentTime on
                # a response served as a plain 200 is silently ignored and playback stays
                # wherever it was. Every "play this word" then started from the top.
                span = self.headers.get("Range")
                if span and span.startswith("bytes="):
                    first, _, last = span[6:].partition("-")
                    begin = int(first) if first else 0
                    end = int(last) if last else len(data) - 1
                    end = min(end, len(data) - 1)
                    if begin > end:
                        return self.send(416, b"", "audio/wav", headers)
                    chunk = data[begin : end + 1]
                    headers["Content-Range"] = f"bytes {begin}-{end}/{len(data)}"
                    return self.send(206, chunk, "audio/wav", headers)
                return self.send(200, data, "audio/wav", headers)
            return self.send(404, b"not found", "text/plain")

        def do_POST(self):
            route = urlparse(self.path).path
            # Ahead of the token check for the same reason as its GET counterpart: this is
            # the sign-in form itself, posted from a browser that has no token yet.
            if route == "/local-auth/login" and args.auth == "local":
                length = int(self.headers.get("Content-Length", 0))
                form = self.rfile.read(length).decode("utf-8", "replace")
                from urllib.parse import parse_qs

                email = (parse_qs(form).get("email") or [""])[0].strip().lower()
                if not _EMAIL.match(email):
                    return self.send(
                        400, local_login_page(error=True), "text/html; charset=utf-8"
                    )
                sub = local_sub(email)
                token = uuid.uuid4().hex
                _LOCAL_SESSIONS[token] = {"sub": sub, "email": email, "display": email}
                return self.send(
                    302,
                    b"",
                    "text/plain",
                    {
                        "Location": "/",
                        # Not __Host- like the real cookie: this server may be plain http
                        # locally, and __Host- requires Secure.
                        "Set-Cookie": f"{LOCAL_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax",
                    },
                )
            if not self.authorised():
                return self.send(403, b"bad or missing token", "text/plain")
            # Picking a name is how somebody joins the queue, so it stays open; everything
            # that writes a mark or takes a clip does not. Reading is untouched -- a person
            # waiting can still open the tool and see what the work looks like.
            WRITES = ("/api/gold", "/api/claim", "/api/unmark", "/api/align",
                      "/api/align-cancel")
            if route in WRITES:
                approved, _ = self.standing()
                if not approved:
                    return self.send(
                        403,
                        b'{"error":"waiting for approval"}',
                        "application/json",
                    )
            if route == "/api/claim-name":
                person = self.signed_in()
                if not person or STORE is None:
                    return self.send(401, b'{"error":"sign in"}', "application/json")
                length = int(self.headers.get("Content-Length", 0))
                wanted = json.loads(self.rfile.read(length).decode("utf-8")).get(
                    "name", ""
                )
                if not _NAME.match(wanted):
                    return self.send(400, b'{"error":"bad name"}', "application/json")
                bound = STORE.bind(
                    person["sub"], wanted, person["email"], person["display"]
                )
                if bound is None:
                    return self.send(409, b'{"error":"taken"}', "application/json")
                return self.send(
                    200, json.dumps({"name": bound}).encode("utf-8"), "application/json"
                )
            if route in ("/api/eval-results", "/api/eval-results/delete"):
                # Only approvers publish results: everyone who can sign in can read them, and
                # a result is the thing people quote.
                _, admin = self.standing()
                if args.auth and admins() and not admin:
                    return self.send(403, b'{"error":"only approvers can upload results"}',
                                     "application/json")
                length = int(self.headers.get("Content-Length", 0))
                if length > EVAL_MAX_BYTES:
                    return self.send(413, b'{"error":"result too large"}', "application/json")
                raw = self.rfile.read(length)
                try:
                    body = json.loads(raw.decode("utf-8"))
                except ValueError as exc:
                    return self.send(400, json.dumps({"error": f"not JSON: {exc}"}).encode("utf-8"),
                                     "application/json")
                try:
                    if route.endswith("/delete"):
                        if not RESULTS.delete(str(body.get("id", ""))):
                            return self.send(404, b'{"error":"no such result"}', "application/json")
                        return self.send(200, b'{"ok":true}', "application/json")
                    why = check_result(body)
                    if why:
                        return self.send(400, json.dumps({"error": why}).encode("utf-8"),
                                         "application/json")
                    person = self.signed_in() or {}
                    entry = RESULTS.add(body, raw, person.get("email") or self.who())
                except Exception as exc:  # noqa: BLE001 -- a bucket error is shown, not swallowed
                    return self.send(502, json.dumps({"error": f"{type(exc).__name__}: {exc}"}).encode("utf-8"),
                                     "application/json")
                return self.send(200, json.dumps(entry, ensure_ascii=False).encode("utf-8"),
                                 "application/json; charset=utf-8")
            if route == "/api/approve":
                approved, admin = self.standing()
                if not admin:
                    return self.send(403, b'{"error":"not an approver"}', "application/json")
                person = self.signed_in()
                length = int(self.headers.get("Content-Length", 0))
                sub = json.loads(self.rfile.read(length).decode("utf-8")).get("sub", "")
                ok = STORE.approve(sub, person["email"]) if STORE else False
                return self.send(
                    200 if ok else 404,
                    json.dumps({"ok": ok}).encode("utf-8"),
                    "application/json",
                )
            if route == "/api/migrate":
                # Confirmed by any user on the page. Until this runs the whole store is
                # read-only, so there is no window where one blob is half-split.
                if STORE is None or not STORE.pending_migration:
                    return self.send(
                        409, b'{"error":"no migration pending"}', "application/json"
                    )
                try:
                    STORE.migrate()
                except Exception as exc:  # noqa: BLE001 -- surface whatever failed
                    return self.send(
                        500,
                        json.dumps({"error": str(exc)}).encode(),
                        "application/json",
                    )
                return self.send(200, b'{"ok":true}', "application/json")
            if STORE is not None and STORE.pending_migration:
                return self.send(
                    503, b'{"error":"database migration required"}', "application/json"
                )
            if args.auth and not self.who():
                return self.send(401, b'{"error":"sign in"}', "application/json")
            if route == "/api/claim":
                who = self.who() or "anon"
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                key = body.get("key")
                if not key or key not in by_key:
                    return self.send(
                        400, b'{"error":"unknown clip"}', "application/json"
                    )
                with LOCK:
                    taken = CLAIMS.claim(who, [key])
                if key in taken:
                    return self.send(
                        200,
                        json.dumps({"ok": True, "key": key}).encode("utf-8"),
                        "application/json",
                    )
                return self.send(
                    409,
                    json.dumps(
                        {"error": "Clip is not available for claiming"}
                    ).encode("utf-8"),
                    "application/json",
                )
            if route == "/api/unmark":
                # "Unmark as done" pulls the clip's claim back into progress, so it shows
                # up in the to-finish list again. Marks are untouched.
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                who = self.who() or "anon"
                key = body.get("key")
                if not key:
                    return self.send(400, b"unknown clip", "text/plain")
                with LOCK:
                    CLAIMS.unfinish(who, key)
                return self.send(200, b'{"ok":true}', "application/json")
            if route == "/api/align":
                who = self.who() or "anon"
                try:
                    aligner_config()
                except AlignerError as exc:
                    return self.send(
                        400,
                        json.dumps({"error": str(exc), "message": str(exc)}).encode("utf-8"),
                        "application/json",
                    )
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                key = body.get("key")
                clip = by_key.get(key) if key else None
                if clip is None:
                    return self.send(
                        400, b'{"error":"unknown clip"}', "application/json"
                    )
                key = clip_key(clip)
                # Take the list of words (text) from the USER marking, not the baseline.
                # 1. From the request body (explicit words list or text string)
                # 2. Or from the annotator's existing saved marks for this clip
                # 3. Or fall back to clip baseline words
                user_words: list[str] = []
                if "words" in body and isinstance(body["words"], list):
                    user_words = [
                        clean(w["word"] if isinstance(w, dict) else str(w))
                        for w in body["words"]
                        if clean(w["word"] if isinstance(w, dict) else str(w))
                    ]
                elif "text" in body and isinstance(body["text"], str):
                    user_words = [clean(w) for w in body["text"].split(" ") if clean(w)]

                if not user_words:
                    with LOCK:
                        idx_match = [i for i, c in enumerate(clips) if clip_key(c) == key]
                        if idx_match:
                            idx = idx_match[0]
                            saved_marks = (
                                STORE.load(who, clips)
                                if STORE is not None
                                else load_saved(gold_path(args, who), clips)
                            )
                            if idx in saved_marks and saved_marks[idx]:
                                user_words = [
                                    clean(w["word"])
                                    for w in saved_marks[idx]
                                    if clean(w.get("word", ""))
                                ]
                if not user_words:
                    user_words = [clean(w["word"]) for w in clip["a"] if clean(w.get("word", ""))]

                if not user_words:
                    return self.send(
                        400, b'{"error":"clip has no words to align"}', "application/json"
                    )

                with ALIGN_LOCK:
                    prune_align_jobs()
                    # Already aligning this clip for this annotator -- hand back the same
                    # job rather than kicking off a second, duplicate call to the aligner.
                    existing = ALIGN_ACTIVE.get((who, key))
                    if existing is not None:
                        return self.send(
                            200,
                            json.dumps({"job_id": existing}).encode("utf-8"),
                            "application/json",
                        )
                    job_id = uuid.uuid4().hex
                    job = AlignJob(job_id, who, key, user_words)
                    ALIGN_JOBS[job_id] = job
                    ALIGN_ACTIVE[(who, key)] = job_id
                threading.Thread(
                    target=run_align_job,
                    args=(job, dataset, clip, clips, args),
                    daemon=True,
                ).start()
                return self.send(
                    200,
                    json.dumps({"job_id": job_id}).encode("utf-8"),
                    "application/json",
                )
            if route == "/api/align-cancel":
                who = self.who() or "anon"
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                job = ALIGN_JOBS.get(body.get("job_id", ""))
                if job is not None and job.who == who:
                    job.cancel()
                # Idempotent either way: a job that already finished, or one the client
                # never got a job_id for, is just as "cancelled" from the caller's side.
                return self.send(200, b'{"ok":true}', "application/json")
            if route != "/api/gold":
                return self.send(404, b"not found", "text/plain")
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            # The page numbers clips by their position in what it was served, which under
            # split is a subset. Resolve by clip key so a save cannot land on someone
            # else's sentence.
            if body.get("key"):
                match = [i for i, c in enumerate(clips) if clip_key(c) == body["key"]]
                if not match:
                    return self.send(400, b"unknown clip", "text/plain")
                body["index"] = match[0]
            who = self.who() or "anon"
            # Re-read before writing. Two annotators sharing a store would otherwise each
            # hold a stale copy and the second save would drop the first one's work.
            with LOCK:
                index = int(body["index"])
                if STORE is not None:
                    mine = STORE.load(who, clips)
                    mine[index] = body["words"]
                    STORE.save(who, clips, mine)
                else:
                    path = gold_path(args, self.who())
                    mine = load_saved(path, clips)
                    mine[index] = body["words"]
                    write_gold(path, clips, mine)
                if CLAIMS is not None:
                    # Every save -- not just "done & next" -- proves someone is actually
                    # working this clip, so it resets the 36h grace clock rather than the
                    # 12h one. Without this, a clip worked on for hours but not yet
                    # finished would go stale on the same short clock as one nobody ever
                    # opened.
                    CLAIMS.touch(who, clip_key(clips[index]))
                    # "save" alone is a checkpoint for a clip still being worked on; only
                    # "done & next" (or its shortcuts) should retire the claim, so it is
                    # never handed to someone else while the annotator is mid-edit.
                    if body.get("next"):
                        CLAIMS.finish(who, clip_key(clips[index]))
            return self.send(200, b'{"ok":true}', "application/json")

    return Handler


def write_gold(out: Path, clips: list[dict], saved: dict[int, list]) -> None:
    """Rewritten in full after each clip: 100 rows is nothing, and a partial append that
    crashed mid-write would be worse than the rewrite cost.

    Shares gold_row with the Postgres store so the two writers cannot drift -- they had
    separate copies of the record shape, and only one of them learned about corrected text.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as handle:
        for index in sorted(saved):
            row = gold_row(clips[index], saved[index])
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    global STORE, CLAIMS, RESULTS
    args = parse_args()
    if not args.datasets_bucket and not args.datasets_folder:
        raise SystemExit("one of --datasets-folder or --datasets-bucket is required")
    if not args.dataset:
        raise SystemExit(
            "--dataset is required (or set the DATASET environment variable)"
        )

    database = os.environ.get("DATABASE_URL", "")
    if database:
        STORE = PostgresStore(database, args.dataset)
        print(f"marks -> Postgres (DATABASE_URL), dataset {args.dataset!r}")
    if args.auth and STORE is None:
        raise SystemExit(
            "--auth/--local-auth needs DATABASE_URL: the name bindings live in the database"
        )
    if args.auth == "local":
        print("local sign-in required (--local-auth); ?who= ignored -- do not expose this")
    elif args.auth:
        print("google sign-in required; ?who= ignored")
    CLAIMS = STORE if STORE is not None else FileClaims(args.out)
    RESULTS = EvalResults(args.eval_results_bucket or None, args.out / "_eval-results")
    print(f"aligner eval results -> {RESULTS.where()}")
    print(f"split is always on: each annotator gets their own clips, {BLOCK} at a time")
    try:
        aligner_config()
        print("aligner: configured (ENDPOINT_ID and RP_API_KEY/RUNPOD_API_KEY set)")
    except AlignerError as exc:
        print(f"aligner: {exc}")

    dataset = resolve_dataset(args)
    meta = dataset.metadata()
    kind = "bucket" if isinstance(dataset, BucketDataset) else "folder"
    print(f"dataset: {meta.get('name', dataset.name)} ({kind})")

    clips = build_clips(dataset.manifest())
    if not clips:
        raise SystemExit(f"no usable clips in dataset {args.dataset!r}")

    if isinstance(dataset, LocalDataset):
        missing = [c for c in clips if dataset.audio_exists(c["audio"]) is False]
        if missing:
            first = dataset.dir / missing[0]["audio"]
            raise SystemExit(
                f"{len(missing)} of {len(clips)} clip audio files are not where the "
                f"manifest says they are; first missing: {first}"
            )

    server = ThreadingHTTPServer(
        (args.host, args.port), make_handler(args, dataset, clips)
    )
    words = sum(len(c["a"]) for c in clips)
    print(f"{len(clips)} clips, {words} boundaries to check")
    where = "localhost" if args.host in ("127.0.0.1", "localhost") else args.host
    link = f"http://{where}:{args.port}/"
    if args.token:
        link += f"?t={args.token}"
    print(f"open {link}   (ctrl-c to stop; progress is saved per clip)")
    print(f"several annotators: each gets their own file under {args.out}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\nstopped. marks are under {args.out}/")


if __name__ == "__main__":
    main()
