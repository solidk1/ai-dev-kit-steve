"""Claude Code Agent service for managing agent sessions.

Uses the claude-agent-sdk to create and manage Claude Code agent sessions
with directory-scoped file permissions and Databricks tools.

Databricks tools are loaded in-process from databricks-mcp-server using
the SDK tool wrapper. Auth is handled via contextvars for multi-user support.

NOTE: There is a known bug in claude-agent-sdk (issue #462) where the subprocess
transport fails in FastAPI/uvicorn contexts when using MCP servers.
"""

import logging
import traceback
import sys
from pathlib import Path
from typing import AsyncIterator

from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import (
  AssistantMessage,
  ResultMessage,
  StreamEvent,
  SystemMessage,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
)
from databricks_tools_core.auth import set_databricks_auth, clear_databricks_auth

from .backup_manager import ensure_project_directory as _ensure_project_directory
from .databricks_tools import load_databricks_tools
from .system_prompt import get_system_prompt

logger = logging.getLogger(__name__)

# Built-in Claude Code tools
BUILTIN_TOOLS = [
  'Read',
  'Write',
  'Edit',
#  'Bash',
  'Glob',
  'Grep',
  'Skill',  # For loading skills
]

# Cached Databricks tools (loaded once)
_databricks_server = None
_databricks_tool_names = None


def get_databricks_tools():
  """Get cached Databricks tools, loading if needed."""
  global _databricks_server, _databricks_tool_names
  if _databricks_server is None:
    _databricks_server, _databricks_tool_names = load_databricks_tools()
  return _databricks_server, _databricks_tool_names


def get_project_directory(project_id: str) -> Path:
  """Get the directory path for a project.

  If the directory doesn't exist, attempts to restore from backup.
  If no backup exists, creates an empty directory.

  Args:
      project_id: The project UUID

  Returns:
      Path to the project directory
  """
  return _ensure_project_directory(project_id)


async def stream_agent_response(
  project_id: str,
  message: str,
  session_id: str | None = None,
  cluster_id: str | None = None,
  default_catalog: str | None = None,
  default_schema: str | None = None,
  databricks_host: str | None = None,
  databricks_token: str | None = None,
) -> AsyncIterator[dict]:
  """Stream Claude agent response with all event types.

  Uses the simple query() function for stateless interactions.
  Yields normalized event dicts for the frontend.

  Args:
      project_id: The project UUID
      message: User message to send
      session_id: Optional session ID for resuming conversations
      cluster_id: Optional Databricks cluster ID for code execution
      databricks_host: Databricks workspace URL for auth context
      databricks_token: User's Databricks access token for auth context

  Yields:
      Event dicts with 'type' field for frontend consumption
  """
  project_dir = get_project_directory(project_id)

  if session_id:
    logger.info(f'Resuming session {session_id} in {project_dir}: {message[:100]}...')
  else:
    logger.info(f'Starting new session in {project_dir}: {message[:100]}...')

  # Set auth context for this request (enables per-user Databricks auth)
  set_databricks_auth(databricks_host, databricks_token)

  try:
    # Build allowed tools list
    allowed_tools = BUILTIN_TOOLS.copy()

    # Get in-process Databricks tools
    databricks_server, databricks_tool_names = get_databricks_tools()
    allowed_tools.extend(databricks_tool_names)
    logger.info(f'Databricks tools enabled: {len(databricks_tool_names)} tools')

    # Generate system prompt with available skills, cluster, and catalog/schema context
    system_prompt = get_system_prompt(
      cluster_id=cluster_id,
      default_catalog=default_catalog,
      default_schema=default_schema,
    )

    options = ClaudeAgentOptions(
      cwd=str(project_dir),
      allowed_tools=allowed_tools,
      permission_mode='acceptEdits',  # Auto-accept file edits
      resume=session_id,  # Resume from previous session if provided
      mcp_servers={'databricks': databricks_server},  # In-process SDK tools
      system_prompt=system_prompt,  # Databricks-focused system prompt
      setting_sources=["user", "project"],  # Load Skills from filesystem
    )

    # Workaround for SDK bug: use async generator for prompt when using MCP servers
    # See: https://github.com/anthropics/claude-agent-sdk-python/issues/386
    async def prompt_generator():
      yield {'type': 'user', 'message': {'role': 'user', 'content': message}}

    async for msg in query(prompt=prompt_generator(), options=options):
      # Handle different message types
      if isinstance(msg, AssistantMessage):
        # Process content blocks
        for block in msg.content:
          if isinstance(block, TextBlock):
            yield {
              'type': 'text',
              'text': block.text,
            }
          elif isinstance(block, ThinkingBlock):
            yield {
              'type': 'thinking',
              'thinking': block.thinking,
            }
          elif isinstance(block, ToolUseBlock):
            yield {
              'type': 'tool_use',
              'tool_id': block.id,
              'tool_name': block.name,
              'tool_input': block.input,
            }
          elif isinstance(block, ToolResultBlock):
            yield {
              'type': 'tool_result',
              'tool_use_id': block.tool_use_id,
              'content': block.content,
              'is_error': block.is_error,
            }

      elif isinstance(msg, ResultMessage):
        yield {
          'type': 'result',
          'session_id': msg.session_id,
          'duration_ms': msg.duration_ms,
          'total_cost_usd': msg.total_cost_usd,
          'is_error': msg.is_error,
          'num_turns': msg.num_turns,
        }

      elif isinstance(msg, SystemMessage):
        yield {
          'type': 'system',
          'subtype': msg.subtype,
          'data': msg.data if hasattr(msg, 'data') else None,
        }

      elif isinstance(msg, UserMessage):
        # Echo of user message, can skip or forward
        pass

      elif isinstance(msg, StreamEvent):
        # Raw stream event
        yield {
          'type': 'stream_event',
          'event': msg.event,
          'session_id': msg.session_id,
        }

  except Exception as e:
    # Log full traceback for debugging
    error_msg = f'Error during Claude query: {e}'
    full_traceback = traceback.format_exc()

    # Use print to stderr for immediate visibility
    print(f'\n{"="*60}', file=sys.stderr)
    print(f'AGENT ERROR: {error_msg}', file=sys.stderr)
    print(full_traceback, file=sys.stderr)

    # Also log normally
    logger.error(error_msg)
    logger.error(full_traceback)

    # If it's an ExceptionGroup, log all sub-exceptions
    if hasattr(e, 'exceptions'):
      for i, sub_exc in enumerate(e.exceptions):
        sub_tb = ''.join(traceback.format_exception(type(sub_exc), sub_exc, sub_exc.__traceback__))
        print(f'Sub-exception {i}: {sub_exc}', file=sys.stderr)
        print(sub_tb, file=sys.stderr)
        logger.error(f'Sub-exception {i}: {sub_exc}')
        logger.error(sub_tb)

    print(f'{"="*60}\n', file=sys.stderr)

    yield {
      'type': 'error',
      'error': str(e),
    }
  finally:
    # Always clear auth context when done
    clear_databricks_auth()


# Keep simple aliases for backward compatibility
async def simple_query(project_id: str, message: str) -> AsyncIterator[dict]:
  """Simple stateless query to Claude within a project directory."""
  async for event in stream_agent_response(project_id, message):
    yield event
