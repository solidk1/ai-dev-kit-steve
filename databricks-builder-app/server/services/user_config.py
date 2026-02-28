"""Service for per-user configuration stored in Lakebase."""

import logging

from sqlalchemy import select

from server.db import UserConfig, session_scope
from server.db.models import utc_now
from .encryption import decrypt, encrypt

logger = logging.getLogger(__name__)

async def get_user_config(user_email: str) -> dict:
  """Get saved configuration for a user. Returns defaults (all None) if not set."""
  async with session_scope() as session:
    result = await session.execute(
      select(UserConfig).where(UserConfig.user_email == user_email)
    )
    config = result.scalar_one_or_none()
    if config:
      return config.to_dict()
    return {
      'user_email': user_email,
      'default_catalog': None,
      'default_schema': None,
      'workspace_folder': None,
      'model': None,
      'model_mini': None,
    }


async def save_user_config(
  user_email: str,
  default_catalog: str | None,
  default_schema: str | None,
  workspace_folder: str | None,
  model: str | None,
  model_mini: str | None,
) -> None:
  """Upsert user configuration (does NOT touch PAT)."""
  async with session_scope() as session:
    result = await session.execute(
      select(UserConfig).where(UserConfig.user_email == user_email)
    )
    config = result.scalar_one_or_none()
    if config:
      config.default_catalog = default_catalog or None
      config.default_schema = default_schema or None
      config.workspace_folder = workspace_folder or None
      config.model = model or None
      config.model_mini = model_mini or None
      config.updated_at = utc_now()
    else:
      config = UserConfig(
        user_email=user_email,
        default_catalog=default_catalog or None,
        default_schema=default_schema or None,
        workspace_folder=workspace_folder or None,
        model=model or None,
        model_mini=model_mini or None,
        updated_at=utc_now(),
      )
      session.add(config)


# --- PAT operations ---

async def save_user_pat(user_email: str, pat: str) -> None:
  """Save (or replace) the user's encrypted Databricks PAT."""
  encrypted = encrypt(pat)
  async with session_scope() as session:
    result = await session.execute(
      select(UserConfig).where(UserConfig.user_email == user_email)
    )
    config = result.scalar_one_or_none()
    if config:
      config.databricks_pat_encrypted = encrypted
      config.updated_at = utc_now()
    else:
      config = UserConfig(
        user_email=user_email,
        databricks_pat_encrypted=encrypted,
        updated_at=utc_now(),
      )
      session.add(config)
  logger.info(f'Saved encrypted PAT for {user_email}')


async def delete_user_pat(user_email: str) -> None:
  """Remove the user's stored PAT."""
  async with session_scope() as session:
    result = await session.execute(
      select(UserConfig).where(UserConfig.user_email == user_email)
    )
    config = result.scalar_one_or_none()
    if config and config.databricks_pat_encrypted:
      config.databricks_pat_encrypted = None
      config.updated_at = utc_now()
      logger.info(f'Deleted PAT for {user_email}')


async def get_user_pat(user_email: str) -> str | None:
  """Get the decrypted PAT for a user, or None if not set."""
  async with session_scope() as session:
    result = await session.execute(
      select(UserConfig).where(UserConfig.user_email == user_email)
    )
    config = result.scalar_one_or_none()
    if config and config.databricks_pat_encrypted:
      try:
        return decrypt(config.databricks_pat_encrypted)
      except Exception as e:
        logger.error(f'Failed to decrypt PAT for {user_email}: {e}')
        return None
  return None
