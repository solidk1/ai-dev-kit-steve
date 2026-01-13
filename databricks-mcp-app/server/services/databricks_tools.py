"""Dynamic tool loader for Databricks tools.

Scans FastMCP tools from databricks-mcp-server and creates
in-process SDK tools for the Claude Code Agent SDK.
"""

import asyncio
import json
import logging
from typing import Any

from claude_agent_sdk import tool, create_sdk_mcp_server

logger = logging.getLogger(__name__)


def load_databricks_tools():
    """Dynamically scan FastMCP tools and create in-process SDK MCP server.

    Returns:
        Tuple of (server_config, tool_names) where:
        - server_config: McpSdkServerConfig for ClaudeAgentOptions.mcp_servers
        - tool_names: List of tool names in mcp__databricks__* format
    """
    # Import triggers @mcp.tool registration
    from databricks_mcp_server.server import mcp
    from databricks_mcp_server.tools import sql, compute, file, pipelines  # noqa: F401

    sdk_tools = []
    tool_names = []

    for name, mcp_tool in mcp._tool_manager._tools.items():
        input_schema = _convert_schema(mcp_tool.parameters)
        sdk_tool = _make_wrapper(name, mcp_tool.description, input_schema, mcp_tool.fn)
        sdk_tools.append(sdk_tool)
        tool_names.append(f'mcp__databricks__{name}')

    logger.info(f'Loaded {len(sdk_tools)} Databricks tools: {[n.split("__")[-1] for n in tool_names]}')

    server = create_sdk_mcp_server(name='databricks', tools=sdk_tools)
    return server, tool_names


def _convert_schema(json_schema: dict) -> dict[str, type]:
    """Convert JSON schema to SDK simple format: {"param": type}"""
    type_map = {
        'string': str,
        'integer': int,
        'number': float,
        'boolean': bool,
        'array': list,
        'object': dict,
    }
    result = {}

    for param, spec in json_schema.get('properties', {}).items():
        # Handle anyOf (optional types like "string | null")
        if 'anyOf' in spec:
            for opt in spec['anyOf']:
                if opt.get('type') != 'null':
                    result[param] = type_map.get(opt.get('type'), str)
                    break
        else:
            result[param] = type_map.get(spec.get('type'), str)

    return result


def _make_wrapper(name: str, description: str, schema: dict, fn):
    """Create SDK tool wrapper for a FastMCP function.

    The wrapper runs the sync function in a thread pool to avoid
    blocking the async event loop.
    """

    @tool(name, description, schema)
    async def wrapper(args: dict[str, Any]) -> dict[str, Any]:
        import sys
        print(f'[MCP TOOL] {name} called with args: {args}', file=sys.stderr, flush=True)
        logger.info(f'[MCP] Tool {name} called with args: {args}')
        try:
            # FastMCP tools are sync - run in thread pool
            print(f'[MCP TOOL] Running {name} in thread pool...', file=sys.stderr, flush=True)
            result = await asyncio.to_thread(fn, **args)
            result_str = json.dumps(result, default=str)
            print(f'[MCP TOOL] {name} completed, result length: {len(result_str)}', file=sys.stderr, flush=True)
            return {'content': [{'type': 'text', 'text': result_str}]}
        except Exception as e:
            print(f'[MCP TOOL] {name} FAILED: {e}', file=sys.stderr, flush=True)
            logger.exception(f'[MCP] Tool {name} failed: {e}')
            return {'content': [{'type': 'text', 'text': f'Error: {e}'}], 'is_error': True}

    return wrapper
