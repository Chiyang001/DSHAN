"""Create private deployment settings without placing tokens in source control."""
import argparse
import os
from pathlib import Path
import re
import secrets

parser = argparse.ArgumentParser()
parser.add_argument("--domain", required=True, help="Domain with DNS pointing to this server, without scheme or path")
parser.add_argument("--email", required=True, help="Certificate renewal contact")
args = parser.parse_args()
domain = args.domain.lower()
if len(domain) > 253 or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
    parser.error("Invalid domain")
if not re.fullmatch(r"[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", args.email):
    parser.error("Invalid email")
target = Path(__file__).resolve().parent / ".env"
try:
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    parser.error(".env already exists; edit it to preserve the current token")
with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
    stream.write(f"DSH_DOMAIN={domain}\nACME_EMAIL={args.email}\nFRP_AUTH_TOKEN={secrets.token_hex(32)}\n")
print(f"Configuration saved. Pairing address: wss://{domain}/peer")
