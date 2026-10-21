#!/usr/bin/env python3
"""Minimal n8n credential encryption helpers (AES-256-CBC / OpenSSL Salted__)."""

from __future__ import annotations

import hashlib
from typing import Tuple

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


SALTED_PREFIX = b"Salted__"


def _password_bytes(encryption_key: str) -> bytes:
    # Matches Node Buffer.from(key, 'binary')
    return encryption_key.encode("latin-1")


def _derive_key_iv(salt: bytes, encryption_key: str) -> Tuple[bytes, bytes]:
    password = _password_bytes(encryption_key) + salt
    hash1 = hashlib.md5(password).digest()
    hash2 = hashlib.md5(hash1 + password).digest()
    iv = hashlib.md5(hash2 + password).digest()
    return hash1 + hash2, iv


def decrypt_n8n(data: str, encryption_key: str) -> str:
    import base64

    raw = base64.b64decode(data)
    if raw[:8] != SALTED_PREFIX:
        raise ValueError("Unexpected n8n ciphertext format (expected Salted__)")
    salt = raw[8:16]
    contents = raw[16:]
    key, iv = _derive_key_iv(salt, encryption_key)
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    plain = decryptor.update(contents) + decryptor.finalize()
    pad = plain[-1]
    if 1 <= pad <= 16 and plain.endswith(bytes([pad]) * pad):
        plain = plain[:-pad]
    return plain.decode("utf-8")


def encrypt_n8n(plaintext: str, encryption_key: str) -> str:
    import base64
    import os

    salt = os.urandom(8)
    key, iv = _derive_key_iv(salt, encryption_key)
    pad_len = 16 - (len(plaintext.encode("utf-8")) % 16)
    padded = plaintext.encode("utf-8") + bytes([pad_len] * pad_len)
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    encrypted = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(SALTED_PREFIX + salt + encrypted).decode("ascii")
