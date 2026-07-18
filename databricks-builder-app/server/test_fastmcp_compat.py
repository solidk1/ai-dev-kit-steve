"""Compatibility tests for FastMCP registry and Builder App adapters."""

import asyncio

import pytest


@pytest.mark.anyio
async def test_get_registered_mcp_tools_uses_public_list_tools():
    """Map FastMCP 3 tools by their public names."""
    from server.mcp_registry import get_registered_mcp_tools

    class Tool:
        def __init__(self, name):
            self.name = name

    class FakeMcp:
        async def list_tools(self):
            return [Tool('alpha'), Tool('beta')]

    tools = await get_registered_mcp_tools(FakeMcp())

    assert list(tools.keys()) == ['alpha', 'beta']


def test_invoke_mcp_tool_sync_accepts_sync_callable():
    """Return values from synchronous registered tool functions."""
    from server.mcp_registry import invoke_mcp_tool_sync

    assert invoke_mcp_tool_sync(lambda value: value + 1, {'value': 2}) == 3


def test_invoke_mcp_tool_sync_resolves_async_callable():
    """Resolve asynchronous registered tool functions in a worker thread."""
    from server.mcp_registry import invoke_mcp_tool_sync

    async def async_tool(value):
        return value + 1

    assert invoke_mcp_tool_sync(async_tool, {'value': 2}) == 3


@pytest.mark.anyio
async def test_current_databricks_mcp_registry_loads_consolidated_tools():
    """Discover canonical names from the actual merged FastMCP registry."""
    from databricks_mcp_server.server import mcp
    from server.mcp_registry import get_registered_mcp_tools

    tools = await get_registered_mcp_tools(mcp)

    expected = {
        'execute_code',
        'manage_app',
        'manage_dashboard',
        'manage_pipeline',
        'manage_volume_files',
    }
    assert expected <= set(tools)


def test_current_async_fastmcp_tool_executes_through_sync_worker_adapter():
    """Execute an actual FastMCP 3 async tool through the sync adapter."""
    from databricks_mcp_server.server import mcp
    from server.mcp_registry import get_registered_mcp_tools, invoke_mcp_tool_sync

    tools = asyncio.run(get_registered_mcp_tools(mcp))
    result = invoke_mcp_tool_sync(tools['execute_code'].fn, {})

    assert result == {
        'success': False,
        'error': "Either 'code' or 'file_path' must be provided.",
    }


@pytest.mark.anyio
async def test_builder_sdk_wrapper_executes_current_async_fastmcp_tool():
    """Execute an actual merged MCP tool through the Claude SDK wrapper."""
    from server.services.databricks_tools import _get_all_sdk_tools

    sdk_tools, tool_names = await _get_all_sdk_tools()
    execute_code = sdk_tools[tool_names.index('mcp__databricks__execute_code')]

    result = await execute_code.handler({})

    assert "Either 'code' or 'file_path' must be provided." in result['content'][0]['text']
