"""Personal workspace storage for user-specific skills and CLAUDE.md.

Each user can store personal skills and CLAUDE.md in their Databricks workspace
personal folder: /Users/<email>/.claude/

- CLAUDE.md at: /Users/<email>/.claude/CLAUDE.md
- Skills at: /Users/<email>/.claude/skills/<skill-name>/SKILL.md (+ related files)

Personal skills are synced to the project .claude/skills/ directory before each
agent run, overriding app-default skills with the same directory name.
"""

import base64
import logging
import os
from pathlib import Path

from databricks.sdk import WorkspaceClient
from databricks.sdk.credentials_provider import CredentialsStrategy
from databricks.sdk.service.workspace import ExportFormat, ImportFormat, ObjectType

logger = logging.getLogger(__name__)

_SKILLS_SUBDIR = 'skills'


def _get_workspace_client(user_token: str | None) -> WorkspaceClient:
  """Get WorkspaceClient using the user's personal access token."""
  host = os.environ.get('DATABRICKS_HOST', '')
  if user_token:
    token = user_token

    class _UserTokenStrategy(CredentialsStrategy):
      def auth_type(self) -> str:
        return 'pat'

      def __call__(self, cfg):
        return lambda: {'Authorization': f'Bearer {token}'}

    return WorkspaceClient(host=host, credentials_strategy=_UserTokenStrategy())
  # Fall back to SDK defaults (dev mode)
  return WorkspaceClient()


def get_personal_base_path(user_email: str) -> str:
  """Return the personal workspace base path for a user."""
  return f'/Users/{user_email}/.claude'


def _read_workspace_file(w: WorkspaceClient, path: str) -> str | None:
  """Read a text file from Databricks workspace. Returns None if not found."""
  try:
    result = w.workspace.export(path=path, format=ExportFormat.AUTO)
    if result.content:
      return base64.b64decode(result.content).decode('utf-8', errors='replace')
    return ''
  except Exception as e:
    err_str = str(e).lower()
    if any(k in err_str for k in ('resource_does_not_exist', 'does not exist', 'not found', '404')):
      return None
    logger.error(f'Failed to read workspace file {path}: {e}')
    raise


def _write_workspace_file(w: WorkspaceClient, path: str, content: str) -> None:
  """Write a text file to Databricks workspace, creating parent dirs."""
  parent = '/'.join(path.split('/')[:-1])
  if parent:
    try:
      w.workspace.mkdirs(path=parent)
    except Exception:
      pass  # May already exist
  encoded = base64.b64encode(content.encode('utf-8')).decode('ascii')
  w.workspace.import_(
    path=path,
    content=encoded,
    format=ImportFormat.AUTO,
    overwrite=True,
  )


def _list_workspace_directory(w: WorkspaceClient, path: str) -> list:
  """List objects in a workspace directory. Returns empty list if not found."""
  try:
    result = w.workspace.list(path=path)
    return list(result) if result else []
  except Exception as e:
    err_str = str(e).lower()
    if any(k in err_str for k in ('resource_does_not_exist', 'does not exist', 'not found', '404')):
      return []
    logger.error(f'Failed to list workspace directory {path}: {e}')
    return []


# ---------------------------------------------------------------------------
# Personal skills
# ---------------------------------------------------------------------------

def list_personal_skills(user_email: str, user_token: str | None) -> list[dict]:
  """List personal skills from user's workspace personal folder.

  Returns:
      List of dicts with name, description, workspace_path for each skill.
  """
  w = _get_workspace_client(user_token)
  skills_path = f'{get_personal_base_path(user_email)}/{_SKILLS_SUBDIR}'

  objects = _list_workspace_directory(w, skills_path)
  skills = []

  for obj in objects:
    if getattr(obj, 'object_type', None) != ObjectType.DIRECTORY:
      continue

    skill_dir_path = getattr(obj, 'path', '') or ''
    if not skill_dir_path:
      continue

    skill_dir_name = skill_dir_path.split('/')[-1]
    skill_name = skill_dir_name
    description = ''

    # Parse SKILL.md frontmatter for name/description
    skill_md_path = f'{skill_dir_path}/SKILL.md'
    try:
      content = _read_workspace_file(w, skill_md_path)
      if content and content.startswith('---'):
        end_idx = content.find('---', 3)
        if end_idx > 0:
          for line in content[3:end_idx].strip().split('\n'):
            if line.startswith('name:'):
              skill_name = line.split(':', 1)[1].strip().strip('"\'')
            elif line.startswith('description:'):
              description = line.split(':', 1)[1].strip().strip('"\'')
    except Exception:
      pass

    skills.append({
      'name': skill_name,
      'description': description,
      'workspace_path': skill_dir_path,
    })

  return skills


def get_personal_skill_tree(user_email: str, user_token: str | None) -> list[dict]:
  """Build a file tree of personal skills from user's workspace."""
  w = _get_workspace_client(user_token)
  skills_path = f'{get_personal_base_path(user_email)}/{_SKILLS_SUBDIR}'

  def build_node(obj) -> dict | None:
    path = getattr(obj, 'path', '') or ''
    name = path.split('/')[-1]
    obj_type = getattr(obj, 'object_type', None)

    if obj_type == ObjectType.DIRECTORY:
      sub_objects = _list_workspace_directory(w, path)
      sub_objects.sort(key=lambda x: (
        getattr(x, 'object_type', None) != ObjectType.DIRECTORY,
        (getattr(x, 'path', '') or '').lower(),
      ))
      children = [n for n in (build_node(o) for o in sub_objects) if n is not None]
      return {'name': name, 'path': path, 'type': 'directory', 'children': children}
    elif obj_type in (ObjectType.FILE, ObjectType.NOTEBOOK):
      return {'name': name, 'path': path, 'type': 'file'}
    return None

  top_objects = _list_workspace_directory(w, skills_path)
  top_objects.sort(key=lambda x: (
    getattr(x, 'object_type', None) != ObjectType.DIRECTORY,
    (getattr(x, 'path', '') or '').lower(),
  ))

  return [n for n in (build_node(o) for o in top_objects) if n is not None]


def get_personal_skill_file(user_email: str, user_token: str | None, workspace_path: str) -> str | None:
  """Get content of a personal skill file by full workspace path.

  Raises:
      ValueError: If path is outside the user's personal folder.
  """
  personal_base = get_personal_base_path(user_email)
  if not workspace_path.startswith(personal_base):
    raise ValueError(f'Path must be within personal folder: {personal_base}')
  w = _get_workspace_client(user_token)
  return _read_workspace_file(w, workspace_path)


def save_personal_skill_file(
  user_email: str,
  user_token: str | None,
  workspace_path: str,
  content: str,
) -> bool:
  """Save content of a personal skill file by full workspace path.

  Raises:
      ValueError: If path is outside the user's personal folder.
  """
  personal_base = get_personal_base_path(user_email)
  if not workspace_path.startswith(personal_base):
    raise ValueError(f'Path must be within personal folder: {personal_base}')
  w = _get_workspace_client(user_token)
  try:
    _write_workspace_file(w, workspace_path, content)
    logger.info(f'Saved personal skill file: {workspace_path}')
    return True
  except Exception as e:
    logger.error(f'Failed to save personal skill file {workspace_path}: {e}')
    return False


# ---------------------------------------------------------------------------
# Project sync
# ---------------------------------------------------------------------------

def sync_personal_skills_to_project(
  user_email: str,
  user_token: str | None,
  project_dir: Path,
) -> int:
  """Sync personal workspace skills to the project's .claude/skills directory.

  Downloads each skill directory from /Users/<email>/.claude/skills/ to
  project/.claude/skills/. Personal skills override app-default skills that
  share the same directory name.

  Returns:
      Number of skills synced (0 if no personal skills found).
  """
  w = _get_workspace_client(user_token)
  skills_ws_path = f'{get_personal_base_path(user_email)}/{_SKILLS_SUBDIR}'

  skill_dirs = _list_workspace_directory(w, skills_ws_path)
  if not skill_dirs:
    return 0

  project_skills_dir = project_dir / '.claude' / 'skills'
  project_skills_dir.mkdir(parents=True, exist_ok=True)

  synced = 0
  for skill_obj in skill_dirs:
    if getattr(skill_obj, 'object_type', None) != ObjectType.DIRECTORY:
      continue
    skill_ws_path = getattr(skill_obj, 'path', '') or ''
    if not skill_ws_path:
      continue

    skill_dir_name = skill_ws_path.split('/')[-1]
    local_skill_dir = project_skills_dir / skill_dir_name

    try:
      local_skill_dir.mkdir(parents=True, exist_ok=True)
      _sync_workspace_dir_to_local(w, skill_ws_path, local_skill_dir)
      synced += 1
      logger.debug(f'Synced personal skill: {skill_dir_name}')
    except Exception as e:
      logger.warning(f'Failed to sync personal skill {skill_dir_name}: {e}')

  if synced > 0:
    logger.info(f'Synced {synced} personal skills from workspace to {project_dir}')
  return synced


def _sync_workspace_dir_to_local(w: WorkspaceClient, ws_path: str, local_dir: Path) -> None:
  """Recursively sync a workspace directory to a local directory."""
  for obj in _list_workspace_directory(w, ws_path):
    obj_path = getattr(obj, 'path', '') or ''
    obj_name = obj_path.split('/')[-1]
    obj_type = getattr(obj, 'object_type', None)

    if obj_type == ObjectType.DIRECTORY:
      sub_local = local_dir / obj_name
      sub_local.mkdir(parents=True, exist_ok=True)
      _sync_workspace_dir_to_local(w, obj_path, sub_local)
    elif obj_type in (ObjectType.FILE, ObjectType.NOTEBOOK):
      try:
        content = _read_workspace_file(w, obj_path)
        if content is not None:
          (local_dir / obj_name).write_text(content, encoding='utf-8')
      except Exception as e:
        logger.warning(f'Failed to sync workspace file {obj_path}: {e}')
