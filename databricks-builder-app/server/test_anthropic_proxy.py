from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx

from server.routers import anthropic_proxy as proxy_module


class RecordingClient:
    def __init__(self, response: httpx.Response):
        self.response = response
        self.recorded_request: httpx.Request | None = None
        self.used_streaming = False

    async def request(self, method, url, content=None, headers=None):
        self.recorded_request = httpx.Request(method, url, content=content, headers=headers)
        return self.response

    def build_request(self, method, url, content=None, headers=None):
        self.recorded_request = httpx.Request(method, url, content=content, headers=headers)
        return self.recorded_request

    async def send(self, request: httpx.Request, stream: bool = False):
        self.recorded_request = request
        self.used_streaming = stream
        return self.response

    def stream(self, method, url, content=None, headers=None):
        self.recorded_request = httpx.Request(method, url, content=content, headers=headers)

        class _ContextManager:
            async def __aenter__(inner_self):
                return self.response

            async def __aexit__(inner_self, exc_type, exc, tb):
                return False

        return _ContextManager()


def _make_test_client(monkeypatch, upstream_client: RecordingClient) -> TestClient:
    app = FastAPI()
    app.include_router(proxy_module.router, prefix='/anthropic-proxy')
    proxy_module.set_fmapi_base_url('https://7405610142670272.2.ai-gateway.azuredatabricks.net/anthropic')
    monkeypatch.setattr(proxy_module, '_get_client', lambda: upstream_client)
    return TestClient(app)


def test_proxy_rewrites_x_api_key_to_bearer_for_databricks_upstream(monkeypatch):
    upstream = RecordingClient(
        httpx.Response(
            200,
            json={'ok': True},
            request=httpx.Request('POST', 'https://upstream/v1/messages'),
        )
    )
    client = _make_test_client(monkeypatch, upstream)

    response = client.post(
        '/anthropic-proxy/v1/messages',
        json={'model': 'databricks-claude-opus-4-6', 'max_tokens': 16, 'messages': []},
        headers={'x-api-key': 'secret-token'},
    )

    assert response.status_code == 200
    assert upstream.recorded_request is not None
    assert upstream.recorded_request.headers.get('authorization') == 'Bearer secret-token'
    assert 'x-api-key' not in upstream.recorded_request.headers


def test_proxy_returns_upstream_status_for_streaming_errors(monkeypatch):
    upstream = RecordingClient(
        httpx.Response(
            401,
            json={'message': 'Credential was not sent'},
            request=httpx.Request('POST', 'https://upstream/v1/messages'),
        )
    )
    client = _make_test_client(monkeypatch, upstream)

    response = client.post(
        '/anthropic-proxy/v1/messages',
        json={
            'model': 'databricks-claude-opus-4-6',
            'max_tokens': 16,
            'stream': True,
            'messages': [],
        },
        headers={'x-api-key': 'secret-token'},
    )

    assert response.status_code == 401
    assert response.json() == {'message': 'Credential was not sent'}
