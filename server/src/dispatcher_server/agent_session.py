"""Managed Agents のセッションの中継の中身。docs/interfaces-1105.md §4。

- セッションの状態(答えていないツールの呼び出し・許可の確認・開いている workflow run・最後の idle)は、
  いつでも events.list の履歴から作り直せる(rebuild)。メモリの状態は、その写しと、
  サーバーが user.interrupt を送ったこと・1回の発言のツールの呼び出しの数・この発言で止めたかの印だけ
- ブラウザのストリーム1本につき、Anthropic のストリームを1本開く(open_stream)。つなぐたびに履歴と重ね、
  イベントの id で重なりを除く
- サーバーが実行するツール(SERVER_TOOLS)と許可の確認(ask)には、イベントが届いた時点で答える(settle)
- セッションを終える手順(end_session)は、DELETE と掃除(sweep_once)で同じものを使う

ログに残すのは、日時・回数・エラーの種類・行の ID だけ。発言・ツールの入力と結果・取っ手・
Anthropic のセッションの ID・IP アドレス・API キーは書かない(§4.12)。
"""

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field
from functools import lru_cache
from importlib import resources
from typing import Any

import anthropic

from . import research, settings
from .store import get_store

logger = logging.getLogger("dispatcher_server.agent")

# ---- ツール ----


@lru_cache(maxsize=1)
def browser_tool_names() -> frozenset[str]:
    """ブラウザが実行する6つ(名前の正は claude_tools.json。§3.1)。"""
    text = resources.files("dispatcher_server").joinpath("claude_tools.json").read_text(encoding="utf-8")
    return frozenset(tool["name"] for tool in json.loads(text))


# サーバーが実行する3つ(§3.2)。主のスレッドからだけ受け付けるものと、調査役のスレッドからだけ受け付けるもの
PRIMARY_SERVER_TOOLS = ("get_research_targets", "get_research_results")
RESEARCHER_SERVER_TOOLS = ("save_research",)
SERVER_TOOLS = PRIMARY_SERVER_TOOLS + RESEARCHER_SERVER_TOOLS

EVENT_DELTAS = ["agent.message", "agent.thinking"]

# 1回の発言につき、ブラウザのツールの呼び出しは 12 回まで(§4.7)
MAX_BROWSER_CALLS_PER_MESSAGE = 12

# 時間(テストで差し替える)
PING_SECONDS = 15.0
RUN_RETRIEVE_SECONDS = 60.0
STOP_RUNS_WAIT_SECONDS = 60.0
DELETE_POLL_INTERVAL = 0.2
DELETE_POLL_TRIES = 10
SWEEP_INTERVAL_SECONDS = 15 * 60

# ---- 文 ----

MSG_TOOL_IN_RESEARCH = "このツールは調査の中では使えません"
MSG_UNKNOWN_TOOL = "このツールはありません"
MSG_PRIMARY_ONLY = "このツールは調整役だけが使えます"
MSG_RESEARCHER_ONLY = "このツールは調査役だけが使えます"
MSG_TOO_MANY_CALLS = "ツールの呼び出しが多すぎるので止めます"
MSG_RELOADED = "GTFS が読み込み直されたので止めました"
DENY_MESSAGE = "確認できる人がいないので、この呼び出しは止めました。ほかの方法で調べてください"
STOP_RUNS_MESSAGE = "調査の run をすべて止めてください。新しい run は始めないでください。"

ERR_STOPPED_LONG = (
    f"AI がこの相談でツールを {MAX_BROWSER_CALLS_PER_MESSAGE} 回使ったので、ここで止めました。"
    "続けるときは「続きを頼む」を押してください"
)
ERR_RETRIES = "AI の処理が続けられなくなりました。もう一度送ってください"
ERR_SESSION = "AI の処理でエラーが起きました"
ERR_UPSTREAM = "AI との接続が切れました。つなぎ直します"

MSG_WAITING_TOOLS = "AI がツールの結果を待っています。少し待ってから送ってください"
MSG_BUDGET = "この会話の AI の利用額が上限に達しました。続けるときは「新しく始める」を押してください"
MSG_SEND_FAILED = "AI に送れませんでした。もう一度送ってください"
MSG_NO_PENDING = "答える呼び出しがありません(もう答えたか、呼び出しが取り消されました)"
MSG_UPSTREAM_BUSY = "AI が混み合っています。しばらくしてからもう一度試してください"
MSG_UPSTREAM_AUTH = "サーバーの API キーが受け付けられませんでした。管理者に知らせてください"
MSG_UPSTREAM_CONNECT = "AI に接続できませんでした。しばらくしてからもう一度試してください"
MSG_UPSTREAM_OTHER = "AI との通信で問題が起きました。もう一度試してください"


class RelayError(Exception):
    """ブラウザに返す失敗(HTTP の状態と日本語の文)。reason はログ用の短い印。"""

    def __init__(self, status: int, detail: str, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.detail = detail
        self.reason = reason


# ---- クライアント ----


def _quiet_sdk_loggers() -> None:
    # ANTHROPIC_LOG=debug にすると、SDK は要求の中身(会話の本文)をログに書く。中継ではどんな設定でも書かせない
    for name in ("anthropic", "httpx", "httpx2", "httpcore", "httpcore2"):
        sdk_logger = logging.getLogger(name)
        if sdk_logger.getEffectiveLevel() < logging.WARNING:
            sdk_logger.setLevel(logging.WARNING)


def build_client(api_key: str, workspace_id: str | None, **kwargs: Any) -> anthropic.AsyncAnthropic:
    """API キーを明示して作る(SDK が環境変数を探しに行かない)。kwargs は http_client などの差し替え用。"""
    _quiet_sdk_loggers()
    headers = {"anthropic-workspace-id": workspace_id} if workspace_id else None
    return anthropic.AsyncAnthropic(api_key=api_key, default_headers=headers, **kwargs)


_clients: dict[tuple[str, str | None], anthropic.AsyncAnthropic] = {}


def get_client() -> Any:
    """環境変数の API キーとワークスペースから作った非同期のクライアント(同じ値のあいだは使い回す)。"""
    api_key = settings.anthropic_api_key()
    if api_key is None:
        raise RuntimeError("ANTHROPIC_API_KEY がありません")
    workspace_id = settings.anthropic_workspace_id()
    key = (api_key, workspace_id)
    client = _clients.get(key)
    if client is None:
        _clients.clear()
        client = _clients[key] = build_client(api_key, workspace_id)
    return client


def upstream_error(exc: BaseException) -> tuple[int, str]:
    """SDK の例外から、ブラウザに返す状態と日本語の文を決める(Anthropic の文は含めない)。具体的なものから順に。"""
    if isinstance(exc, (anthropic.RateLimitError, anthropic.OverloadedError, anthropic.ServiceUnavailableError)):
        return 503, MSG_UPSTREAM_BUSY
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return 502, MSG_UPSTREAM_AUTH
    if isinstance(exc, anthropic.BadRequestError):
        return 502, MSG_SEND_FAILED
    if isinstance(exc, anthropic.APIStatusError):
        return 502, MSG_UPSTREAM_OTHER
    if isinstance(exc, anthropic.APIConnectionError):
        return 502, MSG_UPSTREAM_CONNECT
    return 502, MSG_UPSTREAM_OTHER


def log_upstream_error(where: str, exc: BaseException) -> None:
    # 残すのは例外の型の名前と HTTP の状態だけ。str(exc) には API の返事の本文が入りうるので書かない
    logger.warning("agent エラー where=%s type=%s status=%s", where, type(exc).__name__, getattr(exc, "status_code", None))


# ---- イベントの形 ----


def as_dict(event: Any) -> dict[str, Any]:
    """SDK のイベント(pydantic のモデル)を、API の項目名の dict にする。dict はそのまま。"""
    if isinstance(event, dict):
        return event
    to_dict = getattr(event, "to_dict", None)
    if callable(to_dict):
        return to_dict(mode="json")
    return dict(vars(event))


def _stop_type(event: dict[str, Any]) -> str | None:
    stop = event.get("stop_reason")
    if isinstance(stop, dict):
        value = stop.get("type")
        return value if isinstance(value, str) else None
    return None


def _cents(usage: Any) -> int | None:
    """usage.list_cost.amount(セントの整数の文字列)を整数にする。"""
    usage = as_dict(usage) if usage is not None and not isinstance(usage, dict) else usage
    if not isinstance(usage, dict):
        return None
    cost = usage.get("list_cost")
    if not isinstance(cost, dict):
        return None
    try:
        return int(str(cost.get("amount")))
    except ValueError:
        return None


def sse(event: str, data: dict[str, Any], event_id: str | None = None) -> str:
    head = f"id: {event_id}\n" if event_id else ""
    return f"{head}event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


PING_FRAME = ": ping\n\n"


def _tool_result(call_id: str, text: str, is_error: bool) -> dict[str, Any]:
    return {
        "type": "user.custom_tool_result",
        "custom_tool_use_id": call_id,
        "content": [{"type": "text", "text": text}],
        "is_error": is_error,
    }


def _error_text(message: str) -> str:
    return json.dumps({"status": "error", "message": message}, ensure_ascii=False)


def _deny(ask_id: str) -> dict[str, Any]:
    return {"type": "user.tool_confirmation", "tool_use_id": ask_id, "result": "deny", "deny_message": DENY_MESSAGE}


INTERRUPT = {"type": "user.interrupt"}

# ---- 状態 ----

_END = object()


@dataclass
class Connection:
    """ブラウザのストリーム1本。queue には Anthropic のイベント、ほかの経路からの SSE の行、終わりの印が入る。"""

    queue: asyncio.Queue[Any] = field(default_factory=asyncio.Queue)
    upstream: Any = None


@dataclass
class SessionState:
    row_id: str
    session_id: str
    primary_thread_id: str | None = None
    calls: dict[str, dict[str, Any]] = field(default_factory=dict)  # agent.custom_tool_use(届いた順)
    answered: set[str] = field(default_factory=set)
    # save_research の結果(call_id ごと)。events.send が届かず答え直すとき、保存を2度実行しない
    # (2度目が「保存済み」の is_error になるのを防ぐ)。履歴から作り直しても call_id は同じなので reset で消さない。
    # 読むだけの get_research_targets・get_research_results は答え直すときに実行し直す(覚える量を抑える)
    saved_results: dict[str, tuple[str, bool]] = field(default_factory=dict)
    asks: dict[str, dict[str, Any]] = field(default_factory=dict)  # evaluated_permission が ask の agent.tool_use
    resolved_asks: set[str] = field(default_factory=set)
    open_runs: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_stop_reason: str | None = None
    terminated: bool = False
    interrupted: bool = False  # サーバーが user.interrupt を送った(次の end_turn の idle を interrupted と知らせる)
    browser_calls: int = 0  # 最後の user.message からの、主のスレッドのブラウザのツールの呼び出しの数
    over_limit: set[str] = field(default_factory=set)  # 13 回目以降(サーバーが is_error で答える)
    # この発言で止めた(too_many_tool_calls の知らせと user.interrupt を送った)。user.message で戻す。
    # 13 回目以降の呼び出しが並行で何件届いても、知らせと interrupt は1回の発言につき1回だけ
    stopped_long: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    conn: Connection | None = None
    last_retrieve: float = 0.0

    # -- 見分け --

    def from_primary(self, event: dict[str, Any]) -> bool:
        # 主のスレッドのイベントは session_thread_id が空(SDK の型の説明)。付いていれば主のスレッドの ID と比べる
        thread_id = event.get("session_thread_id")
        return not thread_id or thread_id == self.primary_thread_id

    def is_browser_call(self, call: dict[str, Any]) -> bool:
        return call.get("name") in browser_tool_names() and self.from_primary(call)

    def pending_browser(self) -> list[dict[str, Any]]:
        return [
            call
            for call_id, call in self.calls.items()
            if call_id not in self.answered and call_id not in self.over_limit and self.is_browser_call(call)
        ]

    def pending_server_side(self) -> list[dict[str, Any]]:
        """サーバーが答える呼び出し:サーバーのツール、調査の中からのブラウザのツール、知らない名前、13 回目以降。"""
        return [
            call
            for call_id, call in self.calls.items()
            if call_id not in self.answered and (call_id in self.over_limit or not self.is_browser_call(call))
        ]

    def pending_asks(self) -> list[dict[str, Any]]:
        return [ask for ask_id, ask in self.asks.items() if ask_id not in self.resolved_asks]

    def emit(self, frames: Iterable[str]) -> None:
        """ほかの経路(POST)で作った SSE の行を、つながっているストリームに流す。"""
        if self.conn is None:
            return
        for frame in frames:
            self.conn.queue.put_nowait(("frame", frame))

    # -- 履歴から作り直す --

    def reset(self) -> None:
        self.calls.clear()
        self.answered.clear()
        self.asks.clear()
        self.resolved_asks.clear()
        self.open_runs.clear()
        self.over_limit.clear()
        self.last_stop_reason = None
        self.terminated = False
        self.browser_calls = 0
        self.stopped_long = False

    def observe(self, event: dict[str, Any]) -> None:
        """1つのイベントで状態を進める(履歴とストリームで共通。答えることはしない)。"""
        kind = event.get("type")
        if kind == "agent.custom_tool_use":
            call_id = event.get("id")
            if not call_id or call_id in self.calls:
                return
            self.calls[call_id] = event
            if self.is_browser_call(event):
                self.browser_calls += 1
                if self.browser_calls > MAX_BROWSER_CALLS_PER_MESSAGE:
                    self.over_limit.add(call_id)
        elif kind == "user.custom_tool_result":
            call_id = event.get("custom_tool_use_id")
            if call_id:
                self.answered.add(call_id)
        elif kind in ("agent.tool_use", "agent.mcp_tool_use"):
            if event.get("evaluated_permission") == "ask" and event.get("id"):
                self.asks.setdefault(event["id"], event)
        elif kind == "user.tool_confirmation":
            ask_id = event.get("tool_use_id")
            if ask_id:
                self.resolved_asks.add(ask_id)
        elif kind == "user.message":
            self.browser_calls = 0
            self.over_limit.difference_update(self.answered)
            self.stopped_long = False
        elif kind == "workflow_run.created":
            run_id = event.get("workflow_run_id")
            if run_id:
                phases = {
                    phase.get("id"): phase.get("name")
                    for phase in event.get("phases") or []
                    if isinstance(phase, dict)
                }
                self.open_runs[run_id] = {"name": event.get("name"), "phases": phases}
        elif kind == "workflow_run.status_ended":
            self.open_runs.pop(event.get("workflow_run_id") or "", None)
        elif kind == "session.status_idle":
            self.last_stop_reason = _stop_type(event)
        elif kind == "session.status_running":
            self.last_stop_reason = None
        elif kind in ("session.status_terminated", "session.deleted"):
            self.terminated = True

    def rebuild(self, history: list[dict[str, Any]]) -> None:
        self.reset()
        last_interrupt = -1
        last_idle = -1
        last_message = -1
        for index, event in enumerate(history):
            self.observe(event)
            if event.get("type") == "user.interrupt":
                last_interrupt = index
            elif event.get("type") == "session.status_idle":
                last_idle = index
            elif event.get("type") == "user.message":
                last_message = index
        # 送った interrupt の後の idle がまだ来ていなければ、その idle を interrupted と知らせる
        self.interrupted = last_interrupt > last_idle
        # 最後の発言の後に interrupt を送っていれば、この発言ではもう止めている(知らせを出し直さない)
        self.stopped_long = last_interrupt > last_message


_states: dict[str, SessionState] = {}


def get_state(row_id: str, session_id: str) -> SessionState:
    state = _states.get(row_id)
    if state is None or state.session_id != session_id:
        state = _states[row_id] = SessionState(row_id=row_id, session_id=session_id)
    return state


def forget_state(row_id: str) -> None:
    _states.pop(row_id, None)


def reset_states() -> None:
    _states.clear()
    _deleting.clear()


# ---- Anthropic の呼び出し ----


async def _history(client: Any, session_id: str) -> list[dict[str, Any]]:
    # AsyncPaginator は async for でページを送って読む
    return [as_dict(event) async for event in client.beta.sessions.events.list(session_id)]


async def _refresh_primary(state: SessionState, client: Any) -> None:
    """主のスレッド(parent_thread_id が null)の ID を探す。失敗しても、空の session_thread_id で見分けられる。"""
    try:
        async for thread in client.beta.sessions.threads.list(state.session_id):
            data = as_dict(thread)
            if data.get("parent_thread_id") is None and data.get("id"):
                state.primary_thread_id = data["id"]
                return
    except anthropic.APIError as exc:
        log_upstream_error("threads.list", exc)


async def _sync(state: SessionState, client: Any) -> list[dict[str, Any]]:
    await _refresh_primary(state, client)
    history = await _history(client, state.session_id)
    state.rebuild(history)
    return history


async def _send(client: Any, state: SessionState, events: list[dict[str, Any]]) -> None:
    await client.beta.sessions.events.send(state.session_id, events=events)


def run_server_tool(state: SessionState, call: dict[str, Any]) -> tuple[str, bool]:
    """サーバーが実行するツール(§3.2)。スレッドを確かめてから、research.py の中身を実行する。"""
    name = call.get("name")
    if name in browser_tool_names():
        return _error_text(MSG_TOOL_IN_RESEARCH), True
    if name not in SERVER_TOOLS:
        return _error_text(MSG_UNKNOWN_TOOL), True
    from_primary = state.from_primary(call)
    if name in PRIMARY_SERVER_TOOLS and not from_primary:
        return _error_text(MSG_PRIMARY_ONLY), True
    if name in RESEARCHER_SERVER_TOOLS and from_primary:
        return _error_text(MSG_RESEARCHER_ONLY), True
    return research.run_tool(str(name), state.row_id, call.get("input"))


async def settle(
    state: SessionState,
    client: Any,
    *,
    stop_reason_text: str | None = None,
    interrupt: bool = False,
) -> list[str]:
    """答えていないサーバー側の呼び出しに答え、答えていない許可の確認に deny を返す(1回の events.send)。

    stop_reason_text を渡すと(終えるとき)、ブラウザのツールも含めたすべての呼び出しを、その文の is_error で閉じる。
    13 回目以降の呼び出しには is_error で答え続け、この発言でまだ止めていなければ(stopped_long が立っていなければ)、
    結果の後ろに user.interrupt を付け、ブラウザに too_many_tool_calls の知らせを1回だけ出す。interrupt=True でも付ける。
    呼ぶ側が state.lock を持っていること。ブラウザに流す SSE の行を返す。
    """
    events: list[dict[str, Any]] = []
    frames: list[str] = []
    marked: list[str] = []
    stop_long = False
    calls = list(state.calls.values()) if stop_reason_text else state.pending_server_side()
    for call in calls:
        call_id = call["id"]
        if call_id in state.answered:
            continue
        name = str(call.get("name"))
        if stop_reason_text is not None:
            text, is_error = _error_text(stop_reason_text), True
        elif call_id in state.over_limit:
            text, is_error = _error_text(MSG_TOO_MANY_CALLS), True
            stop_long = True
        else:
            if name in SERVER_TOOLS:
                frames.append(sse("tool_activity", {"name": name, "done": False}))
            cached = state.saved_results.get(call_id) if name == "save_research" else None
            if cached is None:
                text, is_error = run_server_tool(state, call)
                if name == "save_research":
                    state.saved_results[call_id] = (text, is_error)
            else:
                text, is_error = cached
            if name in SERVER_TOOLS:
                frames.append(sse("tool_activity", {"name": name, "done": True}))
            if name == "save_research" and not is_error:
                # 調査の進み具合(保存した数と対象の数。§4.6 の research の saved)
                frames.append(sse("research", {"kind": "saved", **research.progress(state.row_id)}))
            logger.info("agent サーバーのツール name=%s is_error=%s row=%s", name, is_error, state.row_id)
        events.append(_tool_result(call_id, text, is_error))
        state.answered.add(call_id)
        marked.append(call_id)
    asks = state.pending_asks()
    for ask in asks:
        events.append(_deny(ask["id"]))
        state.resolved_asks.add(ask["id"])
    if asks:
        logger.info("agent 許可の確認を断りました count=%d row=%s", len(asks), state.row_id)
    # 止めた知らせと interrupt は、この発言で最初の1回だけ(並行の呼び出しが何件届いても1回)
    notify_long = stop_long and not state.stopped_long
    was_interrupted = state.interrupted
    long_frame: str | None = None
    if notify_long or interrupt:
        events.append(dict(INTERRUPT))
        state.interrupted = True
    if notify_long:
        state.stopped_long = True
        long_frame = sse(
            "error",
            {"message": ERR_STOPPED_LONG, "code": "too_many_tool_calls", "limit": MAX_BROWSER_CALLS_PER_MESSAGE},
        )
        frames.append(long_frame)
        logger.info("agent ツールの呼び出しが多すぎるので止めました row=%s", state.row_id)
    if not events:
        return frames
    try:
        await _send(client, state, events)
    except anthropic.BadRequestError as exc:
        # run が終わった後の答えなどは 400 になることがある。型だけを残して先へ進む(§4.8)
        log_upstream_error("events.send(settle)", exc)
    except anthropic.APIError as exc:
        # 届かなかった。次につないだときか、次の発言のときに答え直す
        log_upstream_error("events.send(settle)", exc)
        state.answered.difference_update(marked)
        state.resolved_asks.difference_update(ask["id"] for ask in asks)
        if long_frame is not None:
            # 止められていないので、印を戻し、知らせも出さない(答え直すときに1回出す)
            state.stopped_long = False
            if not interrupt:
                state.interrupted = was_interrupted
            frames.remove(long_frame)
    return frames


async def record_usage(state: SessionState, client: Any) -> list[str]:
    """sessions.retrieve で usage.list_cost を読み、台帳に足す。usage の SSE の行を返す。"""
    state.last_retrieve = time.monotonic()
    try:
        session = as_dict(await client.beta.sessions.retrieve(state.session_id))
    except anthropic.APIError as exc:
        log_upstream_error("sessions.retrieve", exc)
        return []
    cents = _cents(session.get("usage"))
    if cents is None:
        return []
    get_store().record_cost(state.row_id, cents, time.time())
    return [sse("usage", {"cost_cents": cents, "budget_cents": settings.session_budget_cents()})]


async def _maybe_archive(state: SessionState, client: Any, thread_id: str) -> None:
    """名簿で頼んだ調査役の子のスレッドが終わったら archive する(§4.8。workflow run のスレッドと主のスレッドは除く)。"""
    if not thread_id or thread_id == state.primary_thread_id or state.primary_thread_id is None:
        return
    try:
        thread = as_dict(await client.beta.sessions.threads.retrieve(thread_id, session_id=state.session_id))
        if thread.get("parent_thread_id") != state.primary_thread_id or thread.get("workflow_run_id") is not None:
            return
        await client.beta.sessions.threads.archive(thread_id, session_id=state.session_id)
        logger.info("agent 調査役のスレッドを片づけました row=%s", state.row_id)
    except anthropic.APIError as exc:
        log_upstream_error("threads.archive", exc)


# ---- ブラウザ向けのイベント(§4.6) ----


def _message_text(event: dict[str, Any]) -> str:
    return "".join(
        block.get("text", "")
        for block in event.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    )


def _research_frame(state: SessionState, event: dict[str, Any]) -> str | None:
    kind = event.get("type")
    run_id = event.get("workflow_run_id")
    data: dict[str, Any]
    if kind == "workflow_run.created":
        data = {"kind": "run_started", "run_id": run_id, "name": event.get("name")}
    elif kind in ("workflow_run.phase_started", "workflow_run.phase_ended"):
        phase_id = event.get("workflow_run_phase_id")
        run = state.open_runs.get(run_id or "") or {}
        name = (run.get("phases") or {}).get(phase_id) or phase_id
        data = {"kind": "phase_started" if kind.endswith("started") else "phase_ended", "run_id": run_id, "name": name}
    elif kind == "workflow_run.status_idle":
        data = {"kind": "run_paused", "run_id": run_id}
    elif kind == "workflow_run.status_ended":
        result = event.get("result") if isinstance(event.get("result"), dict) else {}
        data = {"kind": "run_ended", "run_id": run_id, "result": result.get("type")}
    elif kind == "workflow_run.error":
        error = event.get("error") if isinstance(event.get("error"), dict) else {}
        data = {"kind": "run_error", "run_id": run_id, "result": error.get("type")}
    elif kind == "session.thread_created":
        if event.get("workflow_run_id") is not None or not event.get("session_thread_id"):
            return None
        if event.get("session_thread_id") == state.primary_thread_id:
            return None
        data = {"kind": "delegated", "name": event.get("agent_name")}
    else:
        return None
    return sse("research", data, event.get("id"))


def frames_for(state: SessionState, event: dict[str, Any], *, live: bool) -> list[str]:
    """1つのイベントを、ブラウザに送る SSE の行にする。表に無いものは送らない。"""
    kind = event.get("type")
    event_id = event.get("id")
    if kind == "event_start":
        preview = event.get("event") if isinstance(event.get("event"), dict) else {}
        if preview.get("type") == "agent.message":
            return [sse("delta", {"message_id": preview.get("id"), "text": ""})]
        if preview.get("type") == "agent.thinking":
            return [sse("thinking", {})]
        return []
    if kind == "event_delta":
        delta = event.get("delta") if isinstance(event.get("delta"), dict) else {}
        content = delta.get("content") if isinstance(delta.get("content"), dict) else {}
        if delta.get("type") == "content_delta" and content.get("type") == "text" and content.get("text"):
            return [sse("delta", {"message_id": event.get("event_id"), "text": content["text"]})]
        return []
    if kind == "agent.message":
        if not state.from_primary(event):
            return []
        return [sse("message", {"message_id": event_id, "text": _message_text(event)}, event_id)]
    if kind == "agent.thinking":
        return [sse("thinking", {}, event_id)] if state.from_primary(event) else []
    if kind == "agent.custom_tool_use":
        if event_id and any(call["id"] == event_id for call in state.pending_browser()):
            return [sse("tool_call", {"id": event_id, "name": event.get("name"), "input": event.get("input")}, event_id)]
        return []
    if kind is not None and (kind.startswith("workflow_run.") or kind == "session.thread_created"):
        frame = _research_frame(state, event)
        return [frame] if frame else []
    if kind == "session.status_running":
        return [sse("status", {"state": "running"}, event_id)]
    if kind == "session.status_rescheduled":
        return [sse("status", {"state": "reconnecting"}, event_id)]
    if kind == "session.status_idle":
        reason = _stop_type(event)
        frames = [sse("status", {"state": "idle", "reason": reason}, event_id)]
        if reason == "retries_exhausted":
            frames.append(sse("error", {"message": ERR_RETRIES, "code": "retries_exhausted"}))
        return frames
    if kind in ("session.status_terminated", "session.deleted"):
        return [sse("status", {"state": "ended"}, event_id)]
    if kind == "session.usage":
        cents = _cents(event.get("usage"))
        if cents is None:
            return []
        return [sse("usage", {"cost_cents": cents, "budget_cents": settings.session_budget_cents()}, event_id)]
    if kind == "session.error":
        return [sse("error", {"message": ERR_SESSION, "code": "session_error"}, event_id)]
    return []


async def handle_live(state: SessionState, client: Any, event: dict[str, Any]) -> list[str]:
    """ストリームで届いた1つのイベントで状態を進め、要るものに答え、ブラウザに送る SSE の行を返す。"""
    kind = event.get("type")
    frames: list[str] = []
    if kind in ("agent.custom_tool_use", "agent.tool_use", "agent.mcp_tool_use"):
        async with state.lock:
            state.observe(event)
            if kind == "agent.custom_tool_use" and state.is_browser_call(event):
                logger.info("agent ブラウザのツール name=%s row=%s", event.get("name"), state.row_id)
            # サーバーのツール・調査の中からの呼び出し・ask には、idle を待たずにここで答える(§4.8)
            frames.extend(await settle(state, client))
            frames = frames_for(state, event, live=True) + frames if kind == "agent.custom_tool_use" else frames
        if kind == "agent.custom_tool_use" and event.get("name") in browser_tool_names() and not state.from_primary(event):
            logger.info("agent 調査の中からのブラウザのツールを断りました row=%s", state.row_id)
        return frames
    if kind == "session.status_idle":
        state.observe(event)
        reason = _stop_type(event)
        frames = frames_for(state, event, live=True)
        if reason == "end_turn" and state.interrupted:
            frames[0] = sse("status", {"state": "idle", "reason": "interrupted"}, event.get("id"))
        if reason != "requires_action":
            state.interrupted = False
        if reason == "requires_action":
            # 答えていないサーバー側の呼び出しが残っていれば答える(届かなかったものの答え直し)
            async with state.lock:
                frames.extend(await settle(state, client))
        frames.extend(await record_usage(state, client))
        logger.info("agent idle reason=%s row=%s", reason, state.row_id)
        return frames
    if kind in ("session.status_terminated", "session.deleted"):
        state.observe(event)
        get_store().mark_ended(state.row_id, time.time())
        logger.info("agent セッションが終わりました row=%s", state.row_id)
        return frames_for(state, event, live=True)
    if kind == "session.thread_status_idle":
        if _stop_type(event) == "end_turn":
            await _maybe_archive(state, client, str(event.get("session_thread_id") or ""))
        return []
    if kind == "session.usage":
        frames = frames_for(state, event, live=True)
        cents = _cents(event.get("usage"))
        if cents is not None:
            get_store().record_cost(state.row_id, cents, time.time())
        return frames
    if kind == "session.error":
        error = event.get("error") if isinstance(event.get("error"), dict) else {}
        logger.warning("agent session.error type=%s row=%s", error.get("type"), state.row_id)
        return frames_for(state, event, live=True)
    if kind == "workflow_run.status_ended":
        frames = frames_for(state, event, live=True)  # 段階の名前を引くため、状態を進める前に作る
        result = event.get("result") if isinstance(event.get("result"), dict) else {}
        error = result.get("error") if isinstance(result.get("error"), dict) else {}
        logger.info("agent run が終わりました result=%s error=%s row=%s", result.get("type"), error.get("type"), state.row_id)
        state.observe(event)
        return frames
    if kind == "workflow_run.error":
        error = event.get("error") if isinstance(event.get("error"), dict) else {}
        logger.warning("agent run のエラー type=%s row=%s", error.get("type"), state.row_id)
    state.observe(event)
    return frames_for(state, event, live=True)


# ---- ブラウザのストリーム(§4.5) ----


async def _pump(upstream: Any, queue: asyncio.Queue[Any]) -> None:
    try:
        async for event in upstream:
            queue.put_nowait(("event", event))
        queue.put_nowait(("end", None))
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - 切れた理由はログに型だけを残し、ブラウザには決まった文を送る
        queue.put_nowait(("end", exc))


async def _close(upstream: Any) -> None:
    close = getattr(upstream, "close", None)
    if close is None:
        return
    try:
        result = close()
        if asyncio.iscoroutine(result):
            await result
    except Exception as exc:  # noqa: BLE001
        log_upstream_error("stream.close", exc)


def _replay(history: list[dict[str, Any]], last_event_id: str | None) -> list[dict[str, Any]]:
    """履歴のうち Last-Event-ID より後のもの。無いか、見つからなければ空。"""
    if not last_event_id:
        return []
    for index, event in enumerate(history):
        if event.get("id") == last_event_id:
            return history[index + 1 :]
    return []


@dataclass
class PreparedStream:
    """prepare_stream で開いた Anthropic のストリームと、読んだ履歴(stream_frames に渡す)。"""

    conn: Connection
    reader: asyncio.Task[None]
    history: list[dict[str, Any]]
    frames: list[str]
    last_event_id: str | None


def _stream_open_error(exc: BaseException) -> RelayError:
    """ストリームを開けなかったときに、ブラウザに返す失敗(Anthropic の文は含めない)。"""
    if isinstance(exc, anthropic.APIError):
        status, detail = upstream_error(exc)
        if status == 503 or detail == MSG_UPSTREAM_AUTH:
            return RelayError(status, detail, "upstream")
    return RelayError(502, MSG_UPSTREAM_CONNECT, "upstream")


async def _release(state: SessionState, conn: Connection, reader: asyncio.Task[None] | None) -> None:
    """ストリーム1本の後片づけ(何回呼んでもよい)。待たずにできることを先に済ませる。"""
    if reader is not None:
        reader.cancel()
    if state.conn is conn:
        state.conn = None
    upstream, conn.upstream = conn.upstream, None
    if upstream is not None:
        await _close(upstream)


async def close_prepared(state: SessionState, prepared: PreparedStream) -> None:
    """prepare_stream で開いたものを片づける(stream_frames を一度も読まずに終わったときのため。何回呼んでもよい)。"""
    await _release(state, prepared.conn, prepared.reader)


async def prepare_stream(state: SessionState, client: Any, last_event_id: str | None) -> PreparedStream:
    """つなぐたびの前半(§4.5 の 1〜4):Anthropic のストリームを先に開き、履歴を読んで状態を作り直し、サーバー側の呼び出しに答える。

    ブラウザに返事(ヘッダー)を返す前に呼ぶ。ブラウザは返事のヘッダーで「つながった」とみなして発言を送るので、
    ここまで済ませてから返さないと、その間にできたイベントが履歴に入って seen に足され、ライブでも送られず落ちる(§6.5)。
    開けなければ RelayError(ブラウザはつなぎ直す)。
    """
    conn = Connection()
    previous = state.conn
    state.conn = conn
    if previous is not None:
        # 同じ取っ手の前のストリームを閉じる(サーバーのツールに二重に答えないため)
        previous.queue.put_nowait(("superseded", None))
    reader: asyncio.Task[None] | None = None
    try:
        try:
            conn.upstream = await client.beta.sessions.events.stream(state.session_id, event_deltas=list(EVENT_DELTAS))
        except Exception as exc:  # noqa: BLE001
            log_upstream_error("events.stream", exc)
            raise _stream_open_error(exc) from None
        reader = asyncio.create_task(_pump(conn.upstream, conn.queue))
        try:
            async with state.lock:
                history = await _sync(state, client)
                frames = await settle(state, client)
        except Exception as exc:  # noqa: BLE001
            log_upstream_error("events.list", exc)
            raise _stream_open_error(exc) from None
    except BaseException:
        # 開けなかったか、ブラウザがいなくなった(取り消された)
        await _release(state, conn, reader)
        raise
    return PreparedStream(conn=conn, reader=reader, history=history, frames=frames, last_event_id=last_event_id)


async def stream_frames(state: SessionState, client: Any, prepared: PreparedStream) -> AsyncIterator[str]:
    """つなぐたびの後半(§4.5 の 4〜6):送り直しと、ストリームのイベントの変換。終わると片づける。"""
    conn = prepared.conn
    history = prepared.history
    try:
        seen = {event["id"] for event in history if event.get("id")}
        replay = _replay(history, prepared.last_event_id)
        replay_ids = {event.get("id") for event in replay}
        logger.info(
            "agent ストリームをつなぎました history=%d replay=%d pending=%d row=%s",
            len(history),
            len(replay),
            len(state.pending_browser()),
            state.row_id,
        )
        # Last-Event-ID より前の、答えていないブラウザのツールの呼び出しを送り直す
        for call in state.pending_browser():
            if call["id"] not in replay_ids:
                yield sse("tool_call", {"id": call["id"], "name": call.get("name"), "input": call.get("input")}, call["id"])
        for event in replay:
            for frame in frames_for(state, event, live=False):
                yield frame
        for frame in prepared.frames:
            yield frame

        while True:
            timeout = PING_SECONDS
            if state.open_runs:
                # run の間は idle が来ないので、1 分ごとに利用額を読む(§4.10)。イベントが続けて届いても読む
                due = RUN_RETRIEVE_SECONDS - (time.monotonic() - state.last_retrieve)
                if due <= 0:
                    for frame in await record_usage(state, client):
                        yield frame
                    due = RUN_RETRIEVE_SECONDS
                timeout = max(min(PING_SECONDS, due), 0.001)
            try:
                item_kind, item = await asyncio.wait_for(conn.queue.get(), timeout=timeout)
            except TimeoutError:
                yield PING_FRAME
                continue
            if item_kind == "superseded":
                return
            if item_kind == "frame":
                yield item
                continue
            if item_kind == "ended":
                yield sse("status", {"state": "ended"})
                return
            if item_kind == "end":
                if item is not None:
                    log_upstream_error("events.stream", item)
                else:
                    logger.info("agent Anthropic のストリームが閉じました row=%s", state.row_id)
                yield sse("error", {"message": ERR_UPSTREAM, "code": "upstream"})
                return
            event = as_dict(item)
            event_id = event.get("id")
            if event_id:
                if event_id in seen:
                    continue
                seen.add(event_id)
            for frame in await handle_live(state, client, event):
                yield frame
            if state.terminated:
                return
    finally:
        await close_prepared(state, prepared)


async def open_stream(state: SessionState, client: Any, last_event_id: str | None) -> AsyncIterator[str]:
    """prepare_stream と stream_frames を続けて行う SSE(開けなければ error の行を1つ送って終わる)。

    HTTP のエンドポイントは、返事のヘッダーの前に prepare_stream を済ませるため、この関数を使わない(agent_relay.session_stream)。
    """
    try:
        prepared = await prepare_stream(state, client, last_event_id)
    except RelayError:
        yield sse("error", {"message": ERR_UPSTREAM, "code": "upstream"})
        return
    async with contextlib.aclosing(stream_frames(state, client, prepared)) as frames:
        async for frame in frames:
            yield frame


# ---- ブラウザからの送信(§4.7) ----


async def _ensure_fresh(state: SessionState, client: Any) -> None:
    """ストリームがつながっていなければ(再起動の後など)、履歴から状態を作り直す。呼ぶ側が lock を持つ。"""
    if state.conn is None:
        await _sync(state, client)


async def send_message(state: SessionState, client: Any, content: list[dict[str, Any]]) -> None:
    async with state.lock:
        try:
            await _ensure_fresh(state, client)
        except anthropic.APIError as exc:
            log_upstream_error("events.list", exc)
            status, detail = upstream_error(exc)
            raise RelayError(status, detail, "upstream") from None
        if state.last_stop_reason == "budget_reached":
            raise RelayError(409, MSG_BUDGET, "budget_reached")
        state.emit(await settle(state, client))
        if state.pending_browser():
            raise RelayError(409, MSG_WAITING_TOOLS, "pending_tools")
        try:
            await _send(client, state, [{"type": "user.message", "content": content}])
        except anthropic.BadRequestError as exc:
            log_upstream_error("events.send(message)", exc)
            try:
                await _sync(state, client)
            except anthropic.APIError as sync_exc:
                log_upstream_error("events.list", sync_exc)
                raise RelayError(502, MSG_SEND_FAILED, "send_rejected") from None
            if state.pending_browser() or state.last_stop_reason == "requires_action":
                raise RelayError(409, MSG_WAITING_TOOLS, "requires_action") from None
            if state.last_stop_reason == "budget_reached":
                raise RelayError(409, MSG_BUDGET, "budget_reached") from None
            raise RelayError(502, MSG_SEND_FAILED, "send_rejected") from None
        except anthropic.APIError as exc:
            log_upstream_error("events.send(message)", exc)
            status, detail = upstream_error(exc)
            raise RelayError(status, detail, "upstream") from None
        state.browser_calls = 0
        state.over_limit.difference_update(state.answered)
        state.interrupted = False
        state.stopped_long = False
    state.emit(await record_usage(state, client))


async def send_results(
    state: SessionState, client: Any, results: list[dict[str, Any]], *, interrupt: bool
) -> None:
    """ブラウザのツールの結果(と、止めるときは後ろに user.interrupt)を1回の events.send で送る。"""
    async with state.lock:
        try:
            await _ensure_fresh(state, client)
        except anthropic.APIError as exc:
            log_upstream_error("events.list", exc)
            status, detail = upstream_error(exc)
            raise RelayError(status, detail, "upstream") from None
        pending = {call["id"] for call in state.pending_browser()}
        for result in results:
            if result["custom_tool_use_id"] not in pending:
                raise RelayError(409, MSG_NO_PENDING, "unknown_tool_use")
        events = [_tool_result(r["custom_tool_use_id"], r["text"], r["is_error"]) for r in results]
        if interrupt:
            events.append(dict(INTERRUPT))
        if not events:
            return
        try:
            await _send(client, state, events)
        except anthropic.BadRequestError as exc:
            # 呼び出しが既に閉じていた(run が終わった、取り消された)。届いたものとして扱わせる
            log_upstream_error("events.send(results)", exc)
            state.answered.update(r["custom_tool_use_id"] for r in results)
            raise RelayError(409, MSG_NO_PENDING, "send_rejected") from None
        except anthropic.APIError as exc:
            log_upstream_error("events.send(results)", exc)
            status, detail = upstream_error(exc)
            raise RelayError(status, detail, "upstream") from None
        state.answered.update(r["custom_tool_use_id"] for r in results)
        if interrupt:
            state.interrupted = True


# ---- 終える(§4.9) ----

_deleting: set[str] = set()


def is_deleting(row_id: str) -> bool:
    return row_id in _deleting


async def _wait_runs_end(state: SessionState, client: Any, queue: asyncio.Queue[Any], deadline: float) -> None:
    """開いている run すべての workflow_run.status_ended を待つ。途中で届いた呼び出しにも答える。"""
    while state.open_runs:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            logger.info("agent run の終わりを待ちきれませんでした open=%d row=%s", len(state.open_runs), state.row_id)
            return
        try:
            item_kind, item = await asyncio.wait_for(queue.get(), timeout=remaining)
        except TimeoutError:
            continue
        if item_kind != "event":
            return
        event = as_dict(item)
        state.observe(event)
        if event.get("type") in ("agent.custom_tool_use", "agent.tool_use", "agent.mcp_tool_use"):
            await settle(state, client, stop_reason_text=MSG_RELOADED)


async def _wait_not_running(state: SessionState, client: Any) -> dict[str, Any]:
    session: dict[str, Any] = {}
    for attempt in range(DELETE_POLL_TRIES):
        session = as_dict(await client.beta.sessions.retrieve(state.session_id))
        if session.get("status") != "running":
            return session
        if attempt + 1 < DELETE_POLL_TRIES:
            await asyncio.sleep(DELETE_POLL_INTERVAL)
    return session


async def end_session(row_id: str, client: Any) -> bool:
    """セッションを終えて消す。消せたら True。断られたら delete_pending を付けて False(掃除でやり直す)。"""
    store = get_store()
    row = store.get_session(row_id)
    if row is None or row["deleted_at"] is not None or not row["session_id"]:
        return True
    if row_id in _deleting:
        return False
    _deleting.add(row_id)
    state = get_state(row_id, row["session_id"])
    if state.conn is not None:
        state.conn.queue.put_nowait(("ended", None))
    queue: asyncio.Queue[Any] = asyncio.Queue()
    upstream: Any = None
    reader: asyncio.Task[None] | None = None
    try:
        upstream = await client.beta.sessions.events.stream(state.session_id)
        reader = asyncio.create_task(_pump(upstream, queue))
        async with state.lock:
            await _sync(state, client)
            if not state.terminated:
                if not state.open_runs:
                    # 1. 答えていない呼び出しすべてを閉じ、同じ events.send の後ろに user.interrupt
                    await settle(state, client, stop_reason_text=MSG_RELOADED, interrupt=True)
                else:
                    # 2. 結果 → run を止めるよう頼む → run の終わりを待つ → user.interrupt
                    await settle(state, client, stop_reason_text=MSG_RELOADED)
                    if state.last_stop_reason != "budget_reached":
                        try:
                            await _send(
                                client,
                                state,
                                [{"type": "user.message", "content": [{"type": "text", "text": STOP_RUNS_MESSAGE}]}],
                            )
                        except anthropic.BadRequestError as exc:
                            log_upstream_error("events.send(stop_runs)", exc)
                    await _wait_runs_end(state, client, queue, time.monotonic() + STOP_RUNS_WAIT_SECONDS)
                    await _send(client, state, [dict(INTERRUPT)])
        # 3. running でなくなるのを待ってから消す
        session = await _wait_not_running(state, client)
        cents = _cents(session.get("usage"))
        if cents is not None:
            store.record_cost(row_id, cents, time.time())
        if session.get("status") == "running":
            raise RuntimeError("still_running")
        await client.beta.sessions.delete(state.session_id)
    except anthropic.NotFoundError:
        # 既に消えていた
        store.mark_deleted(row_id, time.time())
        forget_state(row_id)
        logger.info("agent セッションは既にありませんでした row=%s", row_id)
        return True
    except Exception as exc:  # noqa: BLE001
        # 4. 断られた(running・workflow_run_open など)。掃除で 1 からやり直す
        log_upstream_error("sessions.delete", exc)
        attempts = store.mark_delete_failed(row_id)
        if attempts >= 3:
            logger.warning("agent セッションを消せません attempts=%d type=%s row=%s", attempts, type(exc).__name__, row_id)
        return False
    finally:
        if reader is not None:
            reader.cancel()
        if upstream is not None:
            await _close(upstream)
        _deleting.discard(row_id)
    usage = session.get("usage") if isinstance(session.get("usage"), dict) else {}
    server_tool_use = usage.get("server_tool_use") if isinstance(usage.get("server_tool_use"), dict) else {}
    store.mark_deleted(row_id, time.time())
    forget_state(row_id)
    logger.info(
        "agent セッションを消しました cost_cents=%s active_seconds=%s web_search_requests=%s row=%s",
        cents,
        usage.get("active_seconds"),
        server_tool_use.get("web_search_requests"),
        row_id,
    )
    return True


# ---- 掃除(§4.10) ----


async def sweep_once(client_factory: Callable[[], Any] | None = None, now: float | None = None) -> None:
    """24 時間たった行・終えた行・delete_pending の行を消し、終えていない行の利用額を読み、古い行を消す。"""
    store = get_store()
    now = time.time() if now is None else now
    factory = client_factory or get_client
    client: Any = None
    if settings.anthropic_api_key() is not None:
        try:
            client = factory()
        except Exception as exc:  # noqa: BLE001
            log_upstream_error("client", exc)
    if client is not None:
        handled: set[str] = set()
        for row in store.rows_to_sweep(now, settings.session_ttl_hours()):
            row_id = row["row_id"]
            if row_id in _deleting:
                continue
            handled.add(row_id)
            store.mark_ended(row_id, now)
            await end_session(row_id, client)
        for row in store.live_rows():
            if row["row_id"] in handled or not row["session_id"]:
                continue
            state = get_state(row["row_id"], row["session_id"])
            await record_usage(state, client)
    removed, expired = store.purge(now)
    if removed or expired:
        logger.info("agent 掃除 removed_rows=%d expired_results=%d", removed, expired)


async def sweep_loop() -> None:
    while True:
        try:
            await sweep_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log_upstream_error("sweep", exc)
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
