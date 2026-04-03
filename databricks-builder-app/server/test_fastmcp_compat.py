import pytest


@pytest.mark.anyio
async def test_get_registered_mcp_tools_uses_public_get_tools():
    from server.mcp_registry import get_registered_mcp_tools

    class Tool:
        def __init__(self, name):
            self.name = name

    class FakeMcp:
        async def get_tools(self):
            return {
                'alpha': Tool('alpha'),
                'beta': Tool('beta'),
            }

    tools = await get_registered_mcp_tools(FakeMcp())

    assert list(tools.keys()) == ['alpha', 'beta']


@pytest.mark.anyio
async def test_get_registered_mcp_tools_accepts_list_from_public_api():
    from server.mcp_registry import get_registered_mcp_tools

    class Tool:
        def __init__(self, key):
            self.key = key

    class FakeMcp:
        async def list_tools(self):
            return [Tool('alpha'), Tool('beta')]

    tools = await get_registered_mcp_tools(FakeMcp())

    assert list(tools.keys()) == ['alpha', 'beta']


@pytest.mark.anyio
async def test_get_registered_mcp_tools_falls_back_to_legacy_tool_manager():
    from server.mcp_registry import get_registered_mcp_tools

    class Tool:
        def __init__(self, name):
            self.name = name

    class ToolManager:
        def __init__(self):
            self._tools = {
                'legacy': Tool('legacy'),
            }

    class FakeMcp:
        _tool_manager = ToolManager()

    tools = await get_registered_mcp_tools(FakeMcp())

    assert list(tools.keys()) == ['legacy']


@pytest.mark.anyio
async def test_get_registered_mcp_tools_scans_modules_as_last_resort():
    from server.mcp_registry import get_registered_mcp_tools

    class Tool:
        def __init__(self, key):
            self.key = key
            self.fn = lambda: None
            self.parameters = {}

    class EmptyMcp:
        pass

    class FakeModule:
        exported_tool = Tool('module_tool')

    tools = await get_registered_mcp_tools(EmptyMcp(), tool_modules=[FakeModule])

    assert list(tools.keys()) == ['module_tool']
