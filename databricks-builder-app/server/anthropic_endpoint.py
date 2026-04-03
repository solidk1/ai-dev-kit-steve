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

    Prefers a derived AI Gateway URL from the workspace host and falls back to
    the workspace-scoped model serving endpoint for compatibility.
    """
    for env_var in _AI_GATEWAY_ENV_VARS:
        configured_url = os.getenv(env_var)
        if configured_url:
            return configured_url.rstrip('/')

    if not databricks_host:
        return None

    host = databricks_host.replace('https://', '').replace('http://', '').rstrip('/')

    azure_match = _AZURE_WORKSPACE_RE.match(host)
    if azure_match:
        return f'https://{azure_match.group(1)}.3.ai-gateway.azuredatabricks.net/anthropic'

    cloud_match = _CLOUD_WORKSPACE_RE.match(host)
    if cloud_match:
        return f'https://{cloud_match.group(1)}.ai-gateway.cloud.databricks.com/anthropic'

    return f'https://{host}/serving-endpoints/anthropic'


def get_databricks_llm_provider(base_url: str | None) -> str:
    """Return a provider label for tracing and logs."""
    if base_url and 'ai-gateway' in base_url:
        return 'databricks-ai-gateway'
    return 'databricks-fmapi'
