"""service のグループ分けを TypeSafe AI Jev(Vercel AI Gateway 経由)に確かめてもらう中継。

docs/design-service-groups.md §3.2・§3.3・§3.5・§7.4・§7.5、docs/interfaces-1105.md §4.14。

- ブラウザが送るのは、service ごとに集計した判断材料(数・系統名・行き先・時刻・事業者名・有効期間)と、
  target(どの service を、どの役割で問うか)だけ。GTFS のファイル・停留所の位置・時刻表そのものは受け取らない
- 質問(questions)はサーバーが固定の文から組み立てる。ブラウザから質問の文を受け取らない(汎用の Jev の口にしない)。
  質問の文に入るブラウザの文字列は、候補の service_id だけ
- キー(TYPESAFE_AI_VERCEL_KEY)は Vercel の口(https の ai-gateway.vercel.sh)にだけ送る。ほかの口が設定されていれば
  使えない扱いにし、401・403 が返っても別の口に送り直さない
- 返すのは、使う項目だけに絞った答えと、上流に実際に送った本文(画面の「送った情報を見る」)
- ログには日時・回数・HTTP の状態・失敗の種類・トークンと額の合計・転送先の名前だけを残す。判断材料・State・質問・答え・
  service_id・事業者名・系統名・行き先・キー・IP アドレス・上流のエラーの本文は残さない
"""

import asyncio
import json
import logging
import math
import re
import time
import unicodedata
from collections import Counter
from collections.abc import Awaitable, Callable
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from typing import Annotated, Any, Literal, NoReturn
from urllib.parse import urlsplit

import httpx2
from fastapi import APIRouter, HTTPException, Request
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError

from . import settings
from .ratelimit import RateLimiter, client_address, jst_day
from .store import get_store

logger = logging.getLogger("dispatcher_server.jev")

# HTTP のクライアントは、要求の URL とヘッダーを DEBUG・INFO に出す。WARNING より上だけにする(§3.5)
for _name in ("httpx2", "httpcore2", "httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

router = APIRouter(prefix="/api/service-groups")

PROVIDER = "TypeSafe AI Jev"
VIA = "Vercel AI Gateway"
JEV_HOST = "ai-gateway.vercel.sh"

MAX_BODY_BYTES = 256 * 1024
MAX_SERVICES = 60
MAX_TARGETS = 40
MAX_CANDIDATES = 5
MAX_ROUTES = 20
MAX_HEADSIGNS = 5
MAX_RUNNING_DATES = 10
MAX_ID_CHARS = 100
MAX_NAME_CHARS = 100
MAX_AGENCY_CHARS = 200
MAX_COUNT = 1_000_000

# 送り方(テストで差し替える)
CONCURRENCY = 4
REQUEST_TIMEOUT_SECONDS = 10.0
TOTAL_TIMEOUT_SECONDS = 30.0
RETRY_DELAYS: tuple[float, ...] = (0.5, 1.0)
RETRY_STATUSES = frozenset({429, 503})
PROBABILITY_SUM_TOLERANCE = 0.03

# 1日の額の上限の見込み(マイクロドル)。応答に gateway.cost が無い・届かないときも上限が効くよう、送る前に見込みの額を数え、
# cost が届いたら差を直す。2026-11-04 の試しの1回(入力 8,567・出力 507 トークン)が $0.00036 だったので、
# 1 target あたり少なくとも 360、本文が大きければ 1 バイトあたり 0.02(2 バイトで 1 トークン、1 トークン 0.04 マイクロドル)
ESTIMATE_MIN_MICROUSD = 360
ESTIMATE_MICROUSD_PER_BYTE = Decimal("0.02")
# 1 target の額がこれを超える値は、読み違いとみなして使わない($1)
MAX_COST_MICROUSD_PER_TARGET = 1_000_000

# None なら本物の通信。テストは httpx2.MockTransport に差し替える(tests/conftest.py は既定で断る偽物を入れる)
transport: httpx2.AsyncBaseTransport | None = None
sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

limiter = RateLimiter()

JevRole = Literal["weekday", "saturday", "sundayHoliday"]
FailureKind = Literal["timeout", "rate_limited", "upstream", "invalid_answer", "budget"]

NONE_CHOICE = "none"
SERVICE_KINDS = ("regular_weekday", "limited_weekdays", "specific_dates")

MSG_NO_KEY = "Jev は使えません(キーが設定されていません)。規則だけで分けます"
MSG_BAD_URL = "Jev は使えません(送り先の設定が正しくありません)。規則だけで分けます"
MSG_DAILY_LIMIT = "Jev の1日の上限に達したため、規則だけで分けます。日本時間の翌日になってから使えます"
MSG_LIMIT_HOUR = "Jev に問う回数の上限に達しました(1 時間あたり)。規則だけで分けます。しばらくしてから使えます"
MSG_LIMIT_DAY = "Jev に問う回数の上限に達しました(1 日あたり)。規則だけで分けます。日本時間の翌日になってから使えます"
MSG_TOO_LARGE = "判断材料が大きすぎます"
MSG_NO_ADDRESS = "接続元を確かめられません"
MSG_BAD_BODY = "判断材料の形が正しくありません"

UNAVAILABLE_MESSAGES = {"noKey": MSG_NO_KEY, "badUrl": MSG_BAD_URL, "dailyLimit": MSG_DAILY_LIMIT}


# ---- 入力の形(docs/design-service-groups.md §7.5 の JevJudgeRequest) ----


def _no_control(value: str) -> str:
    # service_id は質問の文と choice の名前に入るので、改行・タブなどの制御文字と書式の文字を断る。
    # 対になっていないサロゲート(Cs)は UTF-8 にできず、上流に送る前に失敗するので断る
    if any(unicodedata.category(char) in ("Cc", "Cf", "Cs", "Zl", "Zp") for char in value):
        raise ValueError("control")
    return value


def _no_surrogate(value: str) -> str:
    # 系統名・行き先・事業者名は State の値(JSON の文字列)にだけ入るので、長さとサロゲートだけを見る
    # (GTFS の名前を理由に全体を断らない。サロゲートは UTF-8 にできず、送る前に失敗するので 422 にする)
    if any(unicodedata.category(char) == "Cs" for char in value):
        raise ValueError("surrogate")
    return value


Id = Annotated[str, Field(min_length=1, max_length=MAX_ID_CHARS), AfterValidator(_no_control)]
Name = Annotated[str, Field(max_length=MAX_NAME_CHARS), AfterValidator(_no_surrogate)]
Agency = Annotated[str, Field(max_length=MAX_AGENCY_CHARS), AfterValidator(_no_surrogate)]
Count = Annotated[int, Field(ge=0, le=MAX_COUNT)]
Ratio = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
Date = Annotated[str, Field(pattern=r"^[0-9]{8}$")]
# GTFS の時刻は 24 時を超える(25:10 など)。時は1〜2桁
ClockTime = Annotated[str, Field(pattern=r"^[0-9]{1,2}:[0-5][0-9]$")]


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DayCounts(_Wire):
    weekday: Count
    saturday: Count
    sundayHoliday: Count


class RunningDays(DayCounts):
    total: Count


class Coverage(_Wire):
    weekday: Ratio
    saturday: Ratio
    sundayHoliday: Ratio


class Period(_Wire):
    start: Date
    end: Date


class FeedWire(_Wire):
    agency: Agency | None
    period: Period
    daysInPeriod: DayCounts


class RouteWire(_Wire):
    name: Name
    trips: Count


class ServiceWire(_Wire):
    serviceId: Id
    tripCount: Count
    routeCount: Count
    runningDays: RunningDays
    coverage: Coverage
    firstDeparture: ClockTime | None
    lastArrival: ClockTime | None
    routes: Annotated[list[RouteWire], Field(max_length=MAX_ROUTES)]
    headsigns: Annotated[list[Name], Field(max_length=MAX_HEADSIGNS)]
    runningDates: Annotated[list[Date], Field(max_length=MAX_RUNNING_DATES)] | None


class CandidateWire(_Wire):
    serviceId: Id
    routeOverlap: Ratio


class TargetWire(_Wire):
    serviceId: Id
    role: JevRole
    candidates: Annotated[list[CandidateWire], Field(max_length=MAX_CANDIDATES)]


class JevJudgeRequest(_Wire):
    feed: FeedWire
    services: Annotated[list[ServiceWire], Field(min_length=1, max_length=MAX_SERVICES)]
    targets: Annotated[list[TargetWire], Field(min_length=1, max_length=MAX_TARGETS)]


# ---- 出力の形(§7.5 の JevJudgeResponse。テストと固定のデータの確かめに使う) ----


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class JevChoice(_Out):
    choice: str
    probabilities: dict[str, float]
    confidence: float | None


class SchoolService(_Out):
    probability: float


class SentBody(_Out):
    state: dict[str, Any]
    questions: dict[str, Any]


class JevTargetResult(_Out):
    serviceId: str
    role: JevRole
    provider: str | None
    sent: SentBody
    serviceKind: JevChoice | None = None
    schoolService: SchoolService | None = None
    weekdayCounterpart: JevChoice | None = None


class JevFailure(_Out):
    serviceId: str
    role: JevRole
    error: FailureKind
    # 上流に送った後の失敗(timeout・upstream・rate_limited・invalid_answer)だけ。送る前の失敗(budget など)には無い
    sent: SentBody | None = None


class JevUsage(_Out):
    inputTokens: int
    costUsd: float | None


class JevJudgeResponse(_Out):
    model: str
    results: list[JevTargetResult]
    failures: list[JevFailure]
    usage: JevUsage


def _field_names(*models: type[BaseModel]) -> frozenset[str]:
    return frozenset(name for model in models for name in model.model_fields)


_KNOWN_FIELDS = _field_names(
    DayCounts, RunningDays, Coverage, Period, FeedWire, RouteWire, ServiceWire, CandidateWire, TargetWire, JevJudgeRequest
)

_ERROR_WORDS = {
    "missing": "ありません",
    "extra_forbidden": "知らない項目です",
    "string_too_short": "空です",
    "string_too_long": "長すぎます",
    "too_short": "少なすぎます",
    "too_long": "多すぎます",
    "greater_than_equal": "範囲の外です",
    "less_than_equal": "範囲の外です",
    "finite_number": "範囲の外です",
    "string_pattern_mismatch": "書き方が違います",
    "literal_error": "値が違います",
    "value_error": "使えない文字があります",
}


def _location(loc: tuple[int | str, ...]) -> str:
    # 送られた値は返さない(pydantic の input・msg を使わない)。知らない項目の名前も、送られた文字列なので出さない
    parts = [str(part) if isinstance(part, int) or part in _KNOWN_FIELDS else "(知らない項目)" for part in loc]
    return ".".join(parts) or "(本文)"


def _validation_detail(error: ValidationError) -> str:
    errors = error.errors(include_input=False, include_url=False)
    first = errors[0]
    word = _ERROR_WORDS.get(first["type"], "型が違います" if first["type"].endswith("_type") else "形が違います")
    rest = f"ほか {len(errors) - 1} 件" if len(errors) > 1 else ""
    return f"{MSG_BAD_BODY}({_location(first['loc'])}:{word}{rest})"


def _reference_problem(request: JevJudgeRequest) -> str | None:
    """service_id のつながり(§3.3)を確かめる。問題があれば日本語の文(送られた値は入れない)。"""
    ids: set[str] = set()
    for index, service in enumerate(request.services):
        if service.serviceId in ids:
            return f"services.{index}.serviceId が、前の service と同じです"
        ids.add(service.serviceId)
    seen: set[tuple[str, str]] = set()
    for index, target in enumerate(request.targets):
        where = f"targets.{index}"
        if target.serviceId not in ids:
            return f"{where}.serviceId が services にありません"
        key = (target.serviceId, target.role)
        if key in seen:
            return f"{where} と同じ serviceId と role の target が前にあります"
        seen.add(key)
        if target.role == "weekday":
            if target.candidates:
                return f"{where}.candidates は、role が weekday のときは空にしてください"
            continue
        if not target.candidates:
            return f"{where}.candidates は、role が saturday・sundayHoliday のときは 1〜{MAX_CANDIDATES} 個にしてください"
        candidate_ids: set[str] = set()
        for position, candidate in enumerate(target.candidates):
            spot = f"{where}.candidates.{position}.serviceId"
            if candidate.serviceId not in ids:
                return f"{spot} が services にありません"
            if candidate.serviceId == target.serviceId:
                return f"{spot} が target 自身です"
            if candidate.serviceId == NONE_CHOICE:
                return f"{spot} に「{NONE_CHOICE}」は使えません(「どれでもない」の答えの名前と重なるため)"
            if candidate.serviceId in candidate_ids:
                return f"{spot} が、前の候補と同じです"
            candidate_ids.add(candidate.serviceId)
    return None


# ---- State と質問(§3.3) ----

_ASKED_AS = {"weekday": "weekday", "saturday": "saturday", "sundayHoliday": "sunday_or_holiday"}
_TIMETABLE = {"saturday": "the Saturday timetable", "sundayHoliday": "the Sunday and holiday timetable"}


def _day_counts(counts: DayCounts) -> dict[str, str]:
    return {
        "weekday": str(counts.weekday),
        "saturday": str(counts.saturday),
        "sunday_or_holiday": str(counts.sundayHoliday),
    }


def _ratio(value: float) -> str:
    return f"{value:.2f}"


def _date(value: str) -> str:
    return f"{value[:4]}-{value[4:6]}-{value[6:]}"


def _feed_state(feed: FeedWire) -> dict[str, Any]:
    state: dict[str, Any] = {}
    if feed.agency is not None:
        state["agency"] = feed.agency
    state["period"] = f"{_date(feed.period.start)} to {_date(feed.period.end)}"
    state["days_in_period"] = _day_counts(feed.daysInPeriod)
    return state


def _service_state(service: ServiceWire, *, asked_as: str | None = None) -> dict[str, Any]:
    state: dict[str, Any] = {"service_id": service.serviceId}
    if asked_as is not None:
        state["asked_as"] = asked_as
    state["trips"] = str(service.tripCount)
    state["route_count"] = str(service.routeCount)
    state["running_days"] = {"total": str(service.runningDays.total), **_day_counts(service.runningDays)}
    state["coverage"] = {
        "weekday": _ratio(service.coverage.weekday),
        "saturday": _ratio(service.coverage.saturday),
        "sunday_or_holiday": _ratio(service.coverage.sundayHoliday),
    }
    if service.firstDeparture is not None:
        state["first_departure"] = service.firstDeparture
    if service.lastArrival is not None:
        state["last_arrival"] = service.lastArrival
    # 同じ名前の系統が2つあれば便数を足す(名前を鍵にするため)
    trips_by_route: dict[str, int] = {}
    for route in service.routes:
        trips_by_route[route.name] = trips_by_route.get(route.name, 0) + route.trips
    state["routes_with_trip_counts"] = {name: str(trips) for name, trips in trips_by_route.items()}
    state["headsigns"] = list(service.headsigns)
    if service.runningDates is not None:
        state["running_dates"] = [_date(day) for day in service.runningDates]
    return state


def build_state(request: JevJudgeRequest, target: TargetWire) -> dict[str, Any]:
    services = {service.serviceId: service for service in request.services}
    state: dict[str, Any] = {
        "feed": _feed_state(request.feed),
        "target": _service_state(services[target.serviceId], asked_as=_ASKED_AS[target.role]),
    }
    if target.role != "weekday":
        state["candidates"] = [
            {
                **_service_state(services[candidate.serviceId]),
                "route_overlap_with_target": _ratio(candidate.routeOverlap),
            }
            for candidate in target.candidates
        ]
    return state


def build_questions(target: TargetWire) -> dict[str, Any]:
    """質問は固定の文。ブラウザの文字列で入るのは候補の service_id だけ。"""
    if target.role == "weekday":
        return {
            "service_kind": {
                "type": "choice",
                "instructions": (
                    "The service in `target` is judged as a weekday service (it may also run on a few other days). "
                    "On which weekdays does it run? Base your answer on `target.running_days`, `target.coverage` "
                    "(the share of the days of each type in `feed.period` on which the service runs, from 0 to 1), "
                    "`target.running_dates` (given only when the service runs on 10 days or fewer), "
                    "the route names and the headsigns."
                ),
                "criteria": {
                    "regular_weekday": "Runs on almost all ordinary weekdays (Monday to Friday, not holidays) in the period.",
                    "limited_weekdays": (
                        "Runs only on a clearly limited subset of the weekdays, such as university term days "
                        "or one particular day of the week."
                    ),
                    "specific_dates": "Runs on only a few specific dates, such as event days or a temporary detour.",
                },
            },
            "is_school_service": {
                "type": "boolean",
                "instructions": (
                    "Is the service in `target` mainly for students going to a university or school, "
                    "running only on class days? Judge from the route names, the headsigns and the running days."
                ),
            },
        }
    timetable = _TIMETABLE[target.role]
    criteria = {
        candidate.serviceId: f"The weekday service with service_id {candidate.serviceId}."
        for candidate in target.candidates
    }
    criteria[NONE_CHOICE] = "No candidate runs most of the routes of the target, so none of them is its weekday counterpart."
    return {
        "weekday_counterpart": {
            "type": "choice",
            "instructions": (
                f"Weekdays are switched to {timetable}. The trips of the service in `target` then run on weekdays, "
                "in place of the trips of one weekday service. Which service in `candidates` is the weekday service "
                "whose trips the trips of `target` replace? Compare `routes_with_trip_counts`, "
                "`route_overlap_with_target` (from 0 to 1, how much the routes of the candidate overlap the routes "
                "of `target`), the operating hours (`first_departure`, `last_arrival`), the running days and the "
                "service_id naming. A candidate may have a few extra routes or a different number of trips. "
                "Choose none only if no candidate runs most of the routes of `target`."
            ),
            "criteria": criteria,
        }
    }


# ---- 答えの確かめ(§3.3) ----


def _probability(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= 1:
        return None
    return number


class _InvalidAnswer(Exception):
    pass


def _dig(value: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _choice(answer: Any, criteria: dict[str, str], confidence: Any) -> dict[str, Any]:
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        raise _InvalidAnswer
    choice = answer.get("choice")
    probabilities = answer.get("probabilities")
    if not isinstance(choice, str) or choice not in criteria:
        raise _InvalidAnswer
    if not isinstance(probabilities, dict) or set(probabilities) != set(criteria):
        raise _InvalidAnswer
    parsed: dict[str, float] = {}
    for name in criteria:  # 並びは質問の criteria の順にそろえる
        number = _probability(probabilities[name])
        if number is None:
            raise _InvalidAnswer
        parsed[name] = number
    if abs(sum(parsed.values()) - 1) > PROBABILITY_SUM_TOLERANCE:
        raise _InvalidAnswer
    level: float | None = None
    if confidence is not None:
        level = _probability(confidence)
        if level is None:
            raise _InvalidAnswer
    return {"choice": choice, "probabilities": parsed, "confidence": level}


def parse_answers(role: str, questions: dict[str, Any], body: Any) -> dict[str, Any]:
    """上流の応答から使う項目だけを取り出す。形が合わなければ _InvalidAnswer。"""
    answers = _dig(body, "answers")
    if not isinstance(answers, dict):
        raise _InvalidAnswer
    confidences = _dig(body, "providerMetadata", "typesafe", "confidence")
    if confidences is not None and not isinstance(confidences, dict):
        raise _InvalidAnswer
    confidences = confidences or {}
    if role == "weekday":
        kind = _choice(answers.get("service_kind"), questions["service_kind"]["criteria"], confidences.get("service_kind"))
        school = answers.get("is_school_service")
        if not isinstance(school, dict) or school.get("type") != "boolean":
            raise _InvalidAnswer
        probability = _probability(school.get("probability"))
        if probability is None:
            raise _InvalidAnswer
        return {"serviceKind": kind, "schoolService": {"probability": probability}}
    counterpart = _choice(
        answers.get("weekday_counterpart"),
        questions["weekday_counterpart"]["criteria"],
        confidences.get("weekday_counterpart"),
    )
    return {"weekdayCounterpart": counterpart}


_PROVIDER_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")
_MODEL_PATTERN = re.compile(r"[A-Za-z0-9._/-]{1,64}")


def _provider(body: Any) -> str | None:
    # 上流が決める文字列なので、名前の形のものだけを返し、ログに出す
    value = _dig(body, "providerMetadata", "gateway", "routing", "finalProvider")
    return value if isinstance(value, str) and _PROVIDER_PATTERN.fullmatch(value) else None


def _cost_microusd(body: Any) -> int | None:
    value = _dig(body, "providerMetadata", "gateway", "cost")
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        cost = Decimal(str(value))
    except InvalidOperation:
        return None
    if not cost.is_finite() or cost < 0:
        return None
    microusd = int((cost * 1_000_000).to_integral_value(rounding=ROUND_CEILING))
    if microusd > MAX_COST_MICROUSD_PER_TARGET:
        logger.warning("jev 応答の額が 1 target の上限を超えるため、使いませんでした")
        return None
    return microusd


def estimate_microusd(content: bytes) -> int:
    """送る本文から見込む額(マイクロドル)。上限の確かめに先に数える。"""
    by_size = int((Decimal(len(content)) * ESTIMATE_MICROUSD_PER_BYTE).to_integral_value(rounding=ROUND_CEILING))
    return max(ESTIMATE_MIN_MICROUSD, by_size)


def _input_tokens(body: Any) -> int:
    value = _dig(body, "usage", "inputTokens")
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


# ---- 送り方 ----


def url_ok(url: str) -> bool:
    """キーを送ってよい口か:https で、ホストが ai-gateway.vercel.sh(利用者名・別のポートなし)。"""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and parts.hostname == JEV_HOST
        and parts.username is None
        and parts.password is None
        and port in (None, 443)
        and "@" not in parts.netloc
    )


def unavailable_reason() -> str | None:
    if settings.jev_api_key() is None:
        return "noKey"
    if not url_ok(settings.jev_url()):
        return "badUrl"
    targets, cost = get_store().jev_usage(jst_day(time.time()))
    if targets >= settings.jev_targets_per_day() or cost >= settings.jev_cost_cents_per_day() * 10_000:
        return "dailyLimit"
    return None


class _Outcome:
    __slots__ = ("cost", "error", "fields", "input_tokens", "model", "provider", "sent", "statuses", "exceptions")

    def __init__(self) -> None:
        self.error: FailureKind | None = None
        self.fields: dict[str, Any] = {}
        self.sent: dict[str, Any] | None = None
        self.provider: str | None = None
        self.model: str | None = None
        self.cost: int | None = None
        self.input_tokens = 0
        self.statuses: list[int] = []
        self.exceptions: list[str] = []


def _headers(key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "ai-gateway-protocol-version": "0.0.1",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": jev_model(),
    }


def jev_model() -> str:
    """設定のモデルの名前。形が違う・typesafe-ai/ で始まらないなら既定のモデル(同じキーで別のモデルを呼ばないため)。"""
    model = settings.jev_model()
    if _MODEL_PATTERN.fullmatch(model) and model.startswith("typesafe-ai/"):
        return model
    logger.warning("DISPATCHER_JEV_MODEL の形が違うため、既定のモデルを使います")
    return settings.DEFAULT_JEV_MODEL


async def _judge_one(
    client: httpx2.AsyncClient,
    semaphore: asyncio.Semaphore,
    request: JevJudgeRequest,
    target: TargetWire,
    outcome: _Outcome,
) -> None:
    state = build_state(request, target)
    questions = build_questions(target)
    content = json.dumps({"state": state, "questions": questions}, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    key = settings.jev_api_key()
    url = settings.jev_url()
    if key is None or not url_ok(url):  # 送る直前にもう一度確かめる(キーを Vercel の口だけに送る)
        outcome.error = "upstream"
        return
    estimate = estimate_microusd(content)
    async with semaphore:
        store = get_store()
        if not store.reserve_jev_target(
            jst_day(time.time()),
            max_targets=settings.jev_targets_per_day(),
            max_microusd=settings.jev_cost_cents_per_day() * 10_000,
            estimate_microusd=estimate,
        ):
            outcome.error = "budget"
            return
        # 画面の「送った情報を見る」には、上流に送ったバイト列そのものを読み直して返す
        outcome.sent = json.loads(content)
        response: httpx2.Response | None = None
        for attempt in range(len(RETRY_DELAYS) + 1):
            try:
                response = await asyncio.wait_for(
                    client.post(url, content=content, headers=_headers(key)), timeout=REQUEST_TIMEOUT_SECONDS
                )
            except (TimeoutError, httpx2.TimeoutException):
                outcome.error = "timeout"
                return
            except httpx2.HTTPError as exc:
                outcome.exceptions.append(type(exc).__name__)
                outcome.error = "upstream"
                return
            outcome.statuses.append(response.status_code)
            if response.status_code in RETRY_STATUSES and attempt < len(RETRY_DELAYS):
                await sleep(RETRY_DELAYS[attempt])
                continue
            break
    assert response is not None
    if response.status_code != 200:
        # 上流のエラーの本文は読まない・残さない(S9)
        outcome.error = "rate_limited" if response.status_code == 429 else "upstream"
        return
    try:
        body = response.json()
    except (ValueError, RecursionError):
        outcome.error = "invalid_answer"
        return
    # 答えの形が合わなくても、額は数える(上流は答えを返している)。cost が届けば見込みの額との差を直し、
    # 届かなければ見込みの額のまま(200 以外・timeout でも、上流が課金していることがあるので見込みの額を残す)
    outcome.cost = _cost_microusd(body)
    if outcome.cost is not None:
        get_store().adjust_jev_cost(jst_day(time.time()), outcome.cost - estimate)
    outcome.input_tokens = _input_tokens(body)
    outcome.provider = _provider(body)
    model = body.get("model") if isinstance(body, dict) else None
    outcome.model = model if isinstance(model, str) and _MODEL_PATTERN.fullmatch(model) else None
    try:
        outcome.fields = parse_answers(target.role, questions, body)
    except _InvalidAnswer:
        outcome.error = "invalid_answer"


def new_client() -> httpx2.AsyncClient:
    """上流に送るクライアント。リダイレクトをたどらず(キーを別の口に送らない)、環境変数(HTTPS_PROXY・ALL_PROXY・
    SSL_CERT_FILE・.netrc など)を読まない(キーを付けた要求の通り道と、信頼する証明書を環境で変えさせない)。"""
    return httpx2.AsyncClient(
        transport=transport, timeout=httpx2.Timeout(REQUEST_TIMEOUT_SECONDS), follow_redirects=False, trust_env=False
    )


async def judge(request: JevJudgeRequest) -> tuple[dict[str, Any], dict[str, Any]]:
    """target ごとに Jev に問う。返すのは (応答の本文, ログ用の数)。"""
    outcomes = [_Outcome() for _ in request.targets]
    semaphore = asyncio.Semaphore(CONCURRENCY)
    async with new_client() as client:
        tasks = [
            asyncio.create_task(_judge_one(client, semaphore, request, target, outcome))
            for target, outcome in zip(request.targets, outcomes, strict=True)
        ]
        _done, pending = await asyncio.wait(tasks, timeout=TOTAL_TIMEOUT_SECONDS)
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for task, outcome in zip(tasks, outcomes, strict=True):
            if task in pending:
                outcome.error = "timeout"
            elif not task.cancelled() and task.exception() is not None:
                outcome.exceptions.append(type(task.exception()).__name__)
                outcome.error = "upstream"

    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    input_tokens = 0
    costs: list[int] = []
    model: str | None = None
    for target, outcome in zip(request.targets, outcomes, strict=True):
        input_tokens += outcome.input_tokens
        if outcome.cost is not None:
            costs.append(outcome.cost)
        if outcome.error is not None or outcome.sent is None:
            failure: dict[str, Any] = {"serviceId": target.serviceId, "role": target.role, "error": outcome.error or "upstream"}
            # 上流に送った後の失敗は、送った本文も返す(画面の「送った情報を見る」で、外に出た判断材料を全部見せるため)
            if outcome.sent is not None:
                failure["sent"] = outcome.sent
            failures.append(failure)
            continue
        model = model or outcome.model
        results.append(
            {
                "serviceId": target.serviceId,
                "role": target.role,
                "provider": outcome.provider,
                "sent": outcome.sent,
                **outcome.fields,
            }
        )
    cost_usd = float(Decimal(sum(costs)) / 1_000_000) if costs else None
    body = {
        "model": model or jev_model(),
        "results": results,
        "failures": failures,
        "usage": {"inputTokens": input_tokens, "costUsd": cost_usd},
    }
    stats = {
        "targets": len(request.targets),
        "answered": len(results),
        "failures": Counter(item["error"] for item in failures),
        "statuses": Counter(status for outcome in outcomes for status in outcome.statuses),
        "exceptions": Counter(name for outcome in outcomes for name in outcome.exceptions),
        "providers": Counter(outcome.provider or "unknown" for outcome in outcomes if outcome.error is None),
        "input_tokens": input_tokens,
        "cost_microusd": sum(costs),
    }
    return body, stats


# ---- エンドポイント ----


def _reject(status_code: int, detail: str, reason: str) -> NoReturn:
    logger.info("jev 要求を断りました status=%d reason=%s", status_code, reason)
    raise HTTPException(status_code=status_code, detail=detail)


def _counts(counter: Counter[str] | Counter[int]) -> str:
    return ",".join(f"{key}:{count}" for key, count in sorted(counter.items(), key=lambda item: str(item[0]))) or "-"


async def _read_body(request: Request) -> bytes:
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        _reject(413, MSG_TOO_LARGE, "body_size")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            _reject(413, MSG_TOO_LARGE, "body_size")
        chunks.append(chunk)
    return b"".join(chunks)


def _parse_request(raw: bytes) -> JevJudgeRequest:
    try:
        data = json.loads(raw or b"null")
    except (ValueError, RecursionError):
        _reject(422, f"{MSG_BAD_BODY}(JSON として読めません)", "json")
    try:
        parsed = JevJudgeRequest.model_validate(data)
    except ValidationError as error:
        _reject(422, _validation_detail(error), "shape")
    except RecursionError:
        _reject(422, f"{MSG_BAD_BODY}(入れ子が深すぎます)", "shape")
    problem = _reference_problem(parsed)
    if problem is not None:
        _reject(422, f"{MSG_BAD_BODY}({problem})", "reference")
    return parsed


@router.get("")
def service_groups_status() -> dict[str, Any]:
    """Jev を使えるか。画面は available が false なら Jev を呼ばず、規則だけで分ける。"""
    reason = unavailable_reason()
    return {"available": reason is None, "provider": PROVIDER, "via": VIA, "reason": reason}


@router.post("/judge")
async def judge_service_groups(request: Request) -> dict[str, Any]:
    reason = unavailable_reason()
    if reason in ("noKey", "badUrl"):
        _reject(503, UNAVAILABLE_MESSAGES[reason], reason)
    raw = await _read_body(request)
    parsed = _parse_request(raw)
    address = client_address(request)
    if address is None:
        _reject(400, MSG_NO_ADDRESS, "real_ip")
    if reason == "dailyLimit":
        _reject(429, MSG_DAILY_LIMIT, "jev_day_total")
    limited = limiter.check(
        "jev", address, per_hour=settings.jev_requests_per_ip_hour(), per_day=settings.jev_requests_per_ip_day()
    )
    if limited == "day":
        _reject(429, MSG_LIMIT_DAY, "rate_jev_ip_day")
    if limited == "hour":
        _reject(429, MSG_LIMIT_HOUR, "rate_jev_ip_hour")
    limiter.record("jev", address)
    started = time.monotonic()
    body, stats = await judge(parsed)
    logger.info(
        "jev 判定しました targets=%d answered=%d failures=%s statuses=%s exceptions=%s providers=%s"
        " input_tokens=%d cost_microusd=%d seconds=%.1f",
        stats["targets"],
        stats["answered"],
        _counts(stats["failures"]),
        _counts(stats["statuses"]),
        _counts(stats["exceptions"]),
        _counts(stats["providers"]),
        stats["input_tokens"],
        stats["cost_microusd"],
        time.monotonic() - started,
    )
    return body
