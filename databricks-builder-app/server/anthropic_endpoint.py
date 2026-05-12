"""Helpers for selecting the Databricks Anthropic-compatible base URL."""

import os
import re

_AI_GATEWAY_ENV_VARS = (
    'DATABRICKS_AI_GATEWAY_BASE_URL',
    'AI_GATEWAY_BASE_URL',
)

_AZURE_WORKSPACE_RE = re.compile(r'^adb-([^.]+)\.[^.]+\.azuredatabricks\.net$')
_CLOUD_WORKSPACE_RE = re.compile(r'^([^.]+)\.cloud\.databricks\.com$')

def build_databricks_anthropic_base_url(databricks_host: str | None = None) -> str | None:
    """Return the preferred Databricks Anthropic-compatible base URL.

    Prefers an explicit override from the environment and otherwise derives the
    AI Gateway URL from the workspace host, falling back to the workspace
    serving endpoint when the host pattern is unknown.
    """
    for env_var in _AI_GATEWAY_ENV_VARS:
        configured_url = os.getenv(env_var)
        if configured_url:
            return configured_url.rstrip('/')

    if not databricks_host:
        return None

    normalized = databricks_host.strip().rstrip('/')
    if not normalized.startswith(('https://', 'http://')):
        normalized = f'https://{normalized}'

    host = normalized.replace('https://', '').replace('http://', '').rstrip('/')

    azure_match = _AZURE_WORKSPACE_RE.match(host)
    if azure_match:
        return f'https://{azure_match.group(1)}.1.ai-gateway.azuredatabricks.net/anthropic'

    cloud_match = _CLOUD_WORKSPACE_RE.match(host)
    if cloud_match:
        return f'https://{cloud_match.group(1)}.ai-gateway.cloud.databricks.com/anthropic'

    return f'https://{host}/serving-endpoints/anthropic'


def get_databricks_llm_provider(base_url: str | None) -> str:
    """Return a provider label for tracing and logs."""
    if base_url and 'ai-gateway' in base_url:
        return 'databricks-ai-gateway'
    return 'databricks-fmapi'


def select_databricks_anthropic_model(
    *,
    app_auth_only: bool,
    model: str | None = None,
    small_model: str | None = None,
) -> str:
    """Pick the model that matches the available Databricks auth context.

    When a user-scoped token is unavailable, the app runs on its own service
    principal. In that mode we prefer an app-safe fallback model so the app can
    keep working even if the default user model is not granted to the app SP.
    """
    primary_model = model or os.getenv('ANTHROPIC_MODEL', 'databricks-claude-opus-4-6')
    fallback_model = (
        os.getenv('ANTHROPIC_APP_AUTH_MODEL')
        or small_model
        or os.getenv('ANTHROPIC_MODEL_MINI')
        or primary_model
    )
    return fallback_model if app_auth_only else primary_model
