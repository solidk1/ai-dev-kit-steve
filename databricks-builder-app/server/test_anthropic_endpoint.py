def test_build_databricks_anthropic_base_url_derives_ai_gateway_from_azure_workspace(monkeypatch):
    from server.anthropic_endpoint import build_databricks_anthropic_base_url

    monkeypatch.delenv('DATABRICKS_AI_GATEWAY_BASE_URL', raising=False)
    monkeypatch.delenv('AI_GATEWAY_BASE_URL', raising=False)

    assert build_databricks_anthropic_base_url('https://adb-7405612347557713.13.azuredatabricks.net') == (
        'https://7405612347557713.1.ai-gateway.azuredatabricks.net/anthropic'
    )


def test_build_databricks_anthropic_base_url_falls_back_to_workspace_serving_endpoint(monkeypatch):
    from server.anthropic_endpoint import build_databricks_anthropic_base_url

    monkeypatch.delenv('DATABRICKS_AI_GATEWAY_BASE_URL', raising=False)
    monkeypatch.delenv('AI_GATEWAY_BASE_URL', raising=False)

    assert build_databricks_anthropic_base_url('https://workspace.example.internal') == (
        'https://workspace.example.internal/serving-endpoints/anthropic'
    )


def test_build_databricks_anthropic_base_url_adds_https_when_scheme_missing(monkeypatch):
    from server.anthropic_endpoint import build_databricks_anthropic_base_url

    monkeypatch.delenv('DATABRICKS_AI_GATEWAY_BASE_URL', raising=False)
    monkeypatch.delenv('AI_GATEWAY_BASE_URL', raising=False)

    assert build_databricks_anthropic_base_url('adb-123.4.azuredatabricks.net') == (
        'https://123.1.ai-gateway.azuredatabricks.net/anthropic'
    )


def test_select_databricks_anthropic_model_prefers_primary_for_user_authorized_mode(monkeypatch):
    from server.anthropic_endpoint import select_databricks_anthropic_model

    monkeypatch.setenv('ANTHROPIC_MODEL', 'databricks-claude-opus-4-6')
    monkeypatch.setenv('ANTHROPIC_MODEL_MINI', 'databricks-claude-sonnet-4-6')
    monkeypatch.setenv('ANTHROPIC_APP_AUTH_MODEL', 'databricks-claude-sonnet-4-6')

    assert select_databricks_anthropic_model(app_auth_only=False) == 'databricks-claude-opus-4-6'


def test_select_databricks_anthropic_model_prefers_app_auth_model_for_sp_fallback(monkeypatch):
    from server.anthropic_endpoint import select_databricks_anthropic_model

    monkeypatch.setenv('ANTHROPIC_MODEL', 'databricks-claude-opus-4-6')
    monkeypatch.setenv('ANTHROPIC_MODEL_MINI', 'databricks-claude-sonnet-4-6')
    monkeypatch.setenv('ANTHROPIC_APP_AUTH_MODEL', 'databricks-claude-sonnet-4-6')

    assert select_databricks_anthropic_model(app_auth_only=True) == 'databricks-claude-sonnet-4-6'
