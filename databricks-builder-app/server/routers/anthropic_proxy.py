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

# Body fields Databricks FMAPI rejects
_STRIP_BODY_FIELDS = {'context_management', 'betas', 'beta'}

# Query params Databricks FMAPI rejects
_STRIP_QUERY_PARAMS = {'beta'}


@router.api_route('/v1/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
async def proxy(path: str, request: Request):
    """Proxy to Databricks FMAPI, stripping unsupported fields."""
    real_base_url = request.headers.get('x-real-fmapi-url', '')
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

    # Debug: log target URL and forwarded headers/body keys
    try:
        body_keys = list(json.loads(body_bytes).keys()) if body_bytes else []
    except Exception:
        body_keys = ['<non-json>']
    logger.info(f'Proxy → {target_url} | body_keys={body_keys} | headers={list(forward_headers.keys())}')
    # Log anthropic-* headers specifically (often carry beta flags)
    for h, v in forward_headers.items():
        if 'anthropic' in h.lower() or 'beta' in h.lower():
            logger.info(f'  forwarded header: {h}={v}')

    is_streaming = _is_streaming(body_bytes)

    if is_streaming:
        # Create the client INSIDE the generator to avoid "client already closed" error
        async def stream_gen():
            async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
                async with client.stream(
                    request.method,
                    target_url,
                    content=body_bytes,
                    headers=forward_headers,
                ) as resp:
                    if resp.status_code >= 400:
                        body_text = await resp.aread()
                        logger.error(f'FMAPI streaming error {resp.status_code}: {body_text[:500]}')
                        yield body_text
                        return
                    async for chunk in resp.aiter_bytes():
                        yield chunk

        return StreamingResponse(
            stream_gen(),
            media_type='text/event-stream',
            headers={'cache-control': 'no-cache'},
        )
    else:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
            resp = await client.request(
                request.method,
                target_url,
                content=body_bytes,
                headers=forward_headers,
            )
            if resp.status_code >= 400:
                logger.error(f'FMAPI error {resp.status_code}: {resp.text[:500]}')
            # Strip content-encoding to avoid double-decompress on the client side
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
