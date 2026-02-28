"""Personal workspace API endpoints.

CRUD operations for user-specific skills and CLAUDE.md stored in the user's
Databricks workspace personal folder (/Users/<email>/.claude/).

Authentication uses the user's X-Forwarded-Access-Token so that reads/writes
are performed with the user's own credentials and scoped to their personal folder.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from ..services.user import get_current_user
from ..services.workspace_personal import (
  get_personal_skill_file,
  get_personal_skill_tree,
  list_personal_skills,
  save_personal_skill_file,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_user_token(request: Request) -> str | None:
  """Get the user's personal access token from request headers."""
  return request.headers.get('X-Forwarded-Access-Token')


# ---------------------------------------------------------------------------
# Personal skills
# ---------------------------------------------------------------------------

class SaveSkillFileRequest(BaseModel):
  """Request to save a personal skill file."""
  workspace_path: str  # Full workspace path (must be within user's personal folder)
  content: str


@router.get('/personal/skills')
async def list_skills(request: Request):
  """List personal skills from the user's workspace personal folder."""
  user_email = await get_current_user(request)
  user_token = _get_user_token(request)

  try:
    skills = list_personal_skills(user_email, user_token)
    return {'skills': skills}
  except Exception as e:
    logger.error(f'Failed to list personal skills for {user_email}: {e}')
    raise HTTPException(status_code=500, detail=str(e))


@router.get('/personal/skills/tree')
async def get_skills_tree(request: Request):
  """Get the personal skills file tree from the user's workspace."""
  user_email = await get_current_user(request)
  user_token = _get_user_token(request)

  try:
    tree = get_personal_skill_tree(user_email, user_token)
    return {'tree': tree}
  except Exception as e:
    logger.error(f'Failed to get personal skills tree for {user_email}: {e}')
    raise HTTPException(status_code=500, detail=str(e))


@router.get('/personal/skills/file')
async def get_skill_file(
  request: Request,
  path: str = Query(..., description='Full workspace path of the skill file'),
):
  """Get content of a personal skill file by its full workspace path."""
  user_email = await get_current_user(request)
  user_token = _get_user_token(request)

  try:
    content = get_personal_skill_file(user_email, user_token, path)
    if content is None:
      raise HTTPException(status_code=404, detail='File not found')
    return {'path': path, 'content': content, 'filename': path.split('/')[-1]}
  except HTTPException:
    raise
  except ValueError as e:
    raise HTTPException(status_code=403, detail=str(e))
  except Exception as e:
    logger.error(f'Failed to get personal skill file {path}: {e}')
    raise HTTPException(status_code=500, detail=str(e))


@router.put('/personal/skills/file')
async def save_skill_file(request: Request, body: SaveSkillFileRequest):
  """Save content of a personal skill file to the user's workspace."""
  user_email = await get_current_user(request)
  user_token = _get_user_token(request)

  try:
    success = save_personal_skill_file(user_email, user_token, body.workspace_path, body.content)
    if not success:
      raise HTTPException(status_code=500, detail='Failed to save skill file')
    return {'success': True}
  except HTTPException:
    raise
  except ValueError as e:
    raise HTTPException(status_code=403, detail=str(e))
  except Exception as e:
    logger.error(f'Failed to save personal skill file: {e}')
    raise HTTPException(status_code=500, detail=str(e))
