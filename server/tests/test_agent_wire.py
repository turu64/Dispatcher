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


def use_wire(monkeypatch: pytest.MonkeyPatch, rec: Any) -> None:
    real = agent_session.build_client(API_KEY, "wrkspc_wire", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(rec)), max_retries=0)
    monkeypatch.setattr(agent_session, "get_client", lambda: real)
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY)
    monkeypatch.setenv("DISPATCHER_AGENT_ID", "agent_wire")
    monkeypatch.setenv("DISPATCHER_AGENT_VERSION", "3")
    monkeypatch.setenv("DISPATCHER_ENVIRONMENT_ID", "env_wire")
    monkeypatch.setenv("DISPATCHER_SESSION_SECRET", "wire-secret")
    monkeypatch.setenv("DISPATCHER_TOKEN", TOKEN)


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    rec = Recorder()
    use_wire(monkeypatch, rec)
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


# ---- ツールの呼び出しの上限:止めた知らせと user.interrupt は1回の発言につき1回だけ(指摘15.2) ----

STOPPED_LONG = "AI がこの相談でツールを 12 回使ったので、ここで止めました。続けるときは「続きを頼む」を押してください"


def user_message(event_id: str) -> dict[str, Any]:
    return {"type": "user.message", "id": event_id, "processed_at": T, "content": [{"type": "text", "text": "減便の影響を調べて"}]}


def search(event_id: str) -> dict[str, Any]:
    return {"type": "agent.custom_tool_use", "id": event_id, "processed_at": T, "name": "search_trips", "input": {"scope": "removed"}}


def result_of(event_id: str) -> dict[str, Any]:
    return {"type": "user.custom_tool_result", "id": f"r_{event_id}", "processed_at": T, "custom_tool_use_id": event_id, "content": [], "is_error": False}


def idle(event_id: str, reason: str = "end_turn") -> dict[str, Any]:
    return {"type": "session.status_idle", "id": event_id, "processed_at": T, "stop_reason": {"type": reason}}


class LimitRecorder:
    """履歴(events.list)とストリームの中身を差し替えられる偽の API。events.send の本文を覚える。"""

    def __init__(self) -> None:
        self.history: list[dict[str, Any]] = []
        self.streams: list[list[dict[str, Any]]] = []
        self.sent: list[list[dict[str, Any]]] = []
        self.fail_sends = 0  # この回数だけ events.send を 500 で断る

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        path = request.url.path
        if request.method == "POST" and path == "/v1/sessions":
            return httpx2.Response(200, json={"id": SESSION_ID, "type": "session", "status": "idle"})
        if path == f"/v1/sessions/{SESSION_ID}/events/stream":
            events = self.streams.pop(0) if self.streams else []
            return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse_body(events))
        if path == f"/v1/sessions/{SESSION_ID}/threads":
            return httpx2.Response(200, json={"data": [{"id": "sthr_p", "type": "session_thread", "parent_thread_id": None}], "next_page": None})
        if request.method == "GET" and path == f"/v1/sessions/{SESSION_ID}/events":
            return httpx2.Response(200, json={"data": self.history, "next_page": None})
        if request.method == "POST" and path == f"/v1/sessions/{SESSION_ID}/events":
            if self.fail_sends > 0:
                self.fail_sends -= 1
                return httpx2.Response(500, json={"type": "error", "error": {"type": "api_error", "message": "x"}})
            self.sent.append(json.loads(request.content)["events"])
            return httpx2.Response(200, json={"data": []})
        if request.method == "GET" and path == f"/v1/sessions/{SESSION_ID}":
            return httpx2.Response(200, json={"id": SESSION_ID, "type": "session", "status": "idle", "usage": {"list_cost": {"amount": "3", "currency": "USD"}}})
        return httpx2.Response(404, json={"type": "error", "error": {"type": "not_found_error", "message": "x"}})

    def sent_types(self) -> list[str]:
        return [event["type"] for events in self.sent for event in events]

    def sent_results(self) -> list[dict[str, Any]]:
        return [event for events in self.sent for event in events if event["type"] == "user.custom_tool_result"]


@pytest.fixture
def limit_recorder(monkeypatch: pytest.MonkeyPatch) -> LimitRecorder:
    rec = LimitRecorder()
    use_wire(monkeypatch, rec)
    return rec


def sse_frames(text: str) -> list[tuple[str, Any]]:
    frames: list[tuple[str, Any]] = []
    for block in text.split("\n\n"):
        name = data = None
        for line in block.split("\n"):
            if line.startswith("event: "):
                name = line[len("event: ") :]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: ") :])
        if name is not None:
            frames.append((name, data))
    return frames


def stopped_long_frames(text: str) -> list[Any]:
    return [data for name, data in sse_frames(text) if name == "error" and data.get("code") == "too_many_tool_calls"]


def open_session(client: TestClient) -> dict[str, str]:
    response = client.post("/api/claude/session", json={}, headers={"X-Dispatcher-Token": TOKEN})
    assert response.status_code == 200
    return {"X-Dispatcher-Token": TOKEN, "X-Dispatcher-Session": response.json()["handle"]}


def test_parallel_calls_over_the_limit_stop_only_once_per_message(limit_recorder: LimitRecorder) -> None:
    rec = limit_recorder
    client = TestClient(app)
    h = open_session(client)
    first = [search(f"sevt_a{i:02d}") for i in range(1, 13)]
    over = [search(f"sevt_a{i:02d}") for i in range(13, 17)]  # 12 回のあとに並行で4件
    rec.streams = [[user_message("sevt_u1"), *first, *over, idle("sevt_idle1")]]
    text = client.get("/api/claude/session/stream", headers=h).text

    # 4件すべてに is_error で答え、user.interrupt は1つだけ(最初の答えと同じ events.send の後ろ)
    results = rec.sent_results()
    assert [r["custom_tool_use_id"] for r in results] == [e["id"] for e in over]
    assert all(r["is_error"] is True for r in results)
    assert all(json.loads(r["content"][0]["text"])["message"] == "ツールの呼び出しが多すぎるので止めます" for r in results)
    assert rec.sent_types().count("user.interrupt") == 1
    assert [e["type"] for e in rec.sent[0]] == ["user.custom_tool_result", "user.interrupt"]
    # 止めた知らせも1つだけ。data に limit(12)
    assert stopped_long_frames(text) == [{"message": STOPPED_LONG, "code": "too_many_tool_calls", "limit": 12}]
    assert ("status", {"state": "idle", "reason": "interrupted"}) in sse_frames(text)

    # 次の発言(履歴には前の発言の答えと interrupt がある)の後に上限を超えたら、また1回出る
    rec.history = [
        user_message("sevt_u1"),
        *first,
        *over,
        *(result_of(e["id"]) for e in first + over),
        {"type": "user.interrupt", "id": "sevt_int1", "processed_at": T},
        idle("sevt_idle1"),
    ]
    rec.sent.clear()
    second = [search(f"sevt_b{i:02d}") for i in range(1, 13)]
    over2 = [search(f"sevt_b{i:02d}") for i in range(13, 15)]
    rec.streams = [[user_message("sevt_u2"), *second, *over2, idle("sevt_idle2")]]
    text = client.get("/api/claude/session/stream", headers=h).text
    assert [r["custom_tool_use_id"] for r in rec.sent_results()] == [e["id"] for e in over2]
    assert rec.sent_types().count("user.interrupt") == 1
    assert len(stopped_long_frames(text)) == 1


def test_rebuild_keeps_the_stop_mark_after_the_interrupt(limit_recorder: LimitRecorder) -> None:
    rec = limit_recorder
    client = TestClient(app)
    h = open_session(client)
    calls = [search(f"sevt_c{i:02d}") for i in range(1, 14)]
    late = search("sevt_c14")  # interrupt の後に届いた、答えていない 14 回目
    rec.history = [
        user_message("sevt_u1"),
        *calls,
        *(result_of(e["id"]) for e in calls),
        {"type": "user.interrupt", "id": "sevt_int1", "processed_at": T},
        late,
    ]
    text = client.get("/api/claude/session/stream", headers=h).text
    # 履歴から作り直しても「この発言で止めた」印が立つので、is_error で答えるだけで、知らせも interrupt も出さない
    assert [r["custom_tool_use_id"] for r in rec.sent_results()] == ["sevt_c14"]
    assert rec.sent_results()[0]["is_error"] is True
    assert "user.interrupt" not in rec.sent_types()
    assert stopped_long_frames(text) == []


def test_failed_send_resets_the_stop_mark(limit_recorder: LimitRecorder) -> None:
    rec = limit_recorder
    client = TestClient(app)
    h = open_session(client)
    first = [search(f"sevt_d{i:02d}") for i in range(1, 13)]
    over = [search("sevt_d13"), search("sevt_d14")]
    rec.fail_sends = 1  # 13 回目の答え(と interrupt)は届かない
    rec.streams = [[user_message("sevt_u1"), *first, *over, idle("sevt_idle1")]]
    text = client.get("/api/claude/session/stream", headers=h).text
    # 届かなかった1回目は知らせを出さず、14 回目のときに 13・14 回目へまとめて答え直し、そこで1回だけ出す
    (sent,) = rec.sent
    assert [e["type"] for e in sent] == ["user.custom_tool_result", "user.custom_tool_result", "user.interrupt"]
    assert [e["custom_tool_use_id"] for e in sent[:2]] == ["sevt_d13", "sevt_d14"]
    assert len(stopped_long_frames(text)) == 1
