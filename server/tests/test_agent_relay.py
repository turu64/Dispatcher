"""Managed Agents のセッションの中継のテスト。docs/interfaces-1105.md §8 の server。API は呼ばない。

SDK のクライアントは偽物(tests/fake_anthropic.py)に差し替える。要求の形が本物の SDK で通るかは、
test_agent_wire.py で本物の SDK を httpx2.MockTransport につないで確かめる。
"""

import json
import logging
import time
from typing import Any

import pytest
from fake_anthropic import (
    CHILD_THREAD,
    PRIMARY_THREAD,
    RUN_THREAD,
    SESSION_ID,
    FakeAnthropic,
    FakeStream,
    bad_request,
    ev,
    idle,
    tool_use,
)
from fastapi.testclient import TestClient

from dispatcher_server import agent_relay, agent_session, settings
from dispatcher_server.app import app
from dispatcher_server.ratelimit import RateLimiter, jst_day
from dispatcher_server.store import get_store
from dispatcher_server.store import iso as store_iso

API_KEY = "sk-ant-test-0123456789-secret"
TOKEN = "test-token-0123456789"
SECRET = "test-session-secret-0123456789abcdef"
AGENT_ID = "agent_test_coordinator"
ENVIRONMENT_ID = "env_test_dispatcher"


# ---- 道具 ----


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeAnthropic:
    instance = FakeAnthropic()
    monkeypatch.setattr(agent_session, "get_client", lambda: instance)
    return instance


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def enable(monkeypatch: pytest.MonkeyPatch, *, token: str | None = TOKEN, secret: str | None = SECRET) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY)
    monkeypatch.setenv("DISPATCHER_AGENT_ID", AGENT_ID)
    monkeypatch.setenv("DISPATCHER_AGENT_VERSION", "1")
    monkeypatch.setenv("DISPATCHER_ENVIRONMENT_ID", ENVIRONMENT_ID)
    if secret is not None:
        monkeypatch.setenv("DISPATCHER_SESSION_SECRET", secret)
    if token is not None:
        monkeypatch.setenv("DISPATCHER_TOKEN", token)


def headers(handle: str | None = None, **extra: str) -> dict[str, str]:
    result = {"X-Dispatcher-Token": TOKEN, **extra}
    if handle is not None:
        result["X-Dispatcher-Session"] = handle
    return result


def create(client: TestClient, **extra: str) -> str:
    response = client.post("/api/claude/session", json={}, headers=headers(**extra))
    assert response.status_code == 200, response.text
    return response.json()["handle"]


def row_of(handle: str) -> dict[str, Any]:
    row = get_store().get_session(handle.split(".")[1])
    assert row is not None
    return row


def parse_sse(text: str) -> list[tuple[str, dict[str, Any], str | None]]:
    frames = []
    for block in text.split("\n\n"):
        lines = [line for line in block.split("\n") if line and not line.startswith(":")]
        if not lines:
            continue
        event = next(line[len("event: ") :] for line in lines if line.startswith("event: "))
        data = next(line[len("data: ") :] for line in lines if line.startswith("data: "))
        event_id = next((line[len("id: ") :] for line in lines if line.startswith("id: ")), None)
        frames.append((event, json.loads(data), event_id))
    return frames


def stream(client: TestClient, handle: str, last_event_id: str | None = None) -> list[tuple[str, dict[str, Any], str | None]]:
    extra = {"Last-Event-ID": last_event_id} if last_event_id else {}
    response = client.get("/api/claude/session/stream", headers=headers(handle, **extra))
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    return parse_sse(response.text)


def post_events(client: TestClient, handle: str, body: Any, **extra: str) -> Any:
    return client.post("/api/claude/session/events", json=body, headers=headers(handle, **extra))


def message(text: str = "平日を土曜ダイヤにしてください", screen: str | None = None) -> dict[str, Any]:
    content = []
    if screen is not None:
        content.append({"type": "text", "text": screen})
    content.append({"type": "text", "text": text})
    return {"kind": "message", "content": content}


def result(call_id: str, text: str = '{"status":"ok"}', is_error: bool = False) -> dict[str, Any]:
    return {"custom_tool_use_id": call_id, "text": text, "is_error": is_error}


def sent_types(fake: FakeAnthropic) -> list[list[str]]:
    return [[event["type"] for event in events] for events in fake.sent]


def kinds(frames: list[tuple[str, dict[str, Any], str | None]]) -> list[str]:
    return [frame[0] for frame in frames]


def tool_text(event: dict[str, Any]) -> dict[str, Any]:
    return json.loads(event["content"][0]["text"])


# ---- status ----


def test_status_needs_key_agent_version_environment_secret_and_token(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    assert client.get("/api/claude/status").json() == {"available": False, "tokenRequired": False}
    enable(monkeypatch)
    assert client.get("/api/claude/status").json() == {"available": True, "tokenRequired": True}
    for name in ("ANTHROPIC_API_KEY", "DISPATCHER_AGENT_ID", "DISPATCHER_AGENT_VERSION", "DISPATCHER_ENVIRONMENT_ID", "DISPATCHER_SESSION_SECRET"):
        with monkeypatch.context() as patch:
            patch.delenv(name)
            assert client.get("/api/claude/status").json()["available"] is False, name
    with monkeypatch.context() as patch:
        patch.setenv("DISPATCHER_AGENT_VERSION", "latest")  # 整数でない版は使えない
        assert client.get("/api/claude/status").json()["available"] is False
    with monkeypatch.context() as patch:
        patch.delenv("DISPATCHER_TOKEN")
        assert client.get("/api/claude/status").json() == {"available": False, "tokenRequired": False}


def test_dev_flag_allows_missing_token_and_secret_only_in_dev(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch, token=None, secret=None)
    assert client.get("/api/claude/status").json() == {"available": False, "tokenRequired": False}
    assert client.post("/api/claude/session", json={}).status_code == 503
    monkeypatch.setenv("DISPATCHER_DEV", "1")
    assert client.get("/api/claude/status").json() == {"available": True, "tokenRequired": False}
    response = client.post("/api/claude/session", json={})
    assert response.status_code == 200
    # 起動ごとの乱数で署名する。合言葉が無いので、ヘッダーは取っ手だけ
    handle = response.json()["handle"]
    assert agent_relay.parse_handle(handle) == handle.split(".")[1]


def test_public_flag_allows_no_token_but_keeps_the_other_requirements(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    # 本番で合言葉なしの公開を明示する(DISPATCHER_PUBLIC=1)。API キーがあって合言葉も PUBLIC も DEV も無ければ今どおり止める
    enable(monkeypatch, token=None)
    assert client.get("/api/claude/status").json() == {"available": False, "tokenRequired": False}
    response = client.post("/api/claude/session", json={})
    assert response.status_code == 503 and response.json()["detail"] == agent_relay.MSG_NO_TOKEN
    monkeypatch.setenv("DISPATCHER_PUBLIC", "1")
    assert client.get("/api/claude/status").json() == {"available": True, "tokenRequired": False}
    response = client.post("/api/claude/session", json={})
    assert response.status_code == 200
    handle = response.json()["handle"]
    # 取っ手は設定した秘密で署名する(起動ごとの乱数ではない)
    with monkeypatch.context() as patch:
        patch.setenv("DISPATCHER_SESSION_SECRET", SECRET + "-other")
        assert agent_relay.parse_handle(handle) is None
    assert agent_relay.parse_handle(handle) == handle.split(".")[1]
    assert client.post("/api/claude/session/events", json=message(), headers={"X-Dispatcher-Session": handle}).status_code == 200
    # DISPATCHER_DEV のほかの緩みは許さない:取っ手の秘密が無ければ使えない
    with monkeypatch.context() as patch:
        patch.delenv("DISPATCHER_SESSION_SECRET")
        assert client.get("/api/claude/status").json() == {"available": False, "tokenRequired": False}
        response = client.post("/api/claude/session", json={})
        assert response.status_code == 503 and response.json()["detail"] == agent_relay.MSG_NO_SECRET
    # 合言葉も設定してあれば、合言葉を求める
    monkeypatch.setenv("DISPATCHER_TOKEN", TOKEN)
    assert client.get("/api/claude/status").json() == {"available": True, "tokenRequired": True}
    assert client.post("/api/claude/session", json={}, headers={"X-Dispatcher-Token": "wrong"}).status_code == 401
    assert client.post("/api/claude/session", json={}).status_code == 401
    assert client.post("/api/claude/session", json={}, headers=headers()).status_code == 200


@pytest.mark.parametrize("value", ["0", "", "no"])
def test_public_flag_must_be_explicit(monkeypatch: pytest.MonkeyPatch, client: TestClient, value: str) -> None:
    enable(monkeypatch, token=None)
    monkeypatch.setenv("DISPATCHER_PUBLIC", value)
    assert client.get("/api/claude/status").json()["available"] is False


def test_status_does_not_expose_secrets(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    enable(monkeypatch)
    text = client.get("/api/claude/status").text
    for secret in (API_KEY, TOKEN, SECRET, AGENT_ID, ENVIRONMENT_ID):
        assert secret not in text


# ---- 作成 ----


def test_create_pins_the_agent_version_and_sets_the_budget(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    response = client.post("/api/claude/session", json={}, headers=headers())
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"handle", "budget_cents"} and body["budget_cents"] == 300
    assert SESSION_ID not in response.text  # Anthropic のセッションの ID はブラウザに渡さない
    (kwargs,) = fake.calls_named("sessions.create")
    assert kwargs["agent"] == {"type": "agent", "id": AGENT_ID, "version": 1}
    assert kwargs["environment_id"] == ENVIRONMENT_ID
    assert kwargs["budget"] == {"type": "limit", "max_list_cost": {"amount": "300", "currency": "USD"}}
    assert "initial_events" not in kwargs
    assert kwargs["title"] == "Dispatcher"
    row_id = body["handle"].split(".")[1]
    assert kwargs["metadata"] == {"app": "dispatcher", "row": row_id}
    row = row_of(body["handle"])
    assert row["session_id"] == SESSION_ID and row["agent_version"] == 1 and row["ended_at"] is None
    assert len(body["handle"].split(".")) == 3 and body["handle"].startswith("v1.")


def test_create_budget_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_SESSION_BUDGET_CENTS", "250")
    assert client.post("/api/claude/session", json={}, headers=headers()).json()["budget_cents"] == 250
    assert fake.calls_named("sessions.create")[0]["budget"]["max_list_cost"]["amount"] == "250"


@pytest.mark.parametrize("body", [{"model": "claude-opus-5-5"}, {"agent": "x"}, [], None])
def test_create_body_must_be_empty(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, body: Any) -> None:
    enable(monkeypatch)
    response = client.post("/api/claude/session", json=body, headers=headers())
    assert response.status_code == 400
    assert fake.calls_named("sessions.create") == []


def test_create_errors_are_japanese_and_create_no_row(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    fake.create_error = bad_request()
    response = client.post("/api/claude/session", json={}, headers=headers())
    assert response.status_code == 502
    assert "secret-upstream-text" not in response.text
    assert get_store().sessions_created_on(jst_day(time.time())) == 0


def test_sessions_per_ip_hour_and_day(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_DAILY_COST_CENTS", "100000")
    for _ in range(3):
        create(client)
    response = client.post("/api/claude/session", json={}, headers=headers())
    assert response.status_code == 429 and "1 時間" in response.json()["detail"]
    assert len(fake.calls_named("sessions.create")) == 3
    # 1 日の上限(時刻を進めて、1 時間の窓の外にする)
    clock = [time.time()]
    monkeypatch.setattr(agent_relay, "limiter", RateLimiter(clock=lambda: clock[0]))
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_HOUR", "100")
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_DAY", "2")
    create(client)
    create(client)
    response = client.post("/api/claude/session", json={}, headers=headers())
    assert response.status_code == 429 and "1 日" in response.json()["detail"]


def test_sessions_per_day_survive_a_restart(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_DAY", "2")
    monkeypatch.setenv("DISPATCHER_DAILY_COST_CENTS", "100000")
    create(client, **{"X-Real-IP": "198.51.100.1"})
    create(client)
    # 再起動:メモリの数え上げとセッションの状態が消え、SQLite は残る
    monkeypatch.setattr(agent_relay, "limiter", RateLimiter())
    agent_session.reset_states()
    restarted = TestClient(app)
    response = restarted.post("/api/claude/session", json={}, headers=headers())
    assert response.status_code == 429
    assert "今日" in response.json()["detail"]
    assert len(fake.calls_named("sessions.create")) == 2


def test_x_real_ip_is_ignored_without_trust_proxy(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_DAILY_COST_CENTS", "100000")
    for index in range(3):
        create(client, **{"X-Real-IP": f"203.0.113.{index}"})
    response = client.post("/api/claude/session", json={}, headers=headers(**{"X-Real-IP": "203.0.113.99"}))
    assert response.status_code == 429


def test_trust_proxy_counts_by_x_real_ip(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_DAILY_COST_CENTS", "100000")
    monkeypatch.setenv("DISPATCHER_TRUST_PROXY", "1")
    for _ in range(3):
        create(client, **{"X-Real-IP": "203.0.113.1"})
    assert client.post("/api/claude/session", json={}, headers=headers(**{"X-Real-IP": "203.0.113.1"})).status_code == 429
    create(client, **{"X-Real-IP": "203.0.113.2"})
    # X-Forwarded-For は読まない。X-Real-IP が無ければ 400
    response = client.post("/api/claude/session", json={}, headers=headers(**{"X-Forwarded-For": "203.0.113.3"}))
    assert response.status_code == 400


# ---- 1日の利用額 ----


def test_daily_cost_reserves_the_budget_of_open_sessions(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_HOUR", "100")
    first = create(client)
    create(client)
    # 600 セント/日、3 ドルのセッションは同時に2つまで
    response = client.post("/api/claude/session", json={}, headers=headers())
    assert response.status_code == 429 and "利用額" in response.json()["detail"]
    # 1つを消すと予約が空く。ただし使った額(台帳)は残る
    store = get_store()
    store.record_cost(row_of(first)["row_id"], 120, time.time())
    store.mark_deleted(row_of(first)["row_id"], time.time())
    # 台帳 120 + 残りの予約 300 + 新しい 300 = 720 > 600
    assert client.post("/api/claude/session", json={}, headers=headers()).status_code == 429
    monkeypatch.setenv("DISPATCHER_DAILY_COST_CENTS", "720")
    create(client)


def test_sessions_left_without_a_stream_for_30_minutes_reserve_only_what_they_used(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    # 閉じ損ねたセッション(ブラウザが落ちた、DELETE が届かなかった)が、1日の利用額の予約を持ち続けない
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_HOUR", "100")
    first = create(client)
    second = create(client)
    assert client.post("/api/claude/session", json={}, headers=headers()).status_code == 429
    store = get_store()
    now = time.time()
    first_row = row_of(first)["row_id"]
    store.record_cost(first_row, 120, now)
    # 最後の操作とストリームが 29 分前なら、まだ予約に数える
    store.touch(first_row, now - 29 * 60)
    store.mark_stream(first_row, now - 29 * 60)
    assert client.post("/api/claude/session", json={}, headers=headers()).status_code == 429
    # 31 分前なら、使った額(台帳の 120)だけを数える:台帳 120 + 2つ目の 300 + 新しい 300 = 720 > 600
    store.touch(first_row, now - 31 * 60)
    store.mark_stream(first_row, now - 31 * 60)
    assert client.post("/api/claude/session", json={}, headers=headers()).status_code == 429
    monkeypatch.setenv("DISPATCHER_DAILY_COST_CENTS", "720")
    third = create(client)
    # 戻ってきた人は会話を続けられ(取っ手はそのまま使える)、つなげば予約にまた数える
    assert post_events(client, first, message()).status_code == 200
    assert client.post("/api/claude/session", json={}, headers=headers()).status_code == 429
    assert row_of(second)["ended_at"] is None and row_of(third)["ended_at"] is None


def test_stream_records_when_it_was_last_connected(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    assert row_of(handle)["last_stream_at"] is None
    before = store_iso(time.time())
    fake.streams = [FakeStream([])]
    stream(client, handle)
    stamp = row_of(handle)["last_stream_at"]
    assert stamp is not None and stamp >= before
    # 開けなかったストリームは記録しない
    other = create(client)
    fake.stream_error = RuntimeError("接続できません")
    response = client.get("/api/claude/session/stream", headers=headers(other))
    assert response.status_code >= 500
    assert row_of(other)["last_stream_at"] is None


def test_marked_frames_record_again_while_the_stream_stays_connected(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    marks: list[str] = []
    closed: list[bool] = []
    monkeypatch.setattr(agent_relay, "_mark_stream", lambda row_id: marks.append(row_id))

    async def frames() -> Any:
        try:
            for index in range(5):
                yield f"frame{index}"
        finally:
            closed.append(True)

    async def take(count: int) -> list[str]:
        result = []
        gen = agent_relay._marked_frames("row", frames())
        async for frame in gen:
            result.append(frame)
            if len(result) == count:
                break
        await gen.aclose()
        return result

    monkeypatch.setattr(agent_relay, "STREAM_MARK_SECONDS", 3600.0)
    assert asyncio.run(take(5)) == [f"frame{index}" for index in range(5)]
    assert marks == []
    monkeypatch.setattr(agent_relay, "STREAM_MARK_SECONDS", 0.0)
    assert asyncio.run(take(3)) == ["frame0", "frame1", "frame2"]
    assert marks == ["row", "row", "row"]
    # 外側を閉じたら中も閉じる
    assert closed == [True, True]


def test_concurrent_creates_cannot_slip_past_the_limits(monkeypatch: pytest.MonkeyPatch, fake: FakeAnthropic) -> None:
    # sessions.create を待つ間に別の作成が来ても、記録の前の数で関門を通さない(回数と1日の利用額の予約)
    import asyncio

    import httpx

    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_HOUR", "100")
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_DAY", "100")
    original = fake.beta.sessions.create

    async def slow_create(**kwargs: Any) -> dict[str, Any]:
        await asyncio.sleep(0.05)
        return await original(**kwargs)

    monkeypatch.setattr(fake.beta.sessions, "create", slow_create)

    async def scenario() -> list[int]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            responses = await asyncio.gather(*[http.post("/api/claude/session", json={}, headers=headers()) for _ in range(8)])
            return [response.status_code for response in responses]

    codes = asyncio.run(scenario())
    # 600 セント/日、3 ドルのセッションは同時に2つまで
    assert sorted(codes) == [200, 200] + [429] * 6
    assert len(fake.calls_named("sessions.create")) == 2
    assert get_store().reserved_cents(300, now=time.time()) == 600

    # IP ごとの回数も同じ(1時間 3 回)
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_HOUR", "3")
    monkeypatch.setenv("DISPATCHER_DAILY_COST_CENTS", "100000")
    monkeypatch.setattr(agent_relay, "limiter", RateLimiter())
    codes = asyncio.run(scenario())
    assert sorted(codes) == [200, 200, 200] + [429] * 5


def test_ledger_at_the_cap_blocks_messages_but_not_results_or_interrupt(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    first = tool_use("apply_policy", event_id="sevt_call_a")
    second = tool_use("search_trips", event_id="sevt_call_b")
    fake.history = [first, second]
    get_store().record_cost(row_of(handle)["row_id"], 600, time.time())
    response = post_events(client, handle, message())
    assert response.status_code == 429 and "利用額" in response.json()["detail"]
    assert post_events(client, handle, {"kind": "tool_results", "results": [result("sevt_call_a")]}).status_code == 200
    assert post_events(client, handle, {"kind": "interrupt", "results": [result("sevt_call_b")]}).status_code == 200
    assert sent_types(fake) == [["user.custom_tool_result"], ["user.custom_tool_result", "user.interrupt"]]


# ---- 合言葉・取っ手 ----


def test_every_session_endpoint_needs_the_token(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    for bad in ({}, {"X-Dispatcher-Token": "wrong-token"}, {"X-Dispatcher-Token": TOKEN + "x"}):
        h = {**bad, "X-Dispatcher-Session": handle}
        assert client.post("/api/claude/session", json={}, headers=bad).status_code == 401
        assert client.get("/api/claude/session/stream", headers=h).status_code == 401
        assert client.post("/api/claude/session/events", json=message(), headers=h).status_code == 401
        assert client.post("/api/claude/session/research/known", json={"target_ids": ["P29:1"]}, headers=h).status_code == 401
        assert client.delete("/api/claude/session", headers=h).status_code == 401
    assert len(fake.calls_named("sessions.create")) == 1
    assert fake.calls_named("events.send") == []


def test_tampered_or_foreign_or_missing_handles_are_404_and_ended_is_410(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_HOUR", "10")
    monkeypatch.setenv("DISPATCHER_DAILY_COST_CENTS", "100000")
    handle = create(client)
    other = create(client)
    prefix, row_id, signature = handle.split(".")
    flipped = signature[:-1] + ("A" if signature[-1] != "A" else "B")
    foreign = f"{prefix}.{other.split('.')[1]}.{signature}"
    for bad in (f"{prefix}.{row_id}.{flipped}", foreign, "v2." + row_id + "." + signature, "garbage", f"{prefix}.{row_id}"):
        response = post_events(client, bad, message())
        assert response.status_code == 404, bad
        assert response.json()["detail"] == "AI との会話が見つかりません。新しく始めます"
    assert client.post("/api/claude/session/events", json=message(), headers=headers()).status_code == 404
    # 別の秘密で署名した取っ手も通らない
    monkeypatch.setenv("DISPATCHER_SESSION_SECRET", "another-secret")
    assert post_events(client, handle, message()).status_code == 404
    monkeypatch.setenv("DISPATCHER_SESSION_SECRET", SECRET)
    assert client.delete("/api/claude/session", headers=headers(handle)).status_code == 202
    assert post_events(client, handle, message()).status_code == 410
    assert client.get("/api/claude/session/stream", headers=headers(handle)).status_code == 410
    assert fake.calls_named("events.send") == [] or all(
        call["session_id"] == SESSION_ID for call in fake.calls_named("events.send")
    )


# ---- ストリームの変換 ----


def test_stream_converts_events_for_the_browser(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.cost_cents = 7
    fake.streams = [
        FakeStream(
            [
                ev("session.status_running"),
                ev("span.model_request_start"),
                ev("event_start", event={"type": "agent.thinking", "id": "sevt_think"}),
                ev("agent.thinking", id="sevt_think"),
                ev("event_start", event={"type": "agent.message", "id": "sevt_msg"}),
                ev("event_delta", event_id="sevt_msg", delta={"type": "content_delta", "index": 0, "content": {"type": "text", "text": "平日を"}}),
                ev("event_delta", event_id="sevt_msg", delta={"type": "content_delta", "index": 0, "content": {"type": "text", "text": "土曜に"}}),
                ev("agent.message", id="sevt_msg", content=[{"type": "text", "text": "平日を"}, {"type": "text", "text": "土曜にします"}]),
                tool_use("apply_policy", event_id="sevt_tool", kind="weekday_to_saturday"),
                ev("agent.thread_message_sent", to_session_thread_id=CHILD_THREAD, to_agent_name="dispatcher-researcher", content=[{"type": "text", "text": "中身"}]),
                ev("agent.thread_context_compacted"),
                ev("span.model_request_end", is_error=False, model_request_start_id="sevt_x", model_usage={"input_tokens": 1, "output_tokens": 1, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}),
                idle("requires_action", event_ids=["sevt_tool"], id="sevt_idle1"),
                ev("session.status_rescheduled"),
                ev("session.error", error={"type": "model_overloaded_error", "message": "upstream secret-upstream-text", "retry_status": {"type": "exhausted"}}),
                ev("session.usage", usage={"list_cost": {"amount": "9", "currency": "USD"}}),
                idle("budget_reached"),
                idle("retries_exhausted"),
                idle("end_turn"),
            ]
        )
    ]
    frames = stream(client, handle)
    (stream_call,) = fake.calls_named("events.stream")
    assert stream_call["event_deltas"] == ["agent.message", "agent.thinking"]
    assert kinds(frames) == [
        "status",
        "thinking",
        "thinking",
        "delta",
        "delta",
        "delta",
        "message",
        "tool_call",
        "status",
        "usage",
        "status",
        "error",
        "usage",
        "status",
        "usage",
        "status",
        "error",
        "usage",
        "status",
        "usage",
        "error",
    ]
    assert frames[0][1] == {"state": "running"}
    assert frames[3][1] == {"message_id": "sevt_msg", "text": ""}
    assert frames[4][1] == {"message_id": "sevt_msg", "text": "平日を"}
    assert frames[4][2] is None  # 途中経過には id を付けない
    assert frames[6] == ("message", {"message_id": "sevt_msg", "text": "平日を土曜にします"}, "sevt_msg")
    assert frames[7] == ("tool_call", {"id": "sevt_tool", "name": "apply_policy", "input": {"kind": "weekday_to_saturday"}}, "sevt_tool")
    assert frames[8][1] == {"state": "idle", "reason": "requires_action"}
    assert frames[9][1] == {"cost_cents": 7, "budget_cents": 300}
    assert frames[10][1] == {"state": "reconnecting"}
    assert frames[11][1] == {"message": "AI の処理でエラーが起きました", "code": "session_error"}
    assert frames[12][1] == {"cost_cents": 9, "budget_cents": 300}
    assert frames[13][1] == {"state": "idle", "reason": "budget_reached"}
    assert frames[15][1] == {"state": "idle", "reason": "retries_exhausted"}
    assert frames[16][1]["code"] == "retries_exhausted"
    assert frames[18][1] == {"state": "idle", "reason": "end_turn"}
    assert frames[-1][1]["code"] == "upstream"  # 偽物のストリームが閉じた
    assert "secret-upstream-text" not in json.dumps(frames, ensure_ascii=False)
    assert "中身" not in json.dumps(frames, ensure_ascii=False)


def test_stream_research_events(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.streams = [
        FakeStream(
            [
                ev("session.thread_created", session_thread_id=CHILD_THREAD, agent_name="dispatcher-researcher", workflow_run_id=None),
                ev("workflow_run.created", workflow_run_id="wrun_1", name="周辺の施設の調査", description=None, phases=[{"id": "ph_1", "name": "調べる", "description": None}]),
                ev("session.thread_created", session_thread_id=RUN_THREAD, agent_name="dispatcher-researcher", workflow_run_id="wrun_1"),
                ev("workflow_run.status_running", workflow_run_id="wrun_1"),
                ev("workflow_run.phase_started", workflow_run_id="wrun_1", workflow_run_phase_id="ph_1"),
                ev("workflow_run.phase_ended", workflow_run_id="wrun_1", workflow_run_phase_id="ph_1", phase_started_id="sevt_x"),
                ev("workflow_run.status_idle", workflow_run_id="wrun_1"),
                ev("workflow_run.error", workflow_run_id=None, error={"type": "max_workflow_runs_error", "message": "m"}),
                ev("workflow_run.status_ended", workflow_run_id="wrun_1", result={"type": "completed"}),
            ]
        )
    ]
    frames = [frame for frame in stream(client, handle) if frame[0] == "research"]
    assert [frame[1] for frame in frames] == [
        {"kind": "delegated", "name": "dispatcher-researcher"},
        {"kind": "run_started", "run_id": "wrun_1", "name": "周辺の施設の調査"},
        {"kind": "phase_started", "run_id": "wrun_1", "name": "調べる"},
        {"kind": "phase_ended", "run_id": "wrun_1", "name": "調べる"},
        {"kind": "run_paused", "run_id": "wrun_1"},
        {"kind": "run_error", "run_id": None, "result": "max_workflow_runs_error"},
        {"kind": "run_ended", "run_id": "wrun_1", "result": "completed"},
    ]
    assert all(frame[2] for frame in frames)  # どれも Anthropic のイベントの id を付ける


def test_new_stream_for_the_same_handle_closes_the_previous_one(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    import asyncio

    enable(monkeypatch)
    handle = create(client)
    row = row_of(handle)
    state = agent_session.get_state(row["row_id"], row["session_id"])

    async def scenario() -> list[str]:
        fake.streams = [FakeStream([], hang=True), FakeStream([], hang=True)]
        first = agent_session.open_stream(state, fake, None)
        got: list[str] = []

        async def drain(gen: Any) -> None:
            async for frame in gen:
                got.append(frame)

        task = asyncio.create_task(drain(first))
        await asyncio.sleep(0.05)
        assert state.conn is not None
        second = agent_session.open_stream(state, fake, None)
        second_task = asyncio.create_task(drain(second))
        await asyncio.sleep(0.05)
        await asyncio.wait_for(task, 1)  # 前のストリームは何も送らずに終わる
        assert fake.opened_streams[0].closed
        second_task.cancel()
        return got

    assert asyncio.run(scenario()) == []


def test_stream_sends_pings(monkeypatch: pytest.MonkeyPatch, fake: FakeAnthropic) -> None:
    import asyncio

    monkeypatch.setattr(agent_session, "PING_SECONDS", 0.01)
    state = agent_session.SessionState(row_id="row", session_id=SESSION_ID)
    fake.streams = [FakeStream([], hang=True)]

    async def scenario() -> list[str]:
        frames = []
        gen = agent_session.open_stream(state, fake, None)
        async for frame in gen:
            frames.append(frame)
            if len(frames) == 2:
                break
        await gen.aclose()
        return frames

    assert asyncio.run(scenario()) == [": ping\n\n", ": ping\n\n"]


def test_upstream_connect_failure_is_a_json_error_before_the_stream_starts(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, caplog: pytest.LogCaptureFixture) -> None:
    # Anthropic のストリームを開けなければ、SSE を始めずに JSON の失敗を返す(ブラウザは 401・404・410 のほかはつなぎ直す)
    enable(monkeypatch)
    handle = create(client)
    fake.stream_error = bad_request()
    caplog.set_level(logging.INFO)
    response = client.get("/api/claude/session/stream", headers=headers(handle))
    assert response.status_code == 502
    assert response.json() == {"detail": agent_session.MSG_UPSTREAM_CONNECT}
    assert "BadRequestError" in caplog.text and "secret-upstream-text" not in caplog.text
    row = row_of(handle)
    assert agent_session.get_state(row["row_id"], row["session_id"]).conn is None
    # 履歴を読めなかったときも同じ。開いたストリームは閉じる
    fake.stream_error = None
    original_list = fake.beta.sessions.events.list

    def failing_list(session_id: str, **kwargs: Any) -> Any:
        original_list(session_id, **kwargs)
        raise bad_request()

    monkeypatch.setattr(fake.beta.sessions.events, "list", failing_list)
    response = client.get("/api/claude/session/stream", headers=headers(handle))
    assert response.status_code == 502
    assert fake.opened_streams[-1].closed
    # ストリームを関数で使うとき(open_stream)は、error の行を1つ送って終わる
    import asyncio

    async def direct() -> list[str]:
        state = agent_session.SessionState(row_id="row", session_id=SESSION_ID)
        return [frame async for frame in agent_session.open_stream(state, fake, None)]

    assert parse_sse("".join(asyncio.run(direct()))) == [("error", {"message": "AI との接続が切れました。つなぎ直します", "code": "upstream"}, None)]


def test_stream_headers_go_out_only_after_the_upstream_stream_and_history_are_ready(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    # ブラウザはヘッダーが届いたら発言を送る。ヘッダーは Anthropic のストリームを開いて履歴を読んでから出す(§4.5・§6.5)
    import asyncio

    enable(monkeypatch)
    handle = create(client)
    order: list[str] = []
    original_stream = fake.beta.sessions.events.stream

    async def slow_stream(session_id: str, **kwargs: Any) -> Any:
        await asyncio.sleep(0.05)
        order.append("events.stream")
        return await original_stream(session_id, **kwargs)

    original_list = fake.beta.sessions.events.list

    def recording_list(session_id: str, **kwargs: Any) -> Any:
        order.append("events.list")
        return original_list(session_id, **kwargs)

    monkeypatch.setattr(fake.beta.sessions.events, "stream", slow_stream)
    monkeypatch.setattr(fake.beta.sessions.events, "list", recording_list)

    async def scenario() -> None:
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/claude/session/stream",
            "raw_path": b"/api/claude/session/stream",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"x-dispatcher-token", TOKEN.encode()), (b"x-dispatcher-session", handle.encode())],
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        }
        sent_request = False

        async def receive() -> dict[str, Any]:
            nonlocal sent_request
            if not sent_request:
                sent_request = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await asyncio.sleep(10)
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                order.append(f"response.start {message['status']}")

        await asyncio.wait_for(app(scope, receive, send), 5)

    asyncio.run(scenario())
    assert order[:3] == ["events.stream", "events.list", "response.start 200"]


def test_message_sent_right_after_connecting_reaches_the_browser(monkeypatch: pytest.MonkeyPatch, fake: FakeAnthropic) -> None:
    # 最初の接続(Last-Event-ID なし)の直後に送った発言への返答が、ブラウザに届く
    import asyncio

    from fake_anthropic import LiveStream

    state = agent_session.SessionState(row_id="row", session_id=SESSION_ID)

    async def scenario() -> list[tuple[str, dict[str, Any], str | None]]:
        live = LiveStream()
        original_stream = fake.beta.sessions.events.stream

        async def slow_stream(session_id: str, **kwargs: Any) -> Any:
            await asyncio.sleep(0.05)  # Anthropic のストリームを開くのに時間がかかる
            await original_stream(session_id, **kwargs)
            return live

        fake.beta.sessions.events.stream = slow_stream  # type: ignore[method-assign]

        def on_send(events: list[dict[str, Any]]) -> None:
            if events[0]["type"] == "user.message":
                for event in (ev("session.status_running"), ev("agent.message", content=[{"type": "text", "text": "返答です"}]), idle("end_turn")):
                    fake.history.append(event.to_dict(mode="json"))
                    live.push(event)

        fake.on_send = on_send
        prepared = await agent_session.prepare_stream(state, fake, None)
        # ここでヘッダーを返す。ブラウザはすぐ発言を送る
        await agent_session.send_message(state, fake, [{"type": "text", "text": "こんにちは"}])
        frames: list[str] = []
        async with contextlib.aclosing(agent_session.stream_frames(state, fake, prepared)) as gen:
            async for frame in gen:
                frames.append(frame)
                if "event: status" in frame and '"idle"' in frame:
                    break
        assert live.closed
        return parse_sse("".join(frames))

    import contextlib

    frames = asyncio.run(scenario())
    messages = [data for kind, data, _ in frames if kind == "message"]
    assert [data["text"] for data in messages] == ["返答です"]
    assert [kind for kind, _, _ in frames if kind != "usage"] == ["status", "message", "status"]


# ---- つなぎ直し ----


def reconnect_history() -> list[Any]:
    return [
        ev("agent.message", id="sevt_a", content=[{"type": "text", "text": "最初の返事"}]),
        tool_use("apply_policy", event_id="sevt_b"),
        tool_use("search_trips", event_id="sevt_c", scope="removed"),
        {"type": "user.custom_tool_result", "id": "sevt_r", "custom_tool_use_id": "sevt_c", "content": [{"type": "text", "text": "{}"}], "is_error": False, "processed_at": "2026-11-05T01:00:00Z"},
        ev("agent.message", id="sevt_d", content=[{"type": "text", "text": "続き"}]),
    ]


def test_reconnect_replays_after_last_event_id_and_dedupes_by_id(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = reconnect_history()
    fake.streams = [FakeStream([ev("agent.message", id="sevt_d", content=[{"type": "text", "text": "続き"}]), ev("agent.message", id="sevt_e", content=[{"type": "text", "text": "新しい"}])])]
    frames = stream(client, handle, last_event_id="sevt_a")
    assert [(kind, frame_id) for kind, _, frame_id in frames] == [
        ("tool_call", "sevt_b"),
        ("message", "sevt_d"),
        ("message", "sevt_e"),
        ("error", None),
    ]
    # ストリームを先に開き、その後に履歴を読む
    names = fake.names()
    assert names.index("events.stream") < names.index("events.list")


def test_reconnect_without_last_event_id_resends_only_unanswered_browser_calls(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = reconnect_history()
    fake.streams = [FakeStream([tool_use("apply_policy", event_id="sevt_b")])]  # 同じ id がストリームにも出る
    frames = stream(client, handle)
    assert [(kind, frame_id) for kind, _, frame_id in frames] == [("tool_call", "sevt_b"), ("error", None)]
    # 見つからない Last-Event-ID:履歴は送らない
    fake.streams = [FakeStream([])]
    frames = stream(client, handle, last_event_id="sevt_unknown")
    assert [(kind, frame_id) for kind, _, frame_id in frames] == [("tool_call", "sevt_b"), ("error", None)]


def test_reconnect_answers_server_tools_and_asks_exactly_once(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    server_call = tool_use("get_research_targets", event_id="sevt_srv")
    ask = ev("agent.tool_use", id="sevt_ask", name="web_fetch", input={"url": "https://example.jp"}, evaluated_permission="ask", session_thread_id=CHILD_THREAD)
    fake.history = [server_call, ask]
    fake.streams = [FakeStream([server_call, ask])]
    frames = stream(client, handle)
    assert len(fake.sent) == 1
    (events,) = fake.sent
    assert [event["type"] for event in events] == ["user.custom_tool_result", "user.tool_confirmation"]
    # 調査を始めていないので、対象は空(中身は test_research.py)
    assert events[0]["custom_tool_use_id"] == "sevt_srv" and events[0]["is_error"] is False
    assert tool_text(events[0]) == {"status": "ok", "targets": [], "total": 0, "max_targets": 30}
    assert events[1] == {
        "type": "user.tool_confirmation",
        "tool_use_id": "sevt_ask",
        "result": "deny",
        "deny_message": "確認できる人がいないので、この呼び出しは止めました。ほかの方法で調べてください",
    }
    assert ("tool_activity", {"name": "get_research_targets", "done": False}, None) in frames
    assert ("tool_activity", {"name": "get_research_targets", "done": True}, None) in frames
    assert "tool_call" not in kinds(frames)
    # もう一度つないでも、履歴に答えがあるので答えない
    fake.streams = [FakeStream([])]
    agent_session.reset_states()
    stream(client, handle)
    assert len(fake.sent) == 1


def test_rebuild_finds_pending_calls_asks_runs_and_last_idle() -> None:
    state = agent_session.SessionState(row_id="r", session_id=SESSION_ID, primary_thread_id=PRIMARY_THREAD)
    history = [
        agent_session.as_dict(event)
        for event in [
            tool_use("apply_policy", event_id="c1"),
            tool_use("run_validation", event_id="c2", thread=PRIMARY_THREAD),
            tool_use("save_research", event_id="c3", thread=RUN_THREAD),
            tool_use("apply_policy", event_id="c4", thread=CHILD_THREAD),
            ev("agent.tool_use", id="k1", name="web_search", input={}, evaluated_permission="ask", session_thread_id=CHILD_THREAD),
            ev("agent.tool_use", id="k2", name="web_search", input={}, evaluated_permission="allow", session_thread_id=CHILD_THREAD),
            ev("workflow_run.created", workflow_run_id="wrun_1", name="a", description=None, phases=[]),
            ev("workflow_run.created", workflow_run_id="wrun_2", name="b", description=None, phases=[]),
            ev("workflow_run.status_ended", workflow_run_id="wrun_2", result={"type": "stopped"}),
            idle("requires_action", event_ids=["c1"]),
        ]
    ] + [{"type": "user.custom_tool_result", "id": "x", "custom_tool_use_id": "c2", "processed_at": "t"}]
    state.rebuild(history)
    assert [call["id"] for call in state.pending_browser()] == ["c1"]
    assert [call["id"] for call in state.pending_server_side()] == ["c3", "c4"]
    assert [ask["id"] for ask in state.pending_asks()] == ["k1"]
    assert list(state.open_runs) == ["wrun_1"]
    assert state.last_stop_reason == "requires_action"
    assert state.interrupted is False


# ---- 送信 ----


def test_message_is_409_while_a_browser_tool_waits(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = [tool_use("apply_policy", event_id="sevt_wait")]
    response = post_events(client, handle, message())
    assert response.status_code == 409
    assert response.json()["detail"] == "AI がツールの結果を待っています。少し待ってから送ってください"
    assert fake.calls_named("events.send") == []


def test_message_answers_server_tools_and_asks_first(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = [
        tool_use("save_research", event_id="sevt_save", thread=RUN_THREAD, target_id="P29:1"),
        ev("agent.tool_use", id="sevt_ask", name="web_search", input={}, evaluated_permission="ask", session_thread_id=CHILD_THREAD),
    ]
    screen = "[画面の状態] 今日は 2026-11-05 です\n[画面の操作] 下書き d1 を承認しました"
    response = post_events(client, handle, message("続けてください", screen=screen))
    assert response.status_code == 200
    assert sent_types(fake) == [["user.custom_tool_result", "user.tool_confirmation"], ["user.message"]]
    assert fake.sent[1][0]["content"] == [{"type": "text", "text": screen}, {"type": "text", "text": "続けてください"}]
    assert fake.calls_named("sessions.retrieve")  # 発言のときも利用額を読む
    row = row_of(handle)
    assert row["messages"] == 1


def test_message_rejected_by_anthropic_reads_the_state(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)

    def refuse(events: list[dict[str, Any]]) -> None:
        if events[0]["type"] == "user.message":
            fake.history.append(idle("requires_action", event_ids=["sevt_elsewhere"]))
            raise bad_request()

    fake.on_send = refuse
    response = post_events(client, handle, message())
    assert response.status_code == 409
    assert "secret-upstream-text" not in response.text
    # 状態が idle(end_turn)なら 502
    def refuse_only(events: list[dict[str, Any]]) -> None:
        if events[0]["type"] == "user.message":
            raise bad_request()

    fake.on_send = refuse_only
    fake.history = [idle("end_turn")]
    response = post_events(client, handle, message())
    assert response.status_code == 502 and response.json()["detail"] == "AI に送れませんでした。もう一度送ってください"


def test_budget_reached_blocks_messages_but_accepts_results(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = [tool_use("apply_policy", event_id="sevt_wait"), ev("session.usage", usage={"list_cost": {"amount": "301", "currency": "USD"}}), idle("budget_reached")]
    response = post_events(client, handle, message())
    assert response.status_code == 409 and "上限" in response.json()["detail"]
    assert post_events(client, handle, {"kind": "tool_results", "results": [result("sevt_wait")]}).status_code == 200
    assert sent_types(fake) == [["user.custom_tool_result"]]


def test_tool_results_and_interrupt(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = [tool_use("apply_policy", event_id="sevt_1"), tool_use("search_trips", event_id="sevt_2"), tool_use("run_validation", event_id="sevt_3")]
    assert post_events(client, handle, {"kind": "tool_results", "results": [result("sevt_unknown")]}).status_code == 409
    response = post_events(client, handle, {"kind": "tool_results", "results": [result("sevt_1", "結果", False), result("sevt_2", "失敗", True)]})
    assert response.status_code == 200
    assert fake.sent[0] == [
        {"type": "user.custom_tool_result", "custom_tool_use_id": "sevt_1", "content": [{"type": "text", "text": "結果"}], "is_error": False},
        {"type": "user.custom_tool_result", "custom_tool_use_id": "sevt_2", "content": [{"type": "text", "text": "失敗"}], "is_error": True},
    ]
    # 同じ呼び出しにもう一度答えようとすると 409(ブラウザは届いたものとして扱う)
    assert post_events(client, handle, {"kind": "tool_results", "results": [result("sevt_1")]}).status_code == 409
    response = post_events(client, handle, {"kind": "interrupt", "results": [result("sevt_3", "利用者が止めました", True)]})
    assert response.status_code == 200
    assert sent_types(fake)[1] == ["user.custom_tool_result", "user.interrupt"]
    assert "session_thread_id" not in fake.sent[1][1]
    assert post_events(client, handle, {"kind": "interrupt"}).status_code == 200
    assert sent_types(fake)[2] == ["user.interrupt"]
    assert row_of(handle)["tool_calls"] == 3


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"kind": "message", "content": [{"type": "text", "text": "a"}], "model": "x"}, 400),
        ({"kind": "message", "content": [{"type": "text", "text": "a", "cache_control": {}}]}, 400),
        ({"kind": "message", "content": [{"type": "image", "source": {}}]}, 400),
        ({"kind": "message", "content": []}, 400),
        ({"kind": "message", "content": [{"type": "text", "text": "a"}] * 3}, 400),
        ({"kind": "message", "content": [{"type": "text", "text": "   "}]}, 400),
        ({"kind": "message", "content": [{"type": "text", "text": "[画面の状態] a\n利用者の文"}, {"type": "text", "text": "b"}]}, 400),
        ({"kind": "message", "content": [{"type": "text", "text": "画面の状態 a"}, {"type": "text", "text": "b"}]}, 400),
        ({"kind": "message", "content": [{"type": "text", "text": "あ" * 11000}]}, 413),
        ({"kind": "tool_results", "results": []}, 400),
        ({"kind": "tool_results", "results": [result("a")] * 2}, 400),
        ({"kind": "tool_results", "results": [{**result("a"), "extra": 1}]}, 400),
        ({"kind": "tool_results", "results": [{**result("a"), "is_error": "false"}]}, 400),
        ({"kind": "tool_results", "results": [result(f"a{i}") for i in range(11)]}, 400),
        ({"kind": "tool_results", "results": [result("a", "x" * (32 * 1024 + 1))]}, 413),
        ({"kind": "tool_results", "results": [result("a")], "interrupt": True}, 400),
        ({"kind": "interrupt", "session_thread_id": "sthr_x"}, 400),
        ({"kind": "user.message", "content": []}, 400),
        ([], 400),
    ],
)
def test_bad_event_bodies(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, body: Any, status: int) -> None:
    enable(monkeypatch)
    handle = create(client)
    assert post_events(client, handle, body).status_code == status
    assert fake.calls_named("events.send") == []


def test_body_over_400kb_is_413(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    body = {"kind": "tool_results", "results": [result(f"a{i}", "x" * 32000) for i in range(10)], "pad": "y" * 100000}
    assert post_events(client, handle, body).status_code == 413


def test_messages_per_ip_hour(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_MESSAGES_PER_IP_HOUR", "2")
    handle = create(client)
    assert post_events(client, handle, message()).status_code == 200
    assert post_events(client, handle, message()).status_code == 200
    response = post_events(client, handle, message())
    assert response.status_code == 429 and "発言" in response.json()["detail"]


# ---- ツールの呼び出しの上限 ----


def test_thirteenth_browser_call_is_refused_with_an_interrupt(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    calls = [tool_use("search_trips", event_id=f"sevt_call_{i:02d}", scope="removed") for i in range(1, 14)]
    fake.streams = [FakeStream([*calls, idle("end_turn", id="sevt_after")])]
    frames = stream(client, handle)
    tool_calls = [frame[2] for frame in frames if frame[0] == "tool_call"]
    assert tool_calls == [f"sevt_call_{i:02d}" for i in range(1, 13)]
    (events,) = fake.sent
    assert [event["type"] for event in events] == ["user.custom_tool_result", "user.interrupt"]
    assert events[0]["custom_tool_use_id"] == "sevt_call_13" and events[0]["is_error"] is True
    assert tool_text(events[0])["message"] == "ツールの呼び出しが多すぎるので止めます"
    assert ("error", {"message": "AI がこの相談でツールを 12 回使ったので、ここで止めました。続けるときは「続きを頼む」を押してください", "code": "too_many_tool_calls", "limit": 12}, None) in frames
    assert ("status", {"state": "idle", "reason": "interrupted"}, "sevt_after") in frames


def test_user_interrupt_marks_the_next_end_turn_as_interrupted(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    assert post_events(client, handle, {"kind": "interrupt"}).status_code == 200
    fake.streams = [FakeStream([idle("end_turn", id="sevt_i1"), idle("end_turn", id="sevt_i2")])]
    frames = [frame for frame in stream(client, handle) if frame[0] == "status"]
    # 履歴の interrupt の後の idle がまだ無いので、次の end_turn を interrupted と知らせる。その次は普通に
    assert frames == [("status", {"state": "idle", "reason": "interrupted"}, "sevt_i1"), ("status", {"state": "idle", "reason": "end_turn"}, "sevt_i2")]


# ---- サーバーのツール・調査の中からの呼び出し ----


def test_server_tools_answer_without_waiting_for_idle_and_only_once(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    save = tool_use("save_research", event_id="sevt_save", thread=RUN_THREAD, target_id="P29:1", status="found")
    fake.streams = [
        FakeStream(
            [
                ev("workflow_run.created", workflow_run_id="wrun_1", name="調査", description=None, phases=[]),
                save,
                save,  # 同じイベントがもう一度届いても二重に答えない
                tool_use("get_research_targets", event_id="sevt_t"),
                tool_use("get_research_results", event_id="sevt_r", target_ids=None),
                tool_use("get_research_targets", event_id="sevt_t_child", thread=CHILD_THREAD),
                tool_use("save_research", event_id="sevt_save_primary"),
                tool_use("no_such_tool", event_id="sevt_unknown"),
            ]
        )
    ]
    frames = stream(client, handle)
    answered = [
        (events[0]["custom_tool_use_id"], events[0]["is_error"], tool_text(events[0]).get("message", "").split("。")[0])
        for events in fake.sent
    ]
    # ツールの中身は test_research.py。ここでは振り分けと、1回ずつ答えることを見る
    assert answered == [
        ("sevt_save", True, "save_research の入力が正しくありません"),
        ("sevt_t", False, ""),
        ("sevt_r", False, ""),
        ("sevt_t_child", True, "このツールは調整役だけが使えます"),
        ("sevt_save_primary", True, "このツールは調査役だけが使えます"),
        ("sevt_unknown", True, "このツールはありません"),
    ]
    assert all(len(events) == 1 for events in fake.sent)
    assert "tool_call" not in kinds(frames)
    assert [frame[1] for frame in frames if frame[0] == "tool_activity"][:2] == [
        {"name": "save_research", "done": False},
        {"name": "save_research", "done": True},
    ]


def test_browser_tools_from_research_threads_are_refused_and_not_sent_to_the_browser(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.streams = [
        FakeStream(
            [
                tool_use("apply_policy", event_id="sevt_child", thread=CHILD_THREAD, kind="weekday_to_saturday"),
                tool_use("add_back_trips", event_id="sevt_run", thread=RUN_THREAD, items=[]),
                tool_use("apply_policy", event_id="sevt_main", thread=PRIMARY_THREAD),
            ]
        )
    ]
    frames = stream(client, handle)
    assert [frame[2] for frame in frames if frame[0] == "tool_call"] == ["sevt_main"]
    refused = [events[0] for events in fake.sent]
    assert [event["custom_tool_use_id"] for event in refused] == ["sevt_child", "sevt_run"]
    assert all(event["is_error"] and tool_text(event)["message"] == "このツールは調査の中では使えません" for event in refused)


def test_finished_delegated_threads_are_archived_but_not_run_or_primary_threads(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.streams = [
        FakeStream(
            [
                ev("session.thread_status_idle", session_thread_id=RUN_THREAD, agent_name="dispatcher-researcher", stop_reason={"type": "end_turn"}),
                ev("session.thread_status_idle", session_thread_id=PRIMARY_THREAD, agent_name="dispatcher-coordinator", stop_reason={"type": "end_turn"}),
                ev("session.thread_status_idle", session_thread_id=CHILD_THREAD, agent_name="dispatcher-researcher", stop_reason={"type": "requires_action", "event_ids": []}),
                ev("session.thread_status_idle", session_thread_id=CHILD_THREAD, agent_name="dispatcher-researcher", stop_reason={"type": "end_turn"}),
            ]
        )
    ]
    stream(client, handle)
    assert fake.calls_named("threads.archive") == [{"thread_id": CHILD_THREAD, "session_id": SESSION_ID}]
    assert [call["thread_id"] for call in fake.calls_named("threads.retrieve")] == [RUN_THREAD, CHILD_THREAD]


# ---- 料金 ----


def test_idle_reads_list_cost_into_the_ledger(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.cost_cents = 42
    fake.streams = [FakeStream([idle("end_turn")])]
    frames = stream(client, handle)
    assert ("usage", {"cost_cents": 42, "budget_cents": 300}, None) in frames
    store = get_store()
    today = jst_day(time.time())
    assert store.ledger_cents(today) == 42
    fake.cost_cents = 50
    fake.streams = [FakeStream([idle("end_turn")])]
    stream(client, handle)
    assert store.ledger_cents(today) == 50  # 差だけを足す
    assert row_of(handle)["cost_cents"] == 50


# ---- 終える ----


def test_delete_without_runs_settles_interrupts_then_deletes(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, caplog: pytest.LogCaptureFixture) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = [tool_use("apply_policy", event_id="sevt_b"), tool_use("save_research", event_id="sevt_s", thread=CHILD_THREAD), ev("agent.tool_use", id="sevt_k", name="web_search", input={}, evaluated_permission="ask", session_thread_id=CHILD_THREAD)]
    fake.cost_cents = 33
    caplog.set_level(logging.INFO)
    response = client.delete("/api/claude/session", headers=headers(handle))
    assert response.status_code == 202
    (events,) = fake.sent
    assert [event["type"] for event in events] == ["user.custom_tool_result", "user.custom_tool_result", "user.tool_confirmation", "user.interrupt"]
    assert all(tool_text(event)["message"] == "GTFS が読み込み直されたので止めました" for event in events[:2])
    names = [name for name in fake.names() if name in ("events.send", "sessions.retrieve", "sessions.delete")]
    assert names == ["events.send", "sessions.retrieve", "sessions.delete"]
    row = row_of(handle)
    assert row["deleted_at"] is not None and row["session_id"] == "" and row["ended_at"] is not None
    assert row["cost_cents"] == 33
    assert "cost_cents=33" in caplog.text and "active_seconds=12.5" in caplog.text and "web_search_requests=3" in caplog.text
    assert post_events(client, handle, message()).status_code == 410


def test_delete_with_an_open_run_asks_the_coordinator_to_stop_it_first(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = [ev("workflow_run.created", workflow_run_id="wrun_1", name="調査", description=None, phases=[]), tool_use("save_research", event_id="sevt_s", thread=RUN_THREAD)]
    late_call = tool_use("save_research", event_id="sevt_late", thread=RUN_THREAD)
    fake.streams = [FakeStream([late_call, ev("workflow_run.status_ended", workflow_run_id="wrun_1", result={"type": "stopped"})], hang=True)]
    fake.statuses = ["running", "idle"]
    monkeypatch.setattr(agent_session, "DELETE_POLL_INTERVAL", 0.0)
    assert client.delete("/api/claude/session", headers=headers(handle)).status_code == 202
    assert sent_types(fake) == [["user.custom_tool_result"], ["user.message"], ["user.custom_tool_result"], ["user.interrupt"]]
    assert fake.sent[1][0]["content"][0]["text"] == "調査の run をすべて止めてください。新しい run は始めないでください。"
    assert fake.sent[2][0]["custom_tool_use_id"] == "sevt_late"
    assert fake.names()[-3:] == ["sessions.retrieve", "sessions.retrieve", "sessions.delete"]
    assert row_of(handle)["deleted_at"] is not None


def test_delete_at_the_budget_with_a_run_open_sends_only_the_interrupt(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.history = [ev("workflow_run.created", workflow_run_id="wrun_1", name="調査", description=None, phases=[]), idle("budget_reached")]
    fake.streams = [FakeStream([ev("workflow_run.status_ended", workflow_run_id="wrun_1", result={"type": "stopped"})])]
    assert client.delete("/api/claude/session", headers=headers(handle)).status_code == 202
    assert sent_types(fake) == [["user.interrupt"]]
    assert fake.calls_named("sessions.delete")


def test_refused_delete_marks_the_row_pending(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    fake.delete_error = bad_request("workflow_run_open")
    assert client.delete("/api/claude/session", headers=headers(handle)).status_code == 202
    row = row_of(handle)
    assert row["delete_pending"] == 1 and row["delete_attempts"] == 1 and row["deleted_at"] is None
    assert row["ended_at"] is not None  # 取っ手はもう使えない
    # still running のままでも消さない
    fake.delete_error = None
    fake.statuses = ["running"] * 20
    monkeypatch.setattr(agent_session, "DELETE_POLL_INTERVAL", 0.0)
    import asyncio

    assert asyncio.run(agent_session.end_session(row["row_id"], fake)) is False
    assert row_of(handle)["delete_attempts"] == 2
    assert len(fake.calls_named("sessions.delete")) == 1


# ---- 掃除 ----


def test_sweep_deletes_old_and_pending_rows_and_keeps_new_ones(monkeypatch: pytest.MonkeyPatch, fake: FakeAnthropic, caplog: pytest.LogCaptureFixture) -> None:
    import asyncio

    enable(monkeypatch)
    store = get_store()
    now = time.time()
    store.insert_session("old_row", "sesn_old", 1, now - 25 * 3600)
    store.insert_session("new_row", "sesn_new", 1, now - 3600)
    store.insert_session("pending_row", "sesn_pending", 1, now - 60)
    store.mark_delete_failed("pending_row")
    fake.cost_cents = 5
    asyncio.run(agent_session.sweep_once(lambda: fake, now=now))
    deleted = [call["session_id"] for call in fake.calls_named("sessions.delete")]
    assert deleted == ["sesn_old", "sesn_pending"]
    assert store.get_session("old_row")["deleted_at"] is not None
    assert store.get_session("new_row")["deleted_at"] is None and store.get_session("new_row")["ended_at"] is None
    # 終えていない行の利用額も読む
    assert store.get_session("new_row")["cost_cents"] == 5
    # 消してから 2 日たった行は表から消える
    asyncio.run(agent_session.sweep_once(lambda: fake, now=now + 3 * 86400))
    assert store.get_session("old_row") is None


def test_sweep_keeps_trying_after_three_refusals_and_logs_only_the_type(monkeypatch: pytest.MonkeyPatch, fake: FakeAnthropic, caplog: pytest.LogCaptureFixture) -> None:
    import asyncio

    enable(monkeypatch)
    store = get_store()
    now = time.time()
    store.insert_session("stuck", "sesn_stuck_secret", 1, now - 30 * 3600)
    fake.delete_error = bad_request()
    caplog.set_level(logging.INFO)
    for _ in range(4):
        asyncio.run(agent_session.sweep_once(lambda: fake, now=now))
    row = store.get_session("stuck")
    assert row["delete_attempts"] == 4 and row["deleted_at"] is None
    assert "attempts=3" in caplog.text and "BadRequestError" in caplog.text
    assert "secret-upstream-text" not in caplog.text and "sesn_stuck_secret" not in caplog.text
    assert len(fake.calls_named("sessions.delete")) == 4


def test_sweep_without_api_key_only_purges(fake: FakeAnthropic) -> None:
    import asyncio

    store = get_store()
    now = time.time()
    store.insert_session("x", "sesn_x", 1, now - 30 * 3600)
    asyncio.run(agent_session.sweep_once(lambda: fake, now=now))
    assert fake.calls == []


# ---- ログ ----


def test_logs_never_contain_messages_tool_io_handles_session_ids_ips_or_keys(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, caplog: pytest.LogCaptureFixture) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_TRUST_PROXY", "1")
    caplog.set_level(logging.DEBUG)
    ip = {"X-Real-IP": "203.0.113.77"}
    handle = create(client, **ip)
    fake.streams = [FakeStream([tool_use("apply_policy", event_id="sevt_log", kind="ツールの入力の秘密"), ev("agent.message", content=[{"type": "text", "text": "返事の秘密"}])])]
    stream_response = client.get("/api/claude/session/stream", headers=headers(handle, **ip))
    assert stream_response.status_code == 200
    post_events(client, handle, {"kind": "tool_results", "results": [result("sevt_log", "ツールの結果の秘密")]}, **ip)
    post_events(client, handle, message("発言の秘密", screen="[画面の状態] 画面の秘密"), **ip)
    post_events(client, "v1.bad.handle", message(), **ip)
    client.post("/api/claude/session/research/known", json={"target_ids": ["P29:対象の秘密"]}, headers=headers(handle, **ip))
    client.delete("/api/claude/session", headers=headers(handle, **ip))
    text = caplog.text
    assert "agent " in text  # ログ自体は出ている
    for secret in ("P29:対象の秘密", "ツールの入力の秘密", "返事の秘密", "ツールの結果の秘密", "発言の秘密", "画面の秘密", handle, handle.split(".")[2], SESSION_ID, "203.0.113.77", API_KEY, TOKEN, SECRET):
        assert secret not in text, secret


# ---- .env ----


def test_load_env_reads_the_file_but_never_overrides_existing_variables(monkeypatch: pytest.MonkeyPatch, tmp_path: Any, caplog: pytest.LogCaptureFixture) -> None:
    import os

    env_file = tmp_path / ".env"
    env_file.write_text(
        "# コメント\nDISPATCHER_TEST_NEW=from-file\nDISPATCHER_TEST_KEPT=from-file\n"
        'DISPATCHER_TEST_EMPTY=from-file\nDISPATCHER_TEST_QUOTED="a b"\n',
        encoding="utf-8",
    )
    environ = {"DISPATCHER_TEST_KEPT": "from-process", "DISPATCHER_TEST_EMPTY": ""}
    monkeypatch.setattr(os, "environ", environ)
    caplog.set_level(logging.DEBUG)
    assert settings.load_env(env_file) is True
    assert environ["DISPATCHER_TEST_NEW"] == "from-file"
    assert environ["DISPATCHER_TEST_QUOTED"] == "a b"
    assert environ["DISPATCHER_TEST_KEPT"] == "from-process"  # 既にある環境変数は上書きしない
    assert environ["DISPATCHER_TEST_EMPTY"] == ""
    assert "from-file" not in caplog.text  # 読んだ値をログに出さない


def test_load_env_without_a_file_does_nothing(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    import os

    environ: dict[str, str] = {}
    monkeypatch.setattr(os, "environ", environ)
    assert settings.load_env(tmp_path / "missing.env") is False
    monkeypatch.setattr(settings, "REPO_ROOT", tmp_path)  # 既定の場所はリポジトリ直下の .env
    assert settings.load_env() is False
    (tmp_path / ".env").write_text("DISPATCHER_TEST_DEFAULT=1\n", encoding="utf-8")
    assert settings.load_env() is True
    assert environ == {"DISPATCHER_TEST_DEFAULT": "1"}


def test_env_example_lists_the_variables_without_values_for_secrets() -> None:
    example = (settings.REPO_ROOT / ".env.example").read_text(encoding="utf-8")
    assigned = {}
    for line in example.splitlines():
        stripped = line.lstrip("# ").strip()
        if "=" in stripped and stripped.split("=", 1)[0].isupper():
            name, _, value = stripped.partition("=")
            assigned[name.strip()] = value.strip()
    for name in (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_WORKSPACE_ID",
        "DISPATCHER_AGENT_ID",
        "DISPATCHER_AGENT_VERSION",
        "DISPATCHER_ENVIRONMENT_ID",
        "DISPATCHER_SESSION_SECRET",
        "DISPATCHER_TOKEN",
        "DISPATCHER_DEV",
        "DISPATCHER_PUBLIC",
        "DISPATCHER_TRUST_PROXY",
        "DISPATCHER_DB",
        "DISPATCHER_SESSION_BUDGET_CENTS",
        "DISPATCHER_SESSION_TTL_HOURS",
        "DISPATCHER_SESSIONS_PER_IP_HOUR",
        "DISPATCHER_SESSIONS_PER_IP_DAY",
        "DISPATCHER_MESSAGES_PER_IP_HOUR",
        "DISPATCHER_SESSIONS_PER_DAY",
        "DISPATCHER_DAILY_COST_CENTS",
    ):
        assert name in assigned, name
    for secret in ("ANTHROPIC_API_KEY", "DISPATCHER_TOKEN", "DISPATCHER_SESSION_SECRET", "DISPATCHER_AGENT_ID", "DISPATCHER_ENVIRONMENT_ID"):
        assert assigned[secret] == "", secret
    assert "sk-ant" not in example


def test_token_with_non_ascii_bytes_is_401_not_500(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    response = client.post("/api/claude/session", json={}, headers={"X-Dispatcher-Token": "合言葉".encode("utf-8")})
    assert response.status_code == 401
    monkeypatch.setenv("DISPATCHER_TOKEN", "合言葉")
    response = client.post("/api/claude/session", json={}, headers={"X-Dispatcher-Token": "合言葉".encode("utf-8")})
    assert response.status_code == 200


def test_message_without_a_connected_stream_rebuilds_from_history(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    # サーバーの再起動の後(メモリの状態が無い)でも、履歴の答えていない呼び出しを見つけて 409 にする
    agent_session.reset_states()
    fake.history = [tool_use("undo_edit", event_id="sevt_restart")]
    assert post_events(client, handle, message()).status_code == 409
    assert "events.list" in fake.names()
    assert post_events(client, handle, {"kind": "tool_results", "results": [result("sevt_restart")]}).status_code == 200
    assert post_events(client, handle, message()).status_code == 200
    assert sent_types(fake) == [["user.custom_tool_result"], ["user.message"]]


def test_open_run_reads_usage_periodically_even_while_events_keep_coming(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setattr(agent_session, "RUN_RETRIEVE_SECONDS", 0.0)
    handle = create(client)
    fake.cost_cents = 11
    fake.streams = [
        FakeStream(
            [
                ev("workflow_run.created", workflow_run_id="wrun_1", name="調査", description=None, phases=[]),
                ev("session.thread_status_running", session_thread_id=RUN_THREAD, agent_name="dispatcher-researcher"),
                ev("session.thread_status_running", session_thread_id=RUN_THREAD, agent_name="dispatcher-researcher"),
                ev("session.thread_status_running", session_thread_id=RUN_THREAD, agent_name="dispatcher-researcher"),
            ]
        )
    ]
    frames = stream(client, handle)
    assert len(fake.calls_named("sessions.retrieve")) >= 2  # idle は1回も来ていない
    assert ("usage", {"cost_cents": 11, "budget_cents": 300}, None) in frames
    assert get_store().ledger_cents(jst_day(time.time())) == 11
