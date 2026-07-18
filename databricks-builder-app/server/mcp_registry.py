"""Helpers for runtime MCP tool discovery and invocation."""

import asyncio
import inspect
from typing import Any


def invoke_mcp_tool_sync(fn: Any, kwargs: dict[str, Any]) -> Any:
    """Invoke a registered MCP function from a worker thread."""
    result = fn(**kwargs)
    if inspect.isawaitable(result):
        return asyncio.run(result)
    return result


async def get_registered_mcp_tools(mcp: Any) -> dict[str, Any]:
    """Return registered tools from the pinned FastMCP 3 public API."""
    return {tool.name: tool for tool in await mcp.list_tools()}
