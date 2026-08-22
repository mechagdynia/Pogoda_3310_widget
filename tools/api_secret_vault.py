"""Local AES-256-GCM vault for API keys that must never enter Git history.

The encrypted JSON may be committed. The 64-character hexadecimal vault key
stays under .local-secrets/ (ignored by Git). Never decrypt browser-side: a
front-end user could inspect both the plaintext key and the outgoing request.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KEY = ROOT / ".local-secrets" / "Pogoda_3310_widget" / "vault.key"


def read_or_create_key(path: Path, create: bool) -> bytes:
    if path.exists():
        value = path.read_text(encoding="ascii").strip()
        key = bytes.fromhex(value)
        if len(key) != 32:
            raise ValueError("Vault key must contain exactly 64 hexadecimal characters")
        return key
    if not create:
        raise FileNotFoundError(f"Missing local vault key: {path}")
    key = os.urandom(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(key.hex() + "\n", encoding="ascii")
    return key


def encrypt(name: str, input_file: Path, output: Path, key_file: Path) -> None:
    secret = input_file.read_text(encoding="utf-8").strip()
    if not secret:
        raise ValueError("Input secret is empty")
    key = read_or_create_key(key_file, create=True)
    nonce = os.urandom(12)
    cipher = AESGCM(key).encrypt(nonce, secret.encode("utf-8"), name.encode("utf-8"))
    payload = base64.urlsafe_b64encode(nonce + cipher).decode("ascii").rstrip("=")
    document = {
        "name": name,
        "algorithm": "AES-256-GCM",
        "key_fingerprint_sha256": hashlib.sha256(key).hexdigest(),
        "payload": payload,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"Encrypted {name}: {len(payload)} public characters; local key: {len(key.hex())} hex characters")


def decrypt(input_file: Path, output: Path, key_file: Path) -> None:
    document = json.loads(input_file.read_text(encoding="utf-8"))
    key = read_or_create_key(key_file, create=False)
    fingerprint = hashlib.sha256(key).hexdigest()
    if fingerprint != document.get("key_fingerprint_sha256"):
        raise ValueError("Local vault key does not match the public fingerprint")
    payload = str(document["payload"])
    packed = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
    plaintext = AESGCM(key).decrypt(packed[:12], packed[12:], str(document["name"]).encode("utf-8"))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(plaintext + b"\n")
    print(f"Decrypted to ignored local file: {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Encrypt/decrypt API keys outside Git history")
    parser.add_argument("action", choices=("encrypt", "decrypt"))
    parser.add_argument("--name", default="api_ninjas")
    parser.add_argument("--key-file", type=Path, default=DEFAULT_KEY)
    parser.add_argument("--input-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "encrypt":
        encrypt(args.name, args.input_file, args.output, args.key_file)
    else:
        decrypt(args.input_file, args.output, args.key_file)


if __name__ == "__main__":
    main()
