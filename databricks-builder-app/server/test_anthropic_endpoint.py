def test_build_databricks_anthropic_base_url_derives_ai_gateway_from_azure_workspace(monkeypatch):
    from server.anthropic_endpoint import build_databricks_anthropic_base_url

    monkeypatch.delenv('DATABRICKS_AI_GATEWAY_BASE_URL', raising=False)
    monkeypatch.delenv('AI_GATEWAY_BASE_URL', raising=False)

    assert build_databricks_anthropic_base_url('https://adb-7405612347557713.13.azuredatabricks.net') == (
        'https://7405612347557713.3.ai-gateway.azuredatabricks.net/anthropic'
    )


def test_build_databricks_anthropic_base_url_falls_back_to_workspace_serving_endpoint(monkeypatch):
    from server.anthropic_endpoint import build_databricks_anthropic_base_url

    monkeypatch.delenv('DATABRICKS_AI_GATEWAY_BASE_URL', raising=False)
    monkeypatch.delenv('AI_GATEWAY_BASE_URL', raising=False)

    assert build_databricks_anthropic_base_url('https://workspace.example.internal') == (
        'https://workspace.example.internal/serving-endpoints/anthropic'
    )
