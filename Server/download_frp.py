"""Fetch the complete official Linux FRP folder, with fixed checksums."""
import argparse
import hashlib
from pathlib import Path
import tarfile
import urllib.request

VERSION = "0.71.0"
HASHES = {"amd64": "84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716",
          "arm64": "f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266"}
parser = argparse.ArgumentParser()
parser.add_argument("--arch", choices=HASHES, default="amd64")
parser.add_argument("--extract", action="store_true", help="Extract the complete folder on the target Linux server")
args = parser.parse_args()
base = Path(__file__).resolve().parent / "frp"
target = base / f"linux-{args.arch}"
archive = base / f"frp_{VERSION}_linux_{args.arch}.tar.gz"
url = f"https://github.com/fatedier/frp/releases/download/v{VERSION}/{archive.name}"
if not archive.exists():
    with urllib.request.urlopen(url, timeout=60) as source, archive.open("wb") as output:
        while data := source.read(1024 * 1024):
            output.write(data)
if hashlib.sha256(archive.read_bytes()).hexdigest() != HASHES[args.arch]:
    raise SystemExit("FRP checksum mismatch; remove the downloaded archive and retry")
if args.extract:
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as source:
        source.extractall(target, filter="data")
    print(f"Complete official FRP folder extracted to {target}")
else:
    print(f"Complete official FRP archive verified: {archive}; use --extract on the server")
