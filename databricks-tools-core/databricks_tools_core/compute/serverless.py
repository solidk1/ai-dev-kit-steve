"""Jobs-backed serverless execution helpers."""

import base64
import datetime
import logging
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from databricks.sdk.service.compute import Environment
from databricks.sdk.service.jobs import JobEnvironment, NotebookTask, RunResultState, SubmitTask
from databricks.sdk.service.workspace import ImportFormat, Language

from ..auth import get_current_username, get_workspace_client

logger = logging.getLogger(__name__)

_LANGUAGE_MAP = {
    'python': Language.PYTHON,
    'sql': Language.SQL,
}

_FILE_LANGUAGE_MAP = {
    '.py': 'python',
    '.sql': 'sql',
}


@dataclass
class ServerlessRunResult:
    """Structured result for a serverless Jobs run."""

    success: bool
    output: Optional[str] = None
    error: Optional[str] = None
    run_id: Optional[int] = None
    run_url: Optional[str] = None
    duration_seconds: Optional[float] = None
    state: Optional[str] = None
    message: Optional[str] = None
    workspace_path: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to a JSON-serializable dictionary."""
        payload: Dict[str, Any] = {
            'success': self.success,
            'output': self.output,
            'error': self.error,
            'run_id': self.run_id,
            'run_url': self.run_url,
            'duration_seconds': self.duration_seconds,
            'state': self.state,
            'message': self.message,
        }
        if self.workspace_path:
            payload['workspace_path'] = self.workspace_path
        return payload


def _normalize_workspace_path(path: str) -> str:
    normalized = (path or '').strip()
    if not normalized:
        return '/'
    if normalized == '/Workspace':
        return '/'
    if normalized.startswith('/Workspace/'):
        return normalized[len('/Workspace') :]
    return normalized


def _get_temp_notebook_path(run_label: str) -> str:
    username = get_current_username()
    base = f'/Users/{username}' if username else '/'
    return f'{base}/.ai_dev_kit_tmp/{run_label}'


def _render_notebook_source(code: str, language: str) -> str:
    if language == 'sql':
        header = '-- Databricks notebook source'
    else:
        header = '# Databricks notebook source'
    return f'{header}\n{code}'


def _upload_temp_notebook(code: str, language: str, workspace_path: str) -> None:
    w = get_workspace_client()
    api_path = _normalize_workspace_path(workspace_path)
    parent = api_path.rsplit('/', 1)[0] or '/'
    w.workspace.mkdirs(parent)
    w.workspace.import_(
        path=api_path,
        content=base64.b64encode(_render_notebook_source(code, language).encode('utf-8')).decode('utf-8'),
        language=_LANGUAGE_MAP[language],
        format=ImportFormat.SOURCE,
        overwrite=True,
    )


def _cleanup_temp_notebook(workspace_path: str) -> None:
    try:
        get_workspace_client().workspace.delete(path=_normalize_workspace_path(workspace_path), recursive=False)
    except Exception as exc:
        logger.debug('Cleanup of %s failed: %s', workspace_path, exc)


def _get_run_output(task_run_id: int) -> Dict[str, Optional[str]]:
    run_output = get_workspace_client().jobs.get_run_output(run_id=task_run_id)
    output = None
    error = None
    if getattr(run_output, 'notebook_output', None) and run_output.notebook_output.result:
        output = run_output.notebook_output.result
    if getattr(run_output, 'logs', None):
        output = f'{output}\n\n--- Logs ---\n{run_output.logs}' if output else run_output.logs
    if getattr(run_output, 'error', None):
        pieces = [run_output.error]
        if getattr(run_output, 'error_trace', None):
            pieces.append(run_output.error_trace)
        error = '\n\n'.join(pieces)
    return {'output': output, 'error': error}


def run_file_on_serverless(
    file_path: str,
    language: Optional[str] = None,
    timeout: int = 1800,
    run_name: Optional[str] = None,
    cleanup: bool = True,
    workspace_path: Optional[str] = None,
) -> ServerlessRunResult:
    """Read a local file and execute it as a one-time serverless Jobs run."""
    path = Path(file_path)
    if not path.exists():
        return ServerlessRunResult(success=False, error=f'File not found: {file_path}', state='INVALID_INPUT')

    code = path.read_text(encoding='utf-8')
    if not code.strip():
        return ServerlessRunResult(success=False, error=f'File is empty: {file_path}', state='INVALID_INPUT')

    detected_language = (language or _FILE_LANGUAGE_MAP.get(path.suffix.lower()) or '').lower()
    if detected_language not in _LANGUAGE_MAP:
        return ServerlessRunResult(
            success=False,
            error=f'Unsupported file type for serverless execution: {path.suffix or file_path}',
            state='INVALID_INPUT',
        )

    return run_code_on_serverless(
        code=code,
        language=detected_language,
        timeout=timeout,
        run_name=run_name,
        cleanup=cleanup,
        workspace_path=workspace_path,
    )


def run_code_on_serverless(
    code: str,
    language: str = 'python',
    timeout: int = 1800,
    run_name: Optional[str] = None,
    cleanup: bool = True,
    workspace_path: Optional[str] = None,
) -> ServerlessRunResult:
    """Execute code as a one-time Databricks Jobs serverless run."""
    if not code or not code.strip():
        return ServerlessRunResult(success=False, error='Code cannot be empty.', state='INVALID_INPUT')

    language = language.lower()
    if language not in _LANGUAGE_MAP:
        return ServerlessRunResult(
            success=False,
            error=f"Unsupported language: {language!r}. Must be 'python' or 'sql'.",
            state='INVALID_INPUT',
        )

    unique_id = uuid.uuid4().hex[:12]
    notebook_path = workspace_path or _get_temp_notebook_path(f'serverless_{unique_id}')
    cleanup = cleanup if workspace_path is None else False
    run_name = run_name or f'ai_dev_kit_serverless_{unique_id}'
    start_time = time.time()
    w = get_workspace_client()

    try:
        _upload_temp_notebook(code, language, notebook_path)
        wait = w.jobs.submit(
            run_name=run_name,
            tasks=[
                SubmitTask(
                    task_key='main',
                    notebook_task=NotebookTask(notebook_path=_normalize_workspace_path(notebook_path)),
                    environment_key='Default',
                )
            ],
            environments=[JobEnvironment(environment_key='Default', spec=Environment(client='1'))],
        )

        run_id = getattr(wait, 'run_id', None) or getattr(getattr(wait, 'response', None), 'run_id', None)
        run = wait.result(timeout=datetime.timedelta(seconds=timeout))
        run_url = run.run_page_url or (w.jobs.get_run(run_id=run_id).run_page_url if run_id else None)
        task_run_id = run.tasks[0].run_id if run.tasks else None
        output_data = _get_run_output(task_run_id) if task_run_id else {'output': None, 'error': None}
        result_state = run.state.result_state if run.state else None
        state_str = result_state.value if result_state else 'UNKNOWN'
        elapsed = round(time.time() - start_time, 2)

        if result_state == RunResultState.SUCCESS or state_str == RunResultState.SUCCESS.value:
            return ServerlessRunResult(
                success=True,
                output=output_data['output'] or 'Success (no output)',
                run_id=run_id,
                run_url=run_url,
                duration_seconds=elapsed,
                state=state_str,
                message=f'Code executed successfully on serverless Jobs in {round(elapsed, 1)}s.',
                workspace_path=notebook_path if workspace_path else None,
            )

        return ServerlessRunResult(
            success=False,
            error=output_data['error']
            or (run.state.state_message if run.state else f'Run ended with state: {state_str}'),
            run_id=run_id,
            run_url=run_url,
            duration_seconds=elapsed,
            state=state_str,
            message=f'Serverless run failed with state {state_str}. Check {run_url} for details.',
            workspace_path=notebook_path if workspace_path else None,
        )
    except TimeoutError:
        elapsed = round(time.time() - start_time, 2)
        return ServerlessRunResult(
            success=False,
            error=f'Run timed out after {timeout}s.',
            duration_seconds=elapsed,
            state='TIMEDOUT',
        )
    finally:
        if cleanup:
            _cleanup_temp_notebook(notebook_path)
