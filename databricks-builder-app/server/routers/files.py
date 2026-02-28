"""File proxy endpoint — serves Databricks workspace/DBFS/Volumes files to the browser.

Agents save PNGs to paths like:
  /Workspace/Users/.../chart.png
  dbfs:/tmp/chart.png
  /Volumes/catalog/schema/volume/chart.png

The agent includes them in its response as standard Markdown images:
  ![chart](/api/workspace/file?path=/Workspace/Users/.../chart.png)

The browser fetches the image through this endpoint, which proxies the content
using the app's Databricks SDK credentials.
"""

import asyncio
import base64
import logging
import mimetypes
import os

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

from ..services.user import get_current_user, get_databricks_token

logger = logging.getLogger(__name__)
router = APIRouter()

_ALLOWED_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf', '.csv', '.txt', '.html'}


def _guess_content_type(path: str) -> str:
  ext = os.path.splitext(path.lower())[1]
  return mimetypes.types_map.get(ext, 'application/octet-stream')


def _get_workspace_client(user_token: str | None = None):
  """Create a WorkspaceClient with the best available credentials.

  OBO: when the user's forwarded access token is present, use it via
  credentials_strategy so no token= appears in the SDK config — avoiding the
  "more than one authorization method configured: oauth and pat" conflict when
  SP OAuth env vars (DATABRICKS_CLIENT_ID/SECRET) are also present.
  """
  from databricks.sdk import WorkspaceClient
  from databricks.sdk.credentials_provider import CredentialsStrategy
  host = os.environ.get('DATABRICKS_HOST', '')

  # OBO: inject user token as Bearer without polluting SDK config with token=
  if user_token:
    _token = user_token

    class _UserTokenStrategy(CredentialsStrategy):
      def auth_type(self) -> str:
        return 'pat'

      def __call__(self, cfg):
        return lambda: {'Authorization': f'Bearer {_token}'}

    return WorkspaceClient(host=host, credentials_strategy=_UserTokenStrategy())

  # No user token — fall back to SP OAuth credentials if available
  client_id = os.environ.get('DATABRICKS_CLIENT_ID', '')
  client_secret = os.environ.get('DATABRICKS_CLIENT_SECRET', '')
  if client_id and client_secret:
    return WorkspaceClient(host=host, client_id=client_id, client_secret=client_secret)

  # Local development — use default SDK credential discovery
  return WorkspaceClient()


def _read_dbfs_file(w, dbfs_path: str) -> bytes:
  """Read a DBFS file using the paginated read API (max 1 MB per call)."""
  MAX_CHUNK = 1024 * 1024  # 1 MB — Databricks DBFS API limit
  chunks: list[bytes] = []
  offset = 0
  while True:
    result = w.dbfs.read(path=dbfs_path, offset=offset, length=MAX_CHUNK)
    if not result.data:
      break
    chunk = base64.b64decode(result.data)
    chunks.append(chunk)
    offset += len(chunk)
    # Stop when we received fewer bytes than requested
    if len(chunk) < MAX_CHUNK:
      break
  return b''.join(chunks)


def _read_volume_file(w, path: str) -> bytes:
  """Read a Unity Catalog Volume file via Files API with DBFS fallback.

  Args:
      w: Databricks WorkspaceClient
      path: Volume path as /Volumes/... or dbfs:/Volumes/...

  Returns:
      File bytes.

  Raises:
      Exception: Re-raises the primary Files API error if all fallbacks fail.
  """
  volume_path = path
  if path.startswith('dbfs:/Volumes/'):
    volume_path = path[len('dbfs:'):]

  primary_err: Exception | None = None

  # 1) Preferred for UC Volumes: Files API with /Volumes/... path
  try:
    response = w.files.download(file_path=volume_path)
    data = response.contents.read()
    if data:
      logger.info(f'Fetched volume file via Files API: {len(data)} bytes from {volume_path!r}')
      return data
  except Exception as e:
    primary_err = e
    logger.warning(f'Files API failed for volume path {volume_path!r}: {e}')

  # 2) Fallback: DBFS read on dbfs:/Volumes/...
  dbfs_path = volume_path if volume_path.startswith('dbfs:/') else f'dbfs:{volume_path}'
  try:
    data = _read_dbfs_file(w, dbfs_path)
    if data:
      logger.info(f'Fetched volume file via DBFS API: {len(data)} bytes from {dbfs_path!r}')
      return data
  except Exception as e:
    logger.warning(f'DBFS fallback failed for volume path {dbfs_path!r}: {e}')
    if primary_err is None:
      primary_err = e

  if primary_err is not None:
    raise primary_err
  raise FileNotFoundError(f'Volume file is empty or unavailable: {path}')


def _fetch_workspace_file(path: str, user_token: str | None = None) -> bytes:
  """Fetch a file from Databricks (workspace / DBFS / UC Volumes). Runs in thread pool."""
  import traceback
  w = _get_workspace_client(user_token)

  logger.info(f'Fetching file: {path!r} (user_token present: {bool(user_token)})')

  # Unity Catalog Volumes: /Volumes/catalog/schema/volume/...
  if path.startswith('/Volumes/') or path.startswith('dbfs:/Volumes/'):
    return _read_volume_file(w, path)

  # DBFS: dbfs:/... or /dbfs/...
  if path.startswith('dbfs:/') or path.startswith('/dbfs/'):
    dbfs_path = path if path.startswith('dbfs:/') else 'dbfs:/' + path[6:]
    logger.info(f'Reading DBFS path: {dbfs_path!r}')
    try:
      data = _read_dbfs_file(w, dbfs_path)
      logger.info(f'Fetched DBFS file: {len(data)} bytes')
      return data
    except Exception as e:
      logger.error(f'DBFS read failed for {dbfs_path!r}: {e}\n{traceback.format_exc()}')
      raise

  # Workspace file: /Workspace/... or /Users/... or /Shared/...
  if path.startswith('/Workspace/') or path.startswith('/Users/') or path.startswith('/Shared/'):
    from databricks.sdk.service.workspace import ExportFormat
    result = w.workspace.export(path=path, format=ExportFormat.AUTO)
    if result.content:
      data = base64.b64decode(result.content)
      logger.info(f'Fetched workspace file: {len(data)} bytes')
      return data
    return b''

  raise ValueError(f'Unsupported path prefix: {path}')


@router.get('/workspace/file')
async def get_workspace_file(
  request: Request,
  path: str = Query(..., description='Databricks file path'),
):
  """Proxy a Databricks workspace/DBFS/Volumes file to the browser.

  Security: requires authenticated user. Only image and document extensions are served.
  """
  # Authenticate — raises if unauthenticated
  user_email = await get_current_user(request)

  # Block directory traversal and unsupported extensions
  normalized = os.path.normpath(path)
  if '..' in normalized:
    raise HTTPException(status_code=400, detail='Invalid path')

  ext = os.path.splitext(path.lower())[1]
  if ext not in _ALLOWED_EXTENSIONS:
    raise HTTPException(status_code=400, detail=f'Unsupported file type: {ext}')

  user_token = await get_databricks_token(request, user_email)

  try:
    content = await asyncio.to_thread(_fetch_workspace_file, path, user_token)
  except Exception as e:
    logger.warning(f'Failed to fetch workspace file {path!r}: {e}')
    raise HTTPException(status_code=404, detail=str(e))

  content_type = _guess_content_type(path)
  return Response(
    content=content,
    media_type=content_type,
    headers={'Cache-Control': 'private, max-age=300'},
  )
