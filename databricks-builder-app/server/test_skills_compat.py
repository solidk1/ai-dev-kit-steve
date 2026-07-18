"""Compatibility tests for Builder App skill-to-tool filtering."""

import asyncio
import importlib.util
from pathlib import Path


def _load_skills_manager():
    module_path = Path(__file__).parent / 'services' / 'skills_manager.py'
    spec = importlib.util.spec_from_file_location('builder_skills_manager', module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_current_consolidated_tools_are_blocked_when_skills_are_disabled():
    """Block current domain tools when their corresponding skills are disabled."""
    get_allowed_mcp_tools = _load_skills_manager().get_allowed_mcp_tools
    tools = [
        'mcp__databricks__manage_dashboard',
        'mcp__databricks__manage_genie',
        'mcp__databricks__manage_pipeline',
        'mcp__databricks__manage_jobs',
        'mcp__databricks__manage_app',
        'mcp__databricks__manage_serving_endpoint',
        'mcp__databricks__manage_volume_files',
        'mcp__databricks__manage_lakebase_database',
        'mcp__databricks__manage_metric_views',
        'mcp__databricks__manage_vs_index',
        'mcp__databricks__generate_and_upload_pdf',
        'mcp__databricks__execute_sql',
    ]

    allowed = get_allowed_mcp_tools(tools, enabled_skills=['databricks-python-sdk'])

    assert allowed == ['mcp__databricks__execute_sql']


def test_current_consolidated_tool_is_enabled_by_renamed_app_skill():
    """Recognize the upstream databricks-apps-python skill rename."""
    get_allowed_mcp_tools = _load_skills_manager().get_allowed_mcp_tools
    tools = [
        'mcp__databricks__manage_app',
        'mcp__databricks__manage_dashboard',
    ]

    allowed = get_allowed_mcp_tools(tools, enabled_skills=['databricks-apps-python'])

    assert allowed == ['mcp__databricks__manage_app']


def test_shared_tool_remains_available_when_any_claiming_skill_is_enabled():
    """Keep shared tools when at least one enabled skill claims them."""
    get_allowed_mcp_tools = _load_skills_manager().get_allowed_mcp_tools
    tools = [
        'mcp__databricks__manage_genie',
        'mcp__databricks__manage_jobs',
        'mcp__databricks__manage_serving_endpoint',
    ]

    agent_bricks_tools = get_allowed_mcp_tools(
        tools,
        enabled_skills=['databricks-agent-bricks'],
    )
    model_serving_tools = get_allowed_mcp_tools(
        tools,
        enabled_skills=['databricks-model-serving'],
    )

    assert agent_bricks_tools == ['mcp__databricks__manage_genie']
    assert model_serving_tools == [
        'mcp__databricks__manage_jobs',
        'mcp__databricks__manage_serving_endpoint',
    ]


def test_all_mapped_skills_and_tools_exist_in_merged_sources():
    """Keep mapping keys synchronized with upstream skill and MCP registries."""
    from databricks_mcp_server.server import mcp
    from server.mcp_registry import get_registered_mcp_tools

    skills_manager = _load_skills_manager()
    registered_tools = asyncio.run(get_registered_mcp_tools(mcp))
    mapped_tools = {
        tool_name
        for tool_names in skills_manager.SKILL_TOOL_MAPPING.values()
        for tool_name in tool_names
    }
    available_skills = {
        path.parent.name
        for path in skills_manager.SKILLS_SOURCE_DIR.glob('*/SKILL.md')
    }

    assert mapped_tools <= set(registered_tools)
    assert set(skills_manager.SKILL_TOOL_MAPPING) <= available_skills
