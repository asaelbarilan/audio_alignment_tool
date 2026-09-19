"""Download a dataset (see DATASET_SPEC.md) from the S3 bucket into a local folder.

The counterpart of upload_dataset.py, with the same conventions: the dataset's top-level
prefix in the bucket becomes <datasets-folder>/<dataset>/ locally, and credentials and the
endpoint come from the environment (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID,
S3_SECRET_ACCESS_KEY), loaded from .env if present and never read or printed here.

    python -m hebrew_training.download_dataset --dataset ivrit-ai

Files already present locally at the same size are skipped, so a re-run after the dataset
grows fetches only the new clips.
"""

from __future__ import annotations

import argparse
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="Dataset name: the S3 prefix and the local folder.")
    parser.add_argument(
        "--datasets-folder",
        type=Path,
        default=Path("data/datasets"),
        help="Local folder holding one subfolder per dataset (default: data/datasets).",
    )
    parser.add_argument(
        "--bucket",
        default=os.environ.get("DATASETS_BUCKET") or os.environ.get("S3_BUCKET", ""),
        help="Source bucket. Defaults to DATASETS_BUCKET or S3_BUCKET, as upload_dataset.py.",
    )
    parser.add_argument("--workers", type=int, default=8, help="Parallel download threads.")
    return parser.parse_args()


def s3_client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        region_name=os.environ.get("S3_REGION", "us-east-1"),
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
        # Same reason as upload_dataset.py: this endpoint needs path-style addressing.
        config=Config(s3={"addressing_style": "path"}),
    )


def main() -> None:
    args = parse_args()
    if not args.bucket:
        raise SystemExit("no bucket: set DATASETS_BUCKET or S3_BUCKET, or pass --bucket")
    client = s3_client()
    prefix = args.dataset.rstrip("/") + "/"
    remote: dict[str, int] = {}
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=args.bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            remote[obj["Key"]] = obj["Size"]
    if not remote:
        raise SystemExit(f"nothing under {prefix} in {args.bucket}")

    todo = []
    for key, size in remote.items():
        local = args.datasets_folder / key
        if not (local.exists() and local.stat().st_size == size):
            todo.append((key, local))

    def fetch(item):
        key, local = item
        local.parent.mkdir(parents=True, exist_ok=True)
        client.download_file(args.bucket, key, str(local))

    with ThreadPoolExecutor(args.workers) as pool:
        list(pool.map(fetch, todo))
    print(f"{args.dataset}: {len(remote)} files in the bucket, {len(todo)} downloaded, "
          f"{len(remote) - len(todo)} already up to date -> {args.datasets_folder / args.dataset}")


if __name__ == "__main__":
    main()
