"""本物の SDK(anthropic の AsyncAnthropic)を httpx2.MockTransport につないで、中継が送る要求の形を確かめる。

偽物の SDK では、SDK が引数を受け付けるか、ベータのヘッダー・クエリ(event_deltas[])・本文が API の形になるかを
確かめられない。通信は MockTransport の中で終わり、Anthropic には届かない。
"""

import json
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from dispatcher_server import agent_session
from dispatcher_server.app import app

API_KEY = "sk-ant-test-wire-secret"
TOKEN = "wire-token"
SESSION_ID = "sesn_wire_01"
T = "2026-11-05T01:00:00Z"


def sse_body(events: list[dict[str, Any]]) -> bytes:
    return "".join(f"event: message\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events).encode("utf-8")


class Recorder:
    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "POST" and path == "/v1/sessions":
            return httpx2.Response(200, json={"id": SESSION_ID, "type": "session", "status": "idle"})
        if path == f"/v1/sessions/{SESSION_ID}/events/stream":
            events = [
                {"type": "event_start", "event": {"type": "agent.message", "id": "sevt_m"}},
                {"type": "event_delta", "event_id": "sevt_m", "delta": {"type": "content_delta", "index": 0, "content": {"type": "text", "text": "こん"}}},
                {"type": "agent.message", "id": "sevt_m", "processed_at": T, "content": [{"type": "text", "text": "こんにちは"}]},
                {"type": "agent.custom_tool_use", "id": "sevt_tool", "processed_at": T, "name": "run_validation", "input": {}},
            ]
            return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse_body(events))
        if path == f"/v1/sessions/{SESSION_ID}/threads":
            return httpx2.Response(200, json={"data": [{"id": "sthr_p", "type": "session_thread", "parent_thread_id": None}], "next_page": None})
        if request.method == "GET" and path == f"/v1/sessions/{SESSION_ID}/events":
            if request.url.params.get("page") == "p2":
                return httpx2.Response(200, json={"data": [{"type": "agent.custom_tool_use", "id": "sevt_old", "processed_at": T, "name": "apply_policy", "input": {"kind": "weekday_to_saturday"}}], "next_page": None})
            return httpx2.Response(200, json={"data": [{"type": "user.message", "id": "sevt_u", "processed_at": T, "content": [{"type": "text", "text": "a"}]}], "next_page": "p2"})
        if request.method == "POST" and path == f"/v1/sessions/{SESSION_ID}/events":
            return httpx2.Response(200, json={"data": []})
        if request.method == "GET" and path == f"/v1/sessions/{SESSION_ID}":
            return httpx2.Response(200, json={"id": SESSION_ID, "type": "session", "status": "idle", "usage": {"list_cost": {"amount": "3", "currency": "USD"}}})
        return httpx2.Response(404, json={"type": "error", "error": {"type": "not_found_error", "message": "x"}})


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    rec = Recorder()
    real = agent_session.build_client(API_KEY, "wrkspc_wire", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(rec)), max_retries=0)
    monkeypatch.setattr(agent_session, "get_client", lambda: real)
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY)
    monkeypatch.setenv("DISPATCHER_AGENT_ID", "agent_wire")
    monkeypatch.setenv("DISPATCHER_AGENT_VERSION", "3")
    monkeypatch.setenv("DISPATCHER_ENVIRONMENT_ID", "env_wire")
    monkeypatch.setenv("DISPATCHER_SESSION_SECRET", "wire-secret")
    monkeypatch.setenv("DISPATCHER_TOKEN", TOKEN)
    return rec


def test_requests_reach_the_wire_in_the_api_shape(recorder: Recorder) -> None:
    client = TestClient(app)
    response = client.post("/api/claude/session", json={}, headers={"X-Dispatcher-Token": TOKEN})
    assert response.status_code == 200
    handle = response.json()["handle"]
    create = recorder.requests[0]
    # API キーは明示して渡したものだけを使う(この版の SDK は Authorization: Bearer で送る)
    assert create.headers.get("x-api-key") == API_KEY or create.headers.get("authorization") == f"Bearer {API_KEY}"
    assert "managed-agents-2026-04-01" in create.headers["anthropic-beta"]
    assert create.headers["anthropic-workspace-id"] == "wrkspc_wire"
    body = json.loads(create.content)
    assert body["agent"] == {"type": "agent", "id": "agent_wire", "version": 3}
    assert body["environment_id"] == "env_wire"
    assert body["budget"] == {"type": "limit", "max_list_cost": {"amount": "300", "currency": "USD"}}
    assert "initial_events" not in body

    h = {"X-Dispatcher-Token": TOKEN, "X-Dispatcher-Session": handle}
    text = client.get("/api/claude/session/stream", headers=h).text
    stream_request = next(r for r in recorder.requests if r.url.path.endswith("/events/stream"))
    assert stream_request.url.params.get_list("event_deltas[]") == ["agent.message", "agent.thinking"]
    assert "managed-agents-2026-04-01" in stream_request.headers["anthropic-beta"]
    # 履歴は2ページ目まで読む(2ページ目に答えていない呼び出しがある)
    pages = [r for r in recorder.requests if r.method == "GET" and r.url.path == f"/v1/sessions/{SESSION_ID}/events"]
    assert [r.url.params.get("page") for r in pages] == [None, "p2"]
    assert "event: tool_call" in text and "sevt_old" in text
    assert 'event: delta\ndata: {"message_id":"sevt_m","text":"こん"}' in text
    assert "id: sevt_m\nevent: message" in text
    assert "id: sevt_tool\nevent: tool_call" in text

    results = {"kind": "tool_results", "results": [{"custom_tool_use_id": "sevt_old", "text": "{}", "is_error": False}]}
    assert client.post("/api/claude/session/events", json=results, headers=h).status_code == 200
    send = [r for r in recorder.requests if r.method == "POST" and r.url.path.endswith("/events")][-1]
    assert json.loads(send.content) == {
        "events": [{"type": "user.custom_tool_result", "custom_tool_use_id": "sevt_old", "content": [{"type": "text", "text": "{}"}], "is_error": False}]
    }
