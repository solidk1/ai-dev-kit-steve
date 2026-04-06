"""Jobs-backed serverless execution helpers."""

import base64
import datetime
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote

from databricks.sdk.errors.sdk import OperationFailed
from databricks.sdk.service.compute import Environment
from databricks.sdk.service.jobs import JobEnvironment, NotebookTask, RunResultState, SubmitTask
from databricks.sdk.service.workspace import ImportFormat, Language

from ..auth import get_current_username, get_workspace_client

logger = logging.getLogger(__name__)
_INLINE_WHITESPACE_RE = re.compile(r'[ \t\f\v]+')
_NOTEBOOK_MODEL_RE = re.compile(r"__DATABRICKS_NOTEBOOK_MODEL = '([^']+)';")

_LANGUAGE_MAP = {
    'python': Language.PYTHON,
    'sql': Language.SQL,
}

_FILE_LANGUAGE_MAP = {
    '.py': 'python',
    '.sql': 'sql',
}


class _NotebookHTMLTextExtractor(HTMLParser):
    """Convert exported notebook HTML into readable plain text."""

    _BLOCK_TAGS = {
        'article',
        'blockquote',
        'div',
        'dl',
        'fieldset',
        'figcaption',
        'figure',
        'footer',
        'form',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'header',
        'main',
        'nav',
        'ol',
        'p',
        'pre',
        'section',
        'ul',
    }

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip_depth = 0
        self._row_has_cells = False

    def _append(self, text: str) -> None:
        if text:
            self._parts.append(text)

    def _append_newline(self, count: int = 1) -> None:
        if count <= 0:
            return
        trailing_newlines = 0
        if self._parts:
            trailing_newlines = len(self._parts[-1]) - len(self._parts[-1].rstrip('\n'))
        needed = max(count - trailing_newlines, 0)
        if needed:
            self._parts.append('\n' * needed)

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in {'script', 'style'}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == 'br':
            self._append_newline()
        elif tag == 'li':
            self._append_newline()
            self._append('- ')
        elif tag == 'tr':
            self._append_newline()
            self._row_has_cells = False
        elif tag in {'td', 'th'}:
            if self._row_has_cells:
                self._append(' | ')
            self._row_has_cells = True

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in {'script', 'style'}:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag == 'tr':
            self._append_newline()
            self._row_has_cells = False
        elif tag in self._BLOCK_TAGS:
            self._append_newline(2)

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth:
            return
        text = unescape(data)
        if text:
            self._append(text)

    def get_text(self) -> str:
        return ''.join(self._parts)


def _normalize_rendered_text(text: str | None) -> str | None:
    """Collapse parser output into readable text while preserving paragraphs."""
    if not text:
        return None

    normalized_lines: list[str] = []
    pending_blank_lines = 0
    for raw_line in text.replace('\r', '\n').split('\n'):
        line = _INLINE_WHITESPACE_RE.sub(' ', raw_line).strip()
        if not line:
            pending_blank_lines = min(pending_blank_lines + 1, 2)
            continue
        if normalized_lines and pending_blank_lines:
            normalized_lines.extend([''] * min(pending_blank_lines, 1))
        pending_blank_lines = 0
        normalized_lines.append(line)

    normalized = '\n'.join(normalized_lines).strip()
    return normalized or None


def _render_exported_notebook_view_as_text(content: str) -> str | None:
    """Convert exported notebook HTML to clean plain text."""
    if not content or not content.strip():
        return None
    if '<' not in content or '>' not in content:
        return _normalize_rendered_text(content)

    parser = _NotebookHTMLTextExtractor()
    parser.feed(content)
    parser.close()
    return _normalize_rendered_text(parser.get_text())


def _looks_like_databricks_export_title(text: str | None) -> bool:
    """Ignore export fallbacks that only captured the notebook page title."""
    normalized = (text or '').strip()
    return bool(normalized) and '\n' not in normalized and normalized.endswith(' - Databricks')


def _decode_exported_notebook_model(content: str) -> dict[str, Any] | None:
    """Decode the embedded notebook model from an exported run page."""
    match = _NOTEBOOK_MODEL_RE.search(content)
    if not match:
        return None

    try:
        encoded = match.group(1)
        quoted_json = base64.b64decode(encoded).decode('utf-8')
        return json.loads(unquote(quoted_json))
    except Exception as exc:
        logger.debug('Failed to decode exported notebook model: %s', exc)
        return None


def _extract_exported_notebook_model_output(content: str) -> dict[str, str | None]:
    """Read command results from the embedded Databricks notebook model."""
    model = _decode_exported_notebook_model(content)
    if not isinstance(model, dict):
        return {'output': None, 'error': None}

    commands = model.get('commands')
    if not isinstance(commands, list):
        return {'output': None, 'error': None}

    for command in reversed(commands):
        if not isinstance(command, dict):
            continue

        command_output = None
        command_error = None

        results = command.get('results')
        if isinstance(results, dict):
            result_type = results.get('type')
            result_data = results.get('data')
            if isinstance(result_data, str):
                output = _normalize_rendered_text(result_data)
                if output and not _looks_like_databricks_export_title(output):
                    command_output = output
            elif result_type == 'listResults' and isinstance(result_data, list):
                rendered_parts: list[str] = []
                for item in result_data:
                    if not isinstance(item, dict):
                        continue
                    item_data = item.get('data')
                    if isinstance(item_data, str):
                        rendered = _normalize_rendered_text(item_data)
                        if rendered:
                            rendered_parts.append(rendered)
                if rendered_parts:
                    command_output = '\n'.join(rendered_parts)

        for key in ('error', 'errorSummary', 'resultDbfsErrorMessage'):
            value = command.get(key)
            if isinstance(value, str):
                error = _normalize_rendered_text(value)
                if error:
                    command_error = error
                    break

        if command_output or command_error:
            return {'output': command_output, 'error': command_error}

    return {'output': None, 'error': None}


def _get_exported_run_data(run_id: int) -> Dict[str, Optional[str]]:
    """Best-effort extraction of output/error data from exported run content."""
    try:
        export = get_workspace_client().jobs.export_run(run_id=run_id)
    except Exception as exc:
        logger.debug('Failed to export serverless run %s: %s', run_id, exc)
        return {'output': None, 'error': None}

    views = getattr(export, 'views', None)
    if not isinstance(views, list):
        return {'output': None, 'error': None}

    for view in views:
        content = getattr(view, 'content', None)
        if isinstance(content, str):
            model_output = _extract_exported_notebook_model_output(content)
            if model_output['output'] or model_output['error']:
                return model_output

            rendered = _render_exported_notebook_view_as_text(content)
            if rendered and not _looks_like_databricks_export_title(rendered):
                return {'output': rendered, 'error': None}
    return {'output': None, 'error': None}


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
        return f'{header}\n{code}'

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


def _get_run_output(task_run_id: int, run_id: int | None = None) -> Dict[str, Optional[str]]:
    run_output = get_workspace_client().jobs.get_run_output(run_id=task_run_id)
    output = None
    error = None
    if getattr(run_output, 'notebook_output', None) and run_output.notebook_output.result:
        result = run_output.notebook_output.result
        output = result
    if run_id is not None and (not output or _looks_like_databricks_export_title(output)):
        exported = _get_exported_run_data(run_id)
        if _looks_like_databricks_export_title(output) and not exported['output']:
            output = None
        if exported['output'] and (not output or _looks_like_databricks_export_title(output)):
            output = exported['output']
        if not error and exported['error']:
            error = exported['error']
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
        try:
            run = wait.result(timeout=datetime.timedelta(seconds=timeout))
        except OperationFailed:
            if run_id is None:
                raise
            run = w.jobs.get_run(run_id=run_id)
        run_url = run.run_page_url or (w.jobs.get_run(run_id=run_id).run_page_url if run_id else None)
        task_run_id = run.tasks[0].run_id if run.tasks else None
        output_data = _get_run_output(task_run_id, run_id=run_id) if task_run_id else {'output': None, 'error': None}
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
            output=output_data['output'],
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
