"""Fernet symmetric encryption for sensitive values (PAT, etc.).

Key derivation priority:
1. ENCRYPTION_KEY env var (base64-encoded 32 bytes)
2. Derived from DATABRICKS_CLIENT_SECRET via SHA-256
3. Derived from a fixed fallback (development only -- not secure for production)
"""

import base64
import hashlib
import os

from cryptography.fernet import Fernet

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
  """Get or create the singleton Fernet instance."""
  global _fernet
  if _fernet is not None:
    return _fernet

  raw_key = os.environ.get('ENCRYPTION_KEY')
  if raw_key:
    key = raw_key.encode() if isinstance(raw_key, str) else raw_key
  else:
    secret = os.environ.get('DATABRICKS_CLIENT_SECRET', 'dev-fallback-key-not-secure')
    key_bytes = hashlib.sha256(secret.encode()).digest()
    key = base64.urlsafe_b64encode(key_bytes)

  _fernet = Fernet(key)
  return _fernet


def encrypt(plaintext: str) -> str:
  """Encrypt a string and return base64-encoded ciphertext."""
  return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
  """Decrypt a base64-encoded Fernet ciphertext back to plaintext."""
  return _get_fernet().decrypt(ciphertext.encode()).decode()
