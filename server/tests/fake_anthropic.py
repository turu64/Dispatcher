"""テスト用の、Anthropic の SDK(非同期のクライアントの beta.sessions)の偽物。本物の API は呼ばない。

- 呼び出しの名前と引数の形は、入れた SDK(anthropic 2.4.0)の AsyncSessions・AsyncEvents・AsyncThreads に合わせた
  (events.stream は await してから async for、events.list と threads.list は async for でページを読む)
- イベントは SDK の型(BetaManagedAgentsStreamSessionEvents)で確かめてから渡す(項目名の誤りを SDK で見つける)
- events.send で送ったイベントは、本物と同じく履歴に足す(user.interrupt の id は空)
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import Callable
from typing import Any

import anthropic
import httpx2
from anthropic._models import validate_type
from anthropic.types.beta.sessions.beta_managed_agents_stream_session_events import (
    BetaManagedAgentsStreamSessionEvents,
)

PROCESSED_AT = "2026-11-05T01:00:00Z"
SESSION_ID = "sesn_test_0123456789"
PRIMARY_THREAD = "sthr_primary"
CHILD_THREAD = "sthr_child"
RUN_THREAD = "sthr_run"

_ids = itertools.count(1)


def ev(kind: str, **fields: Any) -> Any:
    """SDK の型で確かめたイベント。id と processed_at は省けば付ける(event_start・event_delta には付けない)。"""
    data: dict[str, Any] = {"type": kind, **fields}
    if kind not in ("event_start", "event_delta"):
        data.setdefault("id", f"sevt_{next(_ids):04d}")
        data.setdefault("processed_at", PROCESSED_AT)
    return validate_type(type_=BetaManagedAgentsStreamSessionEvents, value=data)


def tool_use(name: str, *, thread: str | None = None, event_id: str | None = None, **input_: Any) -> Any:
    fields: dict[str, Any] = {"name": name, "input": input_}
    if thread is not None:
        fields["session_thread_id"] = thread
    if event_id is not None:
        fields["id"] = event_id
    return ev("agent.custom_tool_use", **fields)


def idle(reason: str, **fields: Any) -> Any:
    stop: dict[str, Any] = {"type": reason}
    if reason == "requires_action":
        stop["event_ids"] = fields.pop("event_ids", [])
    return ev("session.status_idle", stop_reason=stop, **fields)


def bad_request(message: str = "anthropic の英語の文 secret-upstream-text") -> anthropic.BadRequestError:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/sessions/x/events")
    response = httpx2.Response(400, request=request)
    return anthropic.BadRequestError(message, response=response, body={"error": {"message": message}})


def not_found() -> anthropic.NotFoundError:
    request = httpx2.Request("DELETE", "https://api.anthropic.com/v1/sessions/x")
    response = httpx2.Response(404, request=request)
    return anthropic.NotFoundError("not found", response=response, body=None)


class FakePaginator:
    def __init__(self, items: list[Any]) -> None:
        self.items = list(items)

    def __aiter__(self) -> Any:
        return self._gen()

    async def _gen(self) -> Any:
        for item in self.items:
            yield item


class FakeStream:
    """events.stream の結果。events を順に出して終わる(hang=True なら終わらずに待つ)。"""

    def __init__(self, events: list[Any], *, hang: bool = False, error: Exception | None = None) -> None:
        self.events = events
        self.hang = hang
        self.error = error
        self.closed = False

    def __aiter__(self) -> Any:
        return self._gen()

    async def _gen(self) -> Any:
        for event in self.events:
            yield event
        if self.error is not None:
            raise self.error
        if self.hang:
            await asyncio.Event().wait()

    async def close(self) -> None:
        self.closed = True


class LiveStream:
    """events.stream の結果で、テストが後から push したイベントを届ける(push しなければ待ち続ける)。"""

    def __init__(self) -> None:
        self.queue: asyncio.Queue[Any] = asyncio.Queue()
        self.closed = False

    def push(self, event: Any) -> None:
        self.queue.put_nowait(event)

    def __aiter__(self) -> Any:
        return self._gen()

    async def _gen(self) -> Any:
        while True:
            yield await self.queue.get()

    async def close(self) -> None:
        self.closed = True


class FakeEvents:
    def __init__(self, fake: "FakeAnthropic") -> None:
        self.fake = fake

    def list(self, session_id: str, **kwargs: Any) -> FakePaginator:
        self.fake.calls.append(("events.list", {"session_id": session_id, **kwargs}))
        return FakePaginator(self.fake.history)

    async def send(self, session_id: str, *, events: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
        self.fake.calls.append(("events.send", {"session_id": session_id, "events": events, **kwargs}))
        self.fake.sent.append(events)
        if self.fake.on_send is not None:
            self.fake.on_send(events)
        for event in events:
            echo = dict(event)
            echo["id"] = "" if event["type"] == "user.interrupt" else f"sevt_echo_{next(_ids):04d}"
            echo["processed_at"] = PROCESSED_AT
            self.fake.history.append(echo)
        return {"data": []}

    async def stream(self, session_id: str, **kwargs: Any) -> FakeStream:
        self.fake.calls.append(("events.stream", {"session_id": session_id, **kwargs}))
        if self.fake.stream_error is not None:
            raise self.fake.stream_error
        stream = self.fake.streams.pop(0) if self.fake.streams else FakeStream([])
        self.fake.opened_streams.append(stream)
        return stream


class FakeThreads:
    def __init__(self, fake: "FakeAnthropic") -> None:
        self.fake = fake

    def list(self, session_id: str, **kwargs: Any) -> FakePaginator:
        self.fake.calls.append(("threads.list", {"session_id": session_id, **kwargs}))
        return FakePaginator(list(self.fake.threads.values()))

    async def retrieve(self, thread_id: str, *, session_id: str, **kwargs: Any) -> dict[str, Any]:
        self.fake.calls.append(("threads.retrieve", {"thread_id": thread_id, "session_id": session_id}))
        return self.fake.threads[thread_id]

    async def archive(self, thread_id: str, *, session_id: str, **kwargs: Any) -> dict[str, Any]:
        self.fake.calls.append(("threads.archive", {"thread_id": thread_id, "session_id": session_id}))
        return self.fake.threads[thread_id]


class FakeSessions:
    def __init__(self, fake: "FakeAnthropic") -> None:
        self.fake = fake
        self.events = FakeEvents(fake)
        self.threads = FakeThreads(fake)

    async def create(self, **kwargs: Any) -> dict[str, Any]:
        self.fake.calls.append(("sessions.create", kwargs))
        if self.fake.create_error is not None:
            raise self.fake.create_error
        return {"id": SESSION_ID, "type": "session", "status": "idle"}

    async def retrieve(self, session_id: str, **kwargs: Any) -> dict[str, Any]:
        self.fake.calls.append(("sessions.retrieve", {"session_id": session_id}))
        status = self.fake.statuses.pop(0) if self.fake.statuses else "idle"
        return {
            "id": session_id,
            "status": status,
            "usage": {
                "list_cost": {"amount": str(self.fake.cost_cents), "currency": "USD"},
                "active_seconds": 12.5,
                "server_tool_use": {"web_search_requests": 3},
            },
        }

    async def delete(self, session_id: str, **kwargs: Any) -> dict[str, Any]:
        self.fake.calls.append(("sessions.delete", {"session_id": session_id}))
        if self.fake.delete_error is not None:
            raise self.fake.delete_error
        return {"id": session_id, "type": "session_deleted"}


class FakeBeta:
    def __init__(self, fake: "FakeAnthropic") -> None:
        self.sessions = FakeSessions(fake)


class FakeAnthropic:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.sent: list[list[dict[str, Any]]] = []
        self.history: list[Any] = []
        self.streams: list[FakeStream] = []
        self.opened_streams: list[FakeStream] = []
        self.threads: dict[str, dict[str, Any]] = {
            PRIMARY_THREAD: {"id": PRIMARY_THREAD, "parent_thread_id": None, "workflow_run_id": None},
            CHILD_THREAD: {"id": CHILD_THREAD, "parent_thread_id": PRIMARY_THREAD, "workflow_run_id": None},
            RUN_THREAD: {"id": RUN_THREAD, "parent_thread_id": PRIMARY_THREAD, "workflow_run_id": "wrun_1"},
        }
        self.statuses: list[str] = []
        self.cost_cents = 0
        self.on_send: Callable[[list[dict[str, Any]]], None] | None = None
        self.create_error: Exception | None = None
        self.delete_error: Exception | None = None
        self.stream_error: Exception | None = None
        self.beta = FakeBeta(self)

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]

    def calls_named(self, name: str) -> list[dict[str, Any]]:
        return [kwargs for call, kwargs in self.calls if call == name]
