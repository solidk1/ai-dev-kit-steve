"""Local Anthropic API proxy for Databricks FMAPI compatibility.

Strips fields unsupported by Databricks FMAPI before forwarding to the real endpoint.
Claude Code subprocesses point here instead of hitting the FMAPI directly.
"""

import json
import logging
from urllib.parse import urlencode, parse_qs

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter()

_PROXY_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=10.0)
_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Return a persistent httpx client (avoids per-request connection setup)."""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=_PROXY_TIMEOUT,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _http_client

# Body fields Databricks FMAPI rejects
_STRIP_BODY_FIELDS = {'context_management', 'betas', 'beta'}

# Query params Databricks FMAPI rejects
_STRIP_QUERY_PARAMS = {'beta'}

# Server-side FMAPI base URL, set by agent.py before the first request.
_fmapi_base_url: str = ''


def set_fmapi_base_url(url: str):
    """Set the upstream FMAPI base URL (called from agent setup)."""
    global _fmapi_base_url
    _fmapi_base_url = url


def _is_databricks_anthropic_upstream(base_url: str) -> bool:
    """Return whether the upstream is a Databricks Anthropic-compatible endpoint."""
    normalized = (base_url or '').lower()
    return 'ai-gateway.' in normalized or normalized.endswith('/serving-endpoints/anthropic')


def _rewrite_auth_headers(headers: dict[str, str], base_url: str) -> dict[str, str]:
    """Rewrite SDK-style API key auth into Databricks Bearer auth when needed."""
    if not _is_databricks_anthropic_upstream(base_url):
        return headers

    rewritten = dict(headers)
    api_key = rewritten.pop('x-api-key', '').strip()
    if api_key:
        rewritten['authorization'] = f'Bearer {api_key}'
    return rewritten


@router.api_route('/v1/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
async def proxy(path: str, request: Request):
    """Proxy to Databricks FMAPI, stripping unsupported fields."""
    real_base_url = _fmapi_base_url or request.headers.get('x-real-fmapi-url', '')
    if not real_base_url:
        return Response(
            content=json.dumps({'error': 'No upstream FMAPI URL configured'}),
            status_code=502,
            media_type='application/json',
        )

    # Strip unsupported query params (e.g. ?beta=true)
    filtered_params = {
        k: v[0] for k, v in parse_qs(request.url.query).items()
        if k.lower() not in _STRIP_QUERY_PARAMS
    }
    query_string = urlencode(filtered_params)
    target_url = f'{real_base_url}/v1/{path}'
    if query_string:
        target_url = f'{target_url}?{query_string}'

    # Forward headers, forcing identity encoding to avoid double-decompress
    # Also strip anthropic-beta header — FMAPI rejects unrecognised beta flags
    _STRIP_HEADERS = {'host', 'content-length', 'accept-encoding', 'x-real-fmapi-url', 'anthropic-beta'}
    forward_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _STRIP_HEADERS
    }
    forward_headers = _rewrite_auth_headers(forward_headers, real_base_url)
    forward_headers['accept-encoding'] = 'identity'

    # Strip unsupported body fields
    body_bytes = await request.body()
    if request.method == 'POST' and body_bytes:
        try:
            body = json.loads(body_bytes)
            stripped = [f for f in _STRIP_BODY_FIELDS if f in body]
            for field in stripped:
                del body[field]
            if stripped:
                logger.info(f'Stripped FMAPI-incompatible fields: {stripped}')
            body_bytes = json.dumps(body).encode()
        except Exception:
            pass

    forward_headers['content-length'] = str(len(body_bytes))

    try:
        body_keys = list(json.loads(body_bytes).keys()) if body_bytes else []
    except Exception:
        body_keys = ['<non-json>']
    logger.warning(f'Proxy → {target_url} | body_keys={body_keys}')

    is_streaming = _is_streaming(body_bytes)

    client = _get_client()

    if is_streaming:
        upstream_request = client.build_request(
            request.method,
            target_url,
            content=body_bytes,
            headers=forward_headers,
        )
        resp = await client.send(upstream_request, stream=True)
        if resp.status_code >= 400:
            body_text = await resp.aread()
            await resp.aclose()
            logger.error(f'FMAPI streaming error {resp.status_code}: {body_text[:500]}')
            resp_headers = {
                k: v for k, v in resp.headers.items()
                if k.lower() not in ('content-encoding', 'content-length', 'transfer-encoding')
            }
            return Response(
                content=body_text,
                status_code=resp.status_code,
                headers=resp_headers,
            )

        async def stream_gen():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await resp.aclose()

        return StreamingResponse(
            stream_gen(),
            media_type='text/event-stream',
            headers={'cache-control': 'no-cache'},
        )
    else:
        resp = await client.request(
            request.method,
            target_url,
            content=body_bytes,
            headers=forward_headers,
        )
        if resp.status_code >= 400:
            logger.error(f'FMAPI error {resp.status_code}: {resp.text[:500]}')
        resp_headers = {
            k: v for k, v in resp.headers.items()
            if k.lower() not in ('content-encoding', 'content-length', 'transfer-encoding')
        }
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=resp_headers,
        )


def _is_streaming(body_bytes: bytes) -> bool:
    if not body_bytes:
        return False
    try:
        return bool(json.loads(body_bytes).get('stream', False))
    except Exception:
        return False
