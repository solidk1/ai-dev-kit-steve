"""Compatibility helpers for runtime MCP tool discovery."""

import inspect
from types import ModuleType
from typing import Any, Iterable


def _normalize_tool_mapping(raw_tools: Any) -> dict[str, Any]:
    """Convert several common FastMCP tool collection shapes into a dict."""
    if isinstance(raw_tools, dict):
        return raw_tools

    if isinstance(raw_tools, (list, tuple, set)):
        normalized: dict[str, Any] = {}
        for tool in raw_tools:
            key = getattr(tool, 'key', None) or getattr(tool, 'name', None)
            if key:
                normalized[str(key)] = tool
        if normalized:
            return normalized

    return {}


async def _call_maybe_async(value: Any) -> Any:
    """Call a callable and await it if needed."""
    result = value()
    if inspect.isawaitable(result):
        return await result
    return result


def _scan_tool_modules(tool_modules: Iterable[ModuleType] | None) -> dict[str, Any]:
    """Fallback: collect decorated tool objects directly from imported modules."""
    if not tool_modules:
        return {}

    normalized: dict[str, Any] = {}
    for module in tool_modules:
        for candidate in vars(module).values():
            if not hasattr(candidate, 'fn') or not hasattr(candidate, 'parameters'):
                continue
            key = getattr(candidate, 'key', None) or getattr(candidate, 'name', None)
            if key:
                normalized[str(key)] = candidate
    return normalized


async def get_registered_mcp_tools(
    mcp: Any,
    tool_modules: Iterable[ModuleType] | None = None,
) -> dict[str, Any]:
    """Return registered FastMCP tools across FastMCP versions."""
    for attr in ('get_tools', 'list_tools'):
        getter = getattr(mcp, attr, None)
        if callable(getter):
            normalized = _normalize_tool_mapping(await _call_maybe_async(getter))
            if normalized:
                return normalized

    for attr in ('tools', '_tools'):
        normalized = _normalize_tool_mapping(getattr(mcp, attr, None))
        if normalized:
            return normalized

    for manager_attr in ('_tool_manager', 'tool_manager'):
        tool_manager = getattr(mcp, manager_attr, None)
        for attr in ('get_tools', 'list_tools'):
            getter = getattr(tool_manager, attr, None)
            if callable(getter):
                normalized = _normalize_tool_mapping(await _call_maybe_async(getter))
                if normalized:
                    return normalized

        normalized = _normalize_tool_mapping(getattr(tool_manager, '_tools', None))
        if normalized:
            return normalized

    normalized = _scan_tool_modules(tool_modules)
    if normalized:
        return normalized

    raise AttributeError('FastMCP server does not expose a compatible tool registry')
