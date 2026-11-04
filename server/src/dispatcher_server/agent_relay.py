"""Managed Agents のセッションの中継のエンドポイント。docs/interfaces-1105.md §4.2。

- 合言葉はヘッダー X-Dispatcher-Token、セッションの取っ手はヘッダー X-Dispatcher-Session(URL に入れない)
- 失敗は JSON の {"detail": "…"}(日本語)
- エージェントと実行環境は作らない・変えない(ant apply の仕事)
- 発言・ツールの入力と結果・取っ手・Anthropic のセッションの ID・IP アドレス・API キーはログに残さない
"""

import asyncio
import base64
import functools
import hashlib
import hmac
import json
import logging
import secrets
import time
import weakref
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, NoReturn

import anthropic
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import agent_session, research, settings
from .agent_session import RelayError
from .ratelimit import RateLimiter, client_address, jst_day
from .store import get_store

logger = logging.getLogger("dispatcher_server.agent")


def _configure_logging() -> None:
    # uvicorn はルートのロガーを設定しないので、そのままでは INFO が出ず、日時も付かない。
    # 日時・回数・エラーの種類を残すため、パッケージのロガーに日時つきの出力を付ける(二重には付けない)
    package_logger = logging.getLogger("dispatcher_server")
    if package_logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    package_logger.addHandler(handler)
    package_logger.setLevel(logging.INFO)


_configure_logging()

router = APIRouter(prefix="/api/claude")

TOKEN_HEADER = "x-dispatcher-token"
HANDLE_HEADER = "x-dispatcher-session"
HANDLE_PREFIX = "v1"
HANDLE_CONTEXT = b"dispatcher-session:v1:"
ROW_ID_BYTES = 16
SIGNATURE_BYTES = 16

MAX_CREATE_BODY_BYTES = 1024
MAX_EVENTS_BODY_BYTES = 400 * 1024
MAX_RESEARCH_BODY_BYTES = 32 * 1024
MAX_TEXT_BYTES = 32 * 1024
MAX_RESULTS = 10
SCREEN_LINE_PREFIXES = ("[画面の状態] ", "[画面の操作] ")

SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",  # nginx に溜めさせない
}

MSG_NO_KEY = "AI は使えません(API キーが設定されていません)"
MSG_NO_AGENT = "AI は使えません(エージェントか実行環境の設定がありません)"
MSG_NO_SECRET = "AI は使えません(セッションの秘密が設定されていません)"
MSG_NO_TOKEN = "AI は使えません(認証コードが設定されていません)。"
MSG_BAD_TOKEN = "認証コードが違います。"
MSG_NO_SESSION = "AI との会話が見つかりません。新しく始めます"
MSG_ENDED = "AI との会話は終わっています。新しく始めてください"
MSG_BAD_BODY = "AI への要求の形が正しくありません"
MSG_TOO_LARGE = "送る内容が大きすぎます"
MSG_NO_ADDRESS = "接続元を確かめられません"
MSG_LIMIT_SESSION_HOUR = "AI との会話を始める回数の上限に達しました(1 時間あたり)。しばらくしてから使ってください"
MSG_LIMIT_SESSION_DAY = "AI との会話を始める回数の上限に達しました(1 日あたり)。日本時間の翌日になってから使ってください"
MSG_LIMIT_SESSIONS_TOTAL = "今日の AI との会話を始める回数の上限に達しました。日本時間の翌日になってから使ってください"
MSG_LIMIT_COST = "今日の AI の利用額の上限に達しました。日本時間の翌日になってから使ってください"
MSG_LIMIT_MESSAGE_HOUR = "AI への発言の回数の上限に達しました(1 時間あたり)。しばらくしてから使ってください"

limiter = RateLimiter()

# セッションの作成は、回数と予約の確かめ → sessions.create → 記録 を、この鍵の中で1つずつ行う。
# sessions.create を待つ間に別の作成が関門を通ると、どちらも記録の前の数を見て、回数と1日の利用額の予約をすり抜けるため。
# uvicorn のワーカーは1つ(§9)なので、プロセスの中の鍵で足りる。asyncio.Lock はイベントループに結びつくので、ループごとに作る
# (本番のループは1つ。テストはリクエストごとにループが変わりうる)
_create_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = weakref.WeakKeyDictionary()


def _create_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _create_locks.get(loop)
    if lock is None:
        lock = _create_locks[loop] = asyncio.Lock()
    return lock


# ---- 状態 ----


def _unavailable_message() -> str | None:
    if settings.anthropic_api_key() is None:
        return MSG_NO_KEY
    if settings.agent_id() is None or settings.agent_version() is None or settings.environment_id() is None:
        return MSG_NO_AGENT
    if settings.session_secret() is None:
        return MSG_NO_SECRET
    # 本番で合言葉を設定し忘れて、誰でも呼べる状態になるのを防ぐ。合言葉なしで使うときは明示する
    # (本番の公開は DISPATCHER_PUBLIC=1、開発は DISPATCHER_DEV=1)。DISPATCHER_PUBLIC では取っ手の秘密は省けない(上で確かめた)
    if settings.dispatcher_token() is None and not (settings.public_mode() or settings.dev_mode()):
        return MSG_NO_TOKEN
    return None


@router.get("/status")
def claude_status() -> dict[str, bool]:
    # 合言葉を入れる前の画面が読むので、合言葉は求めない(返すのは真偽値だけ)
    return {
        "available": _unavailable_message() is None,
        "tokenRequired": settings.dispatcher_token() is not None,
    }


# ---- 確かめ ----


def _reject(status_code: int, detail: str, reason: str) -> NoReturn:
    logger.info("agent 要求を断りました status=%d reason=%s", status_code, reason)
    raise HTTPException(status_code=status_code, detail=detail)


def _check_available_and_token(request: Request) -> None:
    unavailable = _unavailable_message()
    if unavailable is not None:
        _reject(503, unavailable, "unavailable")
    expected = settings.dispatcher_token()
    if expected is None:
        return  # 合言葉なしの公開(DISPATCHER_PUBLIC=1)か開発(DISPATCHER_DEV=1)。_unavailable_message で確かめ済み
    # ヘッダーの値は Starlette が latin-1 で読む。元のバイト列に戻して、定数時間で照合する
    given = request.headers.get(TOKEN_HEADER, "").encode("latin-1", errors="replace")
    if not hmac.compare_digest(given, expected.encode("utf-8")):
        _reject(401, MSG_BAD_TOKEN, "token")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _signature(row_id: str) -> str:
    secret = settings.session_secret()
    assert secret is not None  # _check_available_and_token で確かめ済み
    digest = hmac.new(secret, HANDLE_CONTEXT + row_id.encode("ascii"), hashlib.sha256).digest()
    return _b64(digest[:SIGNATURE_BYTES])


def make_handle(row_id: str) -> str:
    return f"{HANDLE_PREFIX}.{row_id}.{_signature(row_id)}"


def parse_handle(value: str) -> str | None:
    """取っ手の署名が合えば行の ID を返す。"""
    parts = value.split(".")
    if len(parts) != 3 or parts[0] != HANDLE_PREFIX:
        return None
    row_id, signature = parts[1], parts[2]
    if not row_id or not row_id.isascii() or not signature.isascii():
        return None
    if not hmac.compare_digest(signature.encode("ascii"), _signature(row_id).encode("ascii")):
        return None
    return row_id


def _session_row(request: Request) -> dict[str, Any]:
    raw = request.headers.get(HANDLE_HEADER, "")
    row_id = parse_handle(raw) if raw else None
    row = get_store().get_session(row_id) if row_id else None
    if row is None:
        _reject(404, MSG_NO_SESSION, "handle")
    if row["ended_at"] is not None or not row["session_id"]:
        _reject(410, MSG_ENDED, "ended")
    return row


def _client_address(request: Request) -> str:
    """回数制限の単位にする接続元(ratelimit.client_address)。X-Real-IP を信じる設定で読めなければ 400。"""
    address = client_address(request)
    if address is None:
        _reject(400, MSG_NO_ADDRESS, "real_ip")
    return address


async def _read_json(request: Request, limit: int) -> Any:
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        _reject(413, MSG_TOO_LARGE, "body_size")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            _reject(413, MSG_TOO_LARGE, "body_size")
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks) or b"null")
    except (ValueError, RecursionError):
        _bad_body("JSON として読めません")


def _bad_body(detail: str) -> NoReturn:
    _reject(400, f"{MSG_BAD_BODY}({detail})", "body")


def _raise_relay(error: RelayError) -> NoReturn:
    _reject(error.status, error.detail, error.reason)


def _client() -> Any:
    try:
        return agent_session.get_client()
    except RuntimeError:
        _reject(503, MSG_NO_KEY, "unavailable")


# ---- セッションの作成(§4.3) ----


def _check_create_limits(address: str) -> None:
    store = get_store()
    limited = limiter.check(
        "session", address, per_hour=settings.sessions_per_ip_hour(), per_day=settings.sessions_per_ip_day()
    )
    if limited == "day":
        _reject(429, MSG_LIMIT_SESSION_DAY, "rate_session_ip_day")
    if limited == "hour":
        _reject(429, MSG_LIMIT_SESSION_HOUR, "rate_session_ip_hour")
    now = time.time()
    today = jst_day(now)
    if store.sessions_created_on(today) >= settings.sessions_per_day():
        _reject(429, MSG_LIMIT_SESSIONS_TOTAL, "rate_sessions_day")
    # 予約の形:今日の台帳 + 消していないセッションの残りの予算 + 新しいセッションの予算(§4.11)。
    # 最後の操作から 30 分ストリームがつながっていない行は、残りの予算を数えない(使った額は台帳に入っている)
    budget = settings.session_budget_cents()
    reserved = store.ledger_cents(today) + store.reserved_cents(budget, now=now) + budget
    if reserved > settings.daily_cost_cents():
        _reject(429, MSG_LIMIT_COST, "rate_cost_day")


@router.post("/session")
async def create_session(request: Request) -> dict[str, Any]:
    _check_available_and_token(request)
    body = await _read_json(request, MAX_CREATE_BODY_BYTES)
    if body != {}:
        _bad_body("本文は {} にしてください")
    address = _client_address(request)
    client = _client()
    agent_id = settings.agent_id()
    agent_version = settings.agent_version()
    environment_id = settings.environment_id()
    assert agent_id is not None and agent_version is not None and environment_id is not None
    async with _create_lock():
        # 確かめと記録の間に await(sessions.create)があるので、鍵の中で確かめる
        _check_create_limits(address)
        budget = settings.session_budget_cents()
        row_id = _b64(secrets.token_bytes(ROW_ID_BYTES))
        try:
            session = await client.beta.sessions.create(
                agent={"type": "agent", "id": agent_id, "version": agent_version},
                environment_id=environment_id,
                title="Dispatcher",
                metadata={"app": "dispatcher", "row": row_id},
                budget={"type": "limit", "max_list_cost": {"amount": str(budget), "currency": "USD"}},
            )
        except anthropic.APIError as exc:
            agent_session.log_upstream_error("sessions.create", exc)
            status, detail = agent_session.upstream_error(exc)
            _reject(status, detail, "upstream")
        session_id = agent_session.as_dict(session).get("id")
        if not isinstance(session_id, str) or not session_id:
            _reject(502, agent_session.MSG_UPSTREAM_OTHER, "upstream_shape")
        limiter.record("session", address)
        get_store().insert_session(row_id, session_id, agent_version, time.time())
    logger.info("agent セッションを作りました version=%d row=%s", agent_version, row_id)
    return {"handle": make_handle(row_id), "budget_cents": budget}


# ---- ストリーム(§4.5) ----

# ストリームがつながっている間、最後につながっていた日時(last_stream_at)を記録し直す間隔。
# 15 秒ごとの ping が流れるので、つながっている間はこの間隔で必ず記録する(1日の利用額の予約。store.RESERVATION_IDLE)
STREAM_MARK_SECONDS = 60.0


def _mark_stream(row_id: str) -> None:
    get_store().mark_stream(row_id, time.time())


async def _marked_frames(row_id: str, frames: AsyncIterator[str]) -> AsyncIterator[str]:
    """frames をそのまま流し、つながっている間は STREAM_MARK_SECONDS ごとに last_stream_at を記録する。"""
    marked = time.monotonic()
    try:
        async for frame in frames:
            now = time.monotonic()
            if now - marked >= STREAM_MARK_SECONDS:
                _mark_stream(row_id)
                marked = now
            yield frame
    finally:
        # 外側が閉じられたら、中の流れ(非同期ジェネレーター)も閉じる(片づけを GC に任せない)
        aclose = getattr(frames, "aclose", None)
        if aclose is not None:
            await aclose()


async def _close_stream(row_id: str, close: Callable[[], Awaitable[None]]) -> None:
    # 切れた時刻を、最後につながっていた日時にする(ジェネレーターの finally は走らないことがあるので、ここで記録する)
    try:
        await close()
    finally:
        _mark_stream(row_id)


class _SessionStreamResponse(StreamingResponse):
    """返し終えたら(ブラウザがいなくなって本文を一度も読まなかったときも)、開いた Anthropic のストリームを片づける。"""

    def __init__(self, content: AsyncIterator[str], on_close: Callable[[], Awaitable[None]], **kwargs: Any) -> None:
        super().__init__(content, **kwargs)
        self._on_close = on_close

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self._on_close()


@router.get("/session/stream")
async def session_stream(request: Request) -> StreamingResponse:
    _check_available_and_token(request)
    row = _session_row(request)
    client = _client()
    state = agent_session.get_state(row["row_id"], row["session_id"])
    last_event_id = request.headers.get("last-event-id") or None
    # 返事(ヘッダー)の前に、Anthropic のストリームを開いて履歴を読む(§4.5 の 1〜4)。ブラウザはヘッダーが届いたら
    # 「つながった」とみなして発言を送るので、先に返すと、その間にできたイベントを落とす(§6.5)。開けなければ 502 などの JSON
    try:
        prepared = await agent_session.prepare_stream(state, client, last_event_id)
    except RelayError as error:
        _raise_relay(error)
    _mark_stream(row["row_id"])
    return _SessionStreamResponse(
        _marked_frames(row["row_id"], agent_session.stream_frames(state, client, prepared)),
        on_close=functools.partial(
            _close_stream, row["row_id"], functools.partial(agent_session.close_prepared, state, prepared)
        ),
        headers=SSE_HEADERS,
    )


# ---- 送信(§4.7) ----


def _text_bytes(text: str) -> int:
    return len(text.encode("utf-8"))


def _parse_message(data: dict[str, Any]) -> list[dict[str, Any]]:
    if set(data) != {"kind", "content"}:
        _bad_body("message は kind と content だけにしてください")
    content = data["content"]
    if not isinstance(content, list) or not 1 <= len(content) <= 2:
        _bad_body("content は text のブロック 1〜2 個にしてください")
    total = 0
    for block in content:
        if not isinstance(block, dict) or set(block) != {"type", "text"} or block.get("type") != "text":
            _bad_body("content のブロックは type と text だけの text にしてください")
        if not isinstance(block["text"], str) or not block["text"].strip():
            _bad_body("text が空です")
        total += _text_bytes(block["text"])
    if total > MAX_TEXT_BYTES:
        _reject(413, MSG_TOO_LARGE, "text_size")
    if len(content) == 2:
        lines = content[0]["text"].splitlines()
        if not lines or not all(line.startswith(SCREEN_LINE_PREFIXES) for line in lines):
            _bad_body("1つ目のブロックは [画面の状態] か [画面の操作] の行だけにしてください")
    return [{"type": "text", "text": block["text"]} for block in content]


def _parse_results(value: Any, *, minimum: int) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not minimum <= len(value) <= MAX_RESULTS:
        _bad_body(f"results は {minimum}〜{MAX_RESULTS} 件の配列にしてください")
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {"custom_tool_use_id", "text", "is_error"}:
            _bad_body("results の各要素は custom_tool_use_id・text・is_error だけにしてください")
        call_id, text, is_error = item["custom_tool_use_id"], item["text"], item["is_error"]
        if not isinstance(call_id, str) or not call_id or not isinstance(text, str) or not isinstance(is_error, bool):
            _bad_body("results の項目の型が違います")
        if call_id in seen:
            _bad_body("results に同じ custom_tool_use_id が2回あります")
        if _text_bytes(text) > MAX_TEXT_BYTES:
            _reject(413, MSG_TOO_LARGE, "result_size")
        seen.add(call_id)
        results.append({"custom_tool_use_id": call_id, "text": text, "is_error": is_error})
    return results


def _check_message_limits(request: Request) -> None:
    """発言(user.message を送る要求)の上限を確かめて数える。"""
    # 1日の利用額の台帳が上限に達したら、発言だけを止める(結果と止めるは通す。§4.11)
    if get_store().ledger_cents(jst_day(time.time())) >= settings.daily_cost_cents():
        _reject(429, MSG_LIMIT_COST, "rate_cost_day")
    address = _client_address(request)
    if limiter.check("message", address, per_hour=settings.messages_per_ip_hour()) is not None:
        _reject(429, MSG_LIMIT_MESSAGE_HOUR, "rate_message_ip_hour")
    limiter.record("message", address)


@router.post("/session/events")
async def session_events(request: Request) -> JSONResponse:
    _check_available_and_token(request)
    row = _session_row(request)
    data = await _read_json(request, MAX_EVENTS_BODY_BYTES)
    if not isinstance(data, dict) or data.get("kind") not in ("message", "tool_results", "interrupt"):
        _bad_body("kind は message・tool_results・interrupt のどれかにしてください")
    kind = data["kind"]
    content: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    if kind == "message":
        content = _parse_message(data)
    elif kind == "tool_results":
        if set(data) != {"kind", "results"}:
            _bad_body("tool_results は kind と results だけにしてください")
        results = _parse_results(data["results"], minimum=1)
    else:
        if not set(data) <= {"kind", "results"}:
            _bad_body("interrupt は kind と results だけにしてください")
        results = _parse_results(data.get("results", []), minimum=0)

    if kind == "message":
        _check_message_limits(request)

    client = _client()
    state = agent_session.get_state(row["row_id"], row["session_id"])
    try:
        if kind == "message":
            await agent_session.send_message(state, client, content)
        else:
            await agent_session.send_results(state, client, results, interrupt=kind == "interrupt")
    except RelayError as error:
        _raise_relay(error)
    get_store().touch(
        row["row_id"], time.time(), messages=1 if kind == "message" else 0, tool_calls=len(results)
    )
    logger.info("agent 送りました kind=%s results=%d row=%s", kind, len(results), row["row_id"])
    return JSONResponse({"ok": True})


# ---- 前提情報の調査(§3.2・§4.2) ----


@router.post("/session/research")
async def start_research(request: Request) -> dict[str, Any]:
    """調査の対象を決め、[画面の操作] の行を会話に入れる。返すのは正規化した対象の一覧。

    対象の名前・種類・市町村・位置は、サーバーの参照データから入れる(ブラウザが送るのは target_ids だけ)。
    対象は、このセッションの前の対象を置き換える。会話に入れられなければ(ツールの結果待ちなど)、前の対象に戻す。
    """
    _check_available_and_token(request)
    row = _session_row(request)
    data = await _read_json(request, MAX_RESEARCH_BODY_BYTES)
    if not isinstance(data, dict) or set(data) != {"target_ids"}:
        _bad_body("本文は target_ids だけにしてください")
    try:
        target_ids = research.parse_start_ids(data["target_ids"])
    except research.ResearchInputError as error:
        _reject(error.status, error.detail, "research_targets")
    _check_message_limits(request)
    client = _client()
    state = agent_session.get_state(row["row_id"], row["session_id"])
    store = get_store()
    # 調整役がすぐ get_research_targets を呼んでも対象が見えるよう、送る前に入れる
    previous = store.research_target_ids(row["row_id"])
    store.set_research_targets(row["row_id"], target_ids, time.time())
    try:
        await agent_session.send_message(
            state, client, [{"type": "text", "text": research.start_line(len(target_ids))}]
        )
    except RelayError as error:
        store.set_research_targets(row["row_id"], previous)
        _raise_relay(error)
    store.touch(row["row_id"], time.time(), messages=1)
    view = research.session_targets(row["row_id"])
    logger.info("agent 調査の対象を決めました targets=%d row=%s", view["total"], row["row_id"])
    return {"targets": view["targets"], "total": view["total"], "max_targets": view["max_targets"]}


@router.get("/session/research")
def session_research(request: Request) -> dict[str, Any]:
    """このセッションの対象と、保存済みの結果(画面の表示とつなぎ直し用)。"""
    _check_available_and_token(request)
    row = _session_row(request)
    return research.session_overview(row["row_id"])


# ---- 終える(§4.9) ----


@router.delete("/session", status_code=202)
async def delete_session(request: Request, background: BackgroundTasks) -> dict[str, bool]:
    _check_available_and_token(request)
    row = _session_row(request)
    # 取っ手はすぐ使えなくする。Anthropic の側の削除は、返事の後に行う
    get_store().mark_ended(row["row_id"], time.time())
    client = _client()
    background.add_task(agent_session.end_session, row["row_id"], client)
    logger.info("agent セッションを終えます row=%s", row["row_id"])
    return {"accepted": True}
