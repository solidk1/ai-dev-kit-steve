"""Configuration and user info endpoints."""

import logging
import os
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from ..db import get_lakebase_project_id, is_postgres_configured, test_database_connection
from ..services.system_prompt import get_system_prompt
from ..services.user import get_current_user, get_workspace_url
from ..services.user_config import get_user_config, save_user_config, save_user_pat, delete_user_pat, get_user_pat

logger = logging.getLogger(__name__)
router = APIRouter()

# Package version (set once)
try:
  from importlib.metadata import version as _pkg_version
  _APP_VERSION = _pkg_version('databricks-builder-app')
except Exception:
  _APP_VERSION = '0.1.0'


def _get_app_name(request: Request) -> str:
  """Determine the Databricks App name.

  Priority:
  1. DATABRICKS_APP_NAME env var (explicit)
  2. Extracted from the forwarded host header (Databricks Apps URL pattern)
  3. Fallback to package name
  """
  if name := os.environ.get('DATABRICKS_APP_NAME', ''):
    return name

  # Databricks App URL: {app-name}-{workspace_id}.{region}.databricksapps.com
  host = request.headers.get('x-forwarded-host') or request.headers.get('host', '')
  if host and 'databricksapps.com' in host:
    # Strip port if present
    hostname = host.split(':')[0]
    m = re.match(r'^([\w-]+?)-\d{10,}\.', hostname)
    if m:
      return m.group(1)

  return 'databricks-builder-app'


@router.get('/me')
async def get_user_info(request: Request):
  """Get current user information and app configuration."""
  user_email = await get_current_user(request)
  workspace_url = get_workspace_url()
  lakebase_configured = is_postgres_configured()
  lakebase_project_id = get_lakebase_project_id()

  # Test database connection if configured
  lakebase_error = None
  if lakebase_configured:
    lakebase_error = await test_database_connection()

  return {
    'user': user_email,
    'workspace_url': workspace_url,
    'lakebase_configured': lakebase_configured,
    'lakebase_project_id': lakebase_project_id,
    'lakebase_error': lakebase_error,
    'app_name': _get_app_name(request),
    'app_version': _APP_VERSION,
    'model': os.environ.get('ANTHROPIC_MODEL', ''),
    'model_mini': os.environ.get('ANTHROPIC_MODEL_MINI', ''),
  }


class UpdateSettingsRequest(BaseModel):
  """Request body for updating user settings."""
  default_catalog: Optional[str] = None
  default_schema: Optional[str] = None
  workspace_folder: Optional[str] = None
  model: Optional[str] = None
  model_mini: Optional[str] = None


@router.get('/settings')
async def get_settings(request: Request):
  """Get the current user's saved settings plus server-level defaults."""
  user_email = await get_current_user(request)
  user_config = await get_user_config(user_email)
  # Include decrypted PAT so the frontend can display it
  pat = await get_user_pat(user_email)
  return {
    'user': user_email,
    'workspace_url': get_workspace_url(),
    'server_model': os.environ.get('ANTHROPIC_MODEL', ''),
    'server_model_mini': os.environ.get('ANTHROPIC_MODEL_MINI', ''),
    'databricks_pat': pat,
    **user_config,
  }


@router.put('/settings')
async def update_settings(request: Request, body: UpdateSettingsRequest):
  """Save the current user's settings to the database."""
  user_email = await get_current_user(request)
  await save_user_config(
    user_email,
    default_catalog=body.default_catalog,
    default_schema=body.default_schema,
    workspace_folder=body.workspace_folder,
    model=body.model,
    model_mini=body.model_mini,
  )
  return {'success': True}


class SavePatRequest(BaseModel):
  """Request body for saving a Databricks PAT."""
  pat: str


@router.put('/pat')
async def save_pat(request: Request, body: SavePatRequest):
  """Save or replace the user's Databricks Personal Access Token."""
  user_email = await get_current_user(request)
  pat = body.pat.strip()
  if not pat:
    raise HTTPException(status_code=400, detail='PAT cannot be empty')
  if not pat.startswith('dapi'):
    raise HTTPException(status_code=400, detail='Invalid PAT format — must start with "dapi"')
  await save_user_pat(user_email, pat)
  return {'success': True}


@router.delete('/pat')
async def remove_pat(request: Request):
  """Remove the user's stored Databricks PAT."""
  user_email = await get_current_user(request)
  await delete_user_pat(user_email)
  return {'success': True}


@router.get('/health')
async def health_check():
  """Health check endpoint."""
  return {'status': 'healthy'}


@router.get('/system_prompt')
async def get_system_prompt_endpoint(
  cluster_id: Optional[str] = Query(None),
  warehouse_id: Optional[str] = Query(None),
  default_catalog: Optional[str] = Query(None),
  default_schema: Optional[str] = Query(None),
  workspace_folder: Optional[str] = Query(None),
  project_id: Optional[str] = Query(None),
):
  """Get the system prompt with current configuration."""
  enabled_skills = None
  if project_id:
    from ..services.agent import get_project_directory
    from ..services.skills_manager import get_project_enabled_skills
    project_dir = get_project_directory(project_id)
    enabled_skills = get_project_enabled_skills(project_dir)

  prompt = get_system_prompt(
    cluster_id=cluster_id,
    default_catalog=default_catalog,
    default_schema=default_schema,
    warehouse_id=warehouse_id,
    workspace_folder=workspace_folder,
    enabled_skills=enabled_skills,
  )
  return {'system_prompt': prompt}


@router.get('/mlflow/status')
async def mlflow_status_endpoint():
  """Get MLflow tracing status and configuration.

  Returns current MLflow tracing state including:
  - Whether tracing is enabled (via MLFLOW_EXPERIMENT_NAME env var)
  - Tracking URI
  - Current experiment info
  """
  experiment_name = os.environ.get('MLFLOW_EXPERIMENT_NAME', '')
  tracking_uri = os.environ.get('MLFLOW_TRACKING_URI', 'databricks')

  return {
    'enabled': bool(experiment_name),
    'tracking_uri': tracking_uri,
    'experiment_name': experiment_name,
    'info': 'MLflow tracing is configured via environment variables in app.yaml',
  }
