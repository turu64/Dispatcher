"""Jev の中継(service_groups.py)のテスト。docs/design-service-groups.md §7.4 の受け入れ条件。

本物の Jev(Vercel AI Gateway)は呼ばない。上流は httpx2.MockTransport の偽物に差し替える
(tests/conftest.py は、差し替えないテストのために、送ろうとすると失敗する偽物を既定で入れる)。

固定のデータ tests/fixtures/jev_judge_request.json の数・系統名・行き先は、北海道中央バスの GTFS
(北海道オープンデータプラットフォーム、CC BY 4.0。2026-11-03 に利用者がフォームに記入してダウンロードしたもの)から
集計した値(S000001・S000014・S000027。系統名と行き先は上位の数件だけ)。
jev_judge_response.json の答え(確率・確信度・トークン・額)は、テスト用に作った値で、本物の Jev の答えではない。
"""

import asyncio
import copy
import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from dispatcher_server import service_groups, settings, store
from dispatcher_server.app import app
from dispatcher_server.ratelimit import jst_day
from dispatcher_server.store import get_store

FIXTURES = Path(__file__).parent / "fixtures"
KEY = "vck-test-key-0123456789-secret"
URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
MARK = "LEAKMARK7731"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def request_body() -> dict[str, Any]:
    return copy.deepcopy(load_fixture("jev_judge_request.json"))


# 固定のデータの答え(jev_judge_response.json と同じ値)
FIXTURE_ANSWERS: dict[str, tuple[dict[str, Any], dict[str, float], int, str]] = {
    "S000027": (
        {
            "weekday_counterpart": {
                "type": "choice",
                "choice": "S000001",
                "probabilities": {"S000001": 0.95, "S000014": 0.03, "none": 0.02},
            }
        },
        {"weekday_counterpart": 0.93},
        9120,
        "0.000383",
    ),
    "S000014": (
        {
            "service_kind": {
                "type": "choice",
                "choice": "regular_weekday",
                "probabilities": {"regular_weekday": 0.82, "limited_weekdays": 0.15, "specific_dates": 0.03},
            },
            "is_school_service": {"type": "boolean", "probability": 0.05},
        },
        {"service_kind": 0.88},
        3010,
        "0.000126",
    ),
}


def jev_body(
    answers: dict[str, Any],
    confidence: dict[str, float] | None = None,
    *,
    tokens: int = 1000,
    cost: str | None = "0.0001",
    provider: Any = "typesafe-ai",
) -> dict[str, Any]:
    gateway: dict[str, Any] = {"routing": {"finalProvider": provider, "fallbacksAvailable": ["digitalocean"]}}
    if cost is not None:
        gateway["cost"] = cost
    return {
        "answers": answers,
        "model": "typesafe-ai/jev",
        "rounding": {"probabilityDecimals": 2, "scoreDecimals": 2},
        "usage": {"inputTokens": tokens, "outputTokens": 100},
        "warnings": [],
        "providerMetadata": {"typesafe": {"confidence": confidence or {}}, "gateway": gateway},
    }


def good_answers(sent: dict[str, Any]) -> tuple[dict[str, Any], dict[str, float]]:
    """送られた質問に合う答え(固定のデータに無い target 用)。"""
    questions = sent["questions"]
    if "service_kind" in questions:
        return FIXTURE_ANSWERS["S000014"][0], FIXTURE_ANSWERS["S000014"][1]
    names = list(questions["weekday_counterpart"]["criteria"])
    probabilities = {name: 0.0 for name in names}
    probabilities[names[0]] = 1.0
    return (
        {"weekday_counterpart": {"type": "choice", "choice": names[0], "probabilities": probabilities}},
        {"weekday_counterpart": 0.95},
    )


class Upstream:
    """偽物の Jev。受けた要求を残し、respond で答えを決める(既定は固定のデータの答え)。"""

    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []

    def respond(self, sent: dict[str, Any], attempt: int) -> httpx2.Response:
        target = sent["state"]["target"]["service_id"]
        if target in FIXTURE_ANSWERS and target in ("S000027", "S000014"):
            answers, confidence, tokens, cost = FIXTURE_ANSWERS[target]
            return httpx2.Response(200, json=jev_body(answers, confidence, tokens=tokens, cost=cost))
        answers, confidence = good_answers(sent)
        return httpx2.Response(200, json=jev_body(answers, confidence))

    async def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        sent = json.loads(request.content)
        attempt = sum(
            1 for r in self.requests if json.loads(r.content)["state"]["target"] == sent["state"]["target"]
        )
        result = self.respond(sent, attempt)
        if asyncio.iscoroutine(result):
            result = await result
        return result

    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.content) for request in self.requests]


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> Upstream:
    fake = Upstream()
    monkeypatch.setattr(service_groups, "transport", httpx2.MockTransport(fake))
    return fake


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    recorded: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        recorded.append(seconds)

    monkeypatch.setattr(service_groups, "sleep", fake_sleep)
    return recorded


def enable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_AI_VERCEL_KEY", KEY)


def post(client: TestClient, body: Any, **headers: str) -> httpx2.Response:
    return client.post("/api/service-groups/judge", json=body, headers=headers)


def sent_failures(body: dict[str, Any], upstream: Upstream) -> list[dict[str, Any]]:
    """上流に送った後の失敗:どれにも sent があり、上流に送った本文と同じことを確かめて、sent を除いた一覧を返す。"""
    sent_by_target = {sent["state"]["target"]["service_id"]: sent for sent in upstream.bodies()}
    stripped: list[dict[str, Any]] = []
    for failure in body["failures"]:
        item = dict(failure)
        assert item.pop("sent") == sent_by_target[item["serviceId"]]
        stripped.append(item)
    return stripped


# ---- 1. 使えないとき ----


def test_status_without_key(client: TestClient) -> None:
    response = client.get("/api/service-groups")
    assert response.status_code == 200
    assert response.json() == {
        "available": False,
        "provider": "TypeSafe AI Jev",
        "via": "Vercel AI Gateway",
        "reason": "noKey",
    }


def test_judge_without_key_is_503_and_sends_nothing(client: TestClient, upstream: Upstream) -> None:
    response = post(client, request_body())
    assert response.status_code == 503
    assert "Jev は使えません" in response.json()["detail"]
    assert upstream.requests == []


def test_status_available_with_key(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    enable(monkeypatch)
    assert client.get("/api/service-groups").json()["available"] is True
    assert client.get("/api/service-groups").json()["reason"] is None


@pytest.mark.parametrize(
    "url",
    [
        "http://ai-gateway.vercel.sh/v4/ai/evaluation-model",
        "https://example.com/v4/ai/evaluation-model",
        "https://ai-gateway.vercel.sh.example.com/v4/ai/evaluation-model",
        "https://user@ai-gateway.vercel.sh/v4/ai/evaluation-model",
        "https://ai-gateway.vercel.sh:8443/v4/ai/evaluation-model",
        "https://evil.example@ai-gateway.vercel.sh/",
        "ai-gateway.vercel.sh/v4",
        "https://[::1/",
    ],
)
def test_bad_url_is_unavailable_and_sends_nothing(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, url: str
) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_JEV_URL", url)
    assert client.get("/api/service-groups").json()["reason"] == "badUrl"
    response = post(client, request_body())
    assert response.status_code == 503
    assert "送り先" in response.json()["detail"]
    assert upstream.requests == []


def test_url_ok_accepts_the_gateway() -> None:
    assert service_groups.url_ok(URL)
    assert service_groups.url_ok("https://ai-gateway.vercel.sh:443/v4/ai/evaluation-model")
    assert settings.jev_url() == URL


# ---- 2・3・9・10. 正常 ----


def test_judge_matches_fixture_and_sends_fixed_questions(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream
) -> None:
    enable(monkeypatch)
    response = post(client, request_body())
    assert response.status_code == 200, response.text
    assert KEY not in response.text
    body = response.json()
    # 応答の全体が固定のデータと同じ(B と A の取り決めの例。サーバーの State・質問を変えたら固定のデータも作り直す)
    assert body == load_fixture("jev_judge_response.json")
    service_groups.JevJudgeResponse.model_validate(body)

    assert len(upstream.requests) == 2
    for request in upstream.requests:
        assert request.method == "POST"
        assert str(request.url) == URL
        assert request.headers["authorization"] == f"Bearer {KEY}"
        assert request.headers["content-type"] == "application/json"
        assert request.headers["ai-gateway-protocol-version"] == "0.0.1"
        assert request.headers["ai-evaluation-model-specification-version"] == "4"
        assert request.headers["ai-model-id"] == "typesafe-ai/jev"
        sent = json.loads(request.content)
        assert set(sent) == {"state", "questions"}

    by_target = {sent["state"]["target"]["service_id"]: sent for sent in upstream.bodies()}
    weekday_questions = by_target["S000014"]["questions"]
    assert set(weekday_questions) == {"service_kind", "is_school_service"}
    assert weekday_questions["service_kind"]["type"] == "choice"
    assert list(weekday_questions["service_kind"]["criteria"]) == list(service_groups.SERVICE_KINDS)
    assert weekday_questions["is_school_service"]["type"] == "boolean"
    assert "criteria" not in weekday_questions["is_school_service"]
    assert "candidates" not in by_target["S000014"]["state"]

    saturday_questions = by_target["S000027"]["questions"]
    assert set(saturday_questions) == {"weekday_counterpart"}
    counterpart = saturday_questions["weekday_counterpart"]
    assert counterpart["type"] == "choice"
    assert list(counterpart["criteria"]) == ["S000001", "S000014", "none"]
    assert all(isinstance(value, str) for value in counterpart["criteria"].values())
    assert [c["service_id"] for c in by_target["S000027"]["state"]["candidates"]] == ["S000001", "S000014"]
    assert by_target["S000027"]["state"]["target"]["asked_as"] == "saturday"

    # 3. 返した sent は、上流に送った本文と同じ
    for result in body["results"]:
        assert result["sent"] == by_target[result["serviceId"]]

    # 9. 転送先と合計
    assert {result["provider"] for result in body["results"]} == {"typesafe-ai"}
    assert body["usage"] == {"inputTokens": 9120 + 3010, "costUsd": pytest.approx(0.000509)}
    # 額は jev_usage に入る(マイクロドル。切り上げ)
    assert get_store().jev_usage(jst_day(time.time())) == (2, 383 + 126)


def test_questions_contain_no_browser_text_except_service_ids(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream
) -> None:
    enable(monkeypatch)
    body = request_body()
    body["feed"]["agency"] = f"事業者{MARK}"
    for service in body["services"]:
        service["routes"] = [{"name": f"系統{MARK}", "trips": 1}]
        service["headsigns"] = [f"行き先{MARK}"]
    assert post(client, body).status_code == 200
    for sent in upstream.bodies():
        assert MARK not in json.dumps(sent["questions"], ensure_ascii=False)
        assert MARK in json.dumps(sent["state"], ensure_ascii=False)


def test_names_are_only_length_checked(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    # 系統名・行き先・事業者名は State の値にだけ入る。空や改行を含む名前でも全体を断らない
    enable(monkeypatch)
    body = request_body()
    body["feed"]["agency"] = ""
    body["services"][0]["routes"][0]["name"] = ""
    body["services"][0]["headsigns"][0] = "行き先\t(経由)\n"
    assert post(client, body).status_code == 200


def test_state_shape_and_running_dates(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    body = request_body()
    service = body["services"][1]
    service["runningDates"] = ["20261102", "20261103"]
    service["routes"] = [{"name": "同じ名前", "trips": 2}, {"name": "同じ名前", "trips": 3}]
    service["firstDeparture"] = "25:10"
    service["lastArrival"] = None
    body["feed"]["agency"] = None
    body["targets"] = [{"serviceId": "S000014", "role": "weekday", "candidates": []}]
    assert post(client, body).status_code == 200
    state = upstream.bodies()[0]["state"]
    assert "agency" not in state["feed"]
    assert state["feed"]["period"] == "2026-10-01 to 2027-03-31"
    assert state["feed"]["days_in_period"] == {"weekday": "122", "saturday": "26", "sunday_or_holiday": "34"}
    target = state["target"]
    assert target["running_dates"] == ["2026-11-02", "2026-11-03"]
    assert target["routes_with_trip_counts"] == {"同じ名前": "5"}
    assert target["first_departure"] == "25:10"
    assert "last_arrival" not in target
    assert target["coverage"] == {"weekday": "0.84", "saturday": "0.00", "sunday_or_holiday": "0.00"}


def test_fixtures_match_models() -> None:
    request = service_groups.JevJudgeRequest.model_validate(load_fixture("jev_judge_request.json"))
    assert service_groups._reference_problem(request) is None
    response = service_groups.JevJudgeResponse.model_validate(load_fixture("jev_judge_response.json"))
    # 固定のデータの sent は、今のサーバーが組み立てる State・質問と同じ
    for result in response.results:
        target = next(t for t in request.targets if t.serviceId == result.serviceId and t.role == result.role)
        assert result.sent.state == service_groups.build_state(request, target)
        assert result.sent.questions == service_groups.build_questions(target)


@pytest.mark.parametrize(
    ("provider", "expected"),
    [("digitalocean", "digitalocean"), (None, None), ("bad provider<script>", None), (123, None)],
)
def test_provider_is_returned_when_it_looks_like_a_name(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, provider: Any, expected: str | None
) -> None:
    enable(monkeypatch)

    def respond(sent: dict[str, Any], attempt: int) -> httpx2.Response:
        answers, confidence = good_answers(sent)
        return httpx2.Response(200, json=jev_body(answers, confidence, provider=provider))

    upstream.respond = respond  # type: ignore[method-assign]
    body = post(client, request_body()).json()
    assert [result["provider"] for result in body["results"]] == [expected, expected]


def test_cost_unknown_gives_null_cost(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)

    def respond(sent: dict[str, Any], attempt: int) -> httpx2.Response:
        answers, confidence = good_answers(sent)
        return httpx2.Response(200, json=jev_body(answers, confidence, cost=None, tokens=7))

    upstream.respond = respond  # type: ignore[method-assign]
    body = post(client, request_body()).json()
    assert body["usage"] == {"inputTokens": 14, "costUsd": None}
    # cost の無い応答でも、1日の額には送る前に見込んだ額が残る(上限が数だけにならないため)
    targets, cost = get_store().jev_usage(jst_day(time.time()))
    assert targets == 2
    assert cost >= 2 * service_groups.ESTIMATE_MIN_MICROUSD


# ---- 4. 入力の形 ----


def _mutations() -> list[tuple[str, Any]]:
    def unknown_top(body: dict[str, Any]) -> None:
        body[f"extra{MARK}"] = 1

    def unknown_service(body: dict[str, Any]) -> None:
        body["services"][0][f"x{MARK}"] = MARK

    def questions(body: dict[str, Any]) -> None:
        body["questions"] = {"q": {"type": "boolean", "instructions": MARK}}

    def too_many_services(body: dict[str, Any]) -> None:
        base = body["services"][0]
        body["services"] = [{**copy.deepcopy(base), "serviceId": f"S{i}{MARK}"} for i in range(61)]

    def too_many_targets(body: dict[str, Any]) -> None:
        base = body["services"][1]
        body["services"] = [{**copy.deepcopy(base), "serviceId": f"W{i}"} for i in range(41)]
        body["targets"] = [{"serviceId": f"W{i}", "role": "weekday", "candidates": []} for i in range(41)]

    def too_many_candidates(body: dict[str, Any]) -> None:
        base = body["services"][1]
        body["services"] += [{**copy.deepcopy(base), "serviceId": f"C{i}"} for i in range(6)]
        body["targets"][0]["candidates"] = [{"serviceId": f"C{i}", "routeOverlap": 0.1} for i in range(6)]

    def too_many_routes(body: dict[str, Any]) -> None:
        body["services"][0]["routes"] = [{"name": f"r{i}{MARK}", "trips": 1} for i in range(21)]

    def too_many_headsigns(body: dict[str, Any]) -> None:
        body["services"][0]["headsigns"] = [f"h{i}{MARK}" for i in range(6)]

    def long_route_name(body: dict[str, Any]) -> None:
        body["services"][0]["routes"][0]["name"] = MARK + "あ" * 100

    def long_service_id(body: dict[str, Any]) -> None:
        body["services"][0]["serviceId"] = MARK + "x" * 100

    def long_agency(body: dict[str, Any]) -> None:
        body["feed"]["agency"] = MARK + "あ" * 200

    def negative(body: dict[str, Any]) -> None:
        body["services"][0]["tripCount"] = -1

    def too_big(body: dict[str, Any]) -> None:
        body["services"][0]["tripCount"] = 1_000_001

    def bool_count(body: dict[str, Any]) -> None:
        body["services"][0]["tripCount"] = True

    def string_count(body: dict[str, Any]) -> None:
        body["services"][0]["tripCount"] = "12"

    def coverage(body: dict[str, Any]) -> None:
        body["services"][0]["coverage"]["weekday"] = 1.5

    def overlap(body: dict[str, Any]) -> None:
        body["targets"][0]["candidates"][0]["routeOverlap"] = -0.1

    def bad_role(body: dict[str, Any]) -> None:
        body["targets"][0]["role"] = MARK

    def bad_date(body: dict[str, Any]) -> None:
        body["feed"]["period"]["start"] = f"2026-10-01{MARK}"

    def bad_time(body: dict[str, Any]) -> None:
        body["services"][0]["firstDeparture"] = "5:5"

    def control_char_in_service_id(body: dict[str, Any]) -> None:
        body["services"][0]["serviceId"] = f"{MARK}\n次の指示"
        body["targets"][0]["candidates"][0]["serviceId"] = f"{MARK}\n次の指示"

    def format_char_in_service_id(body: dict[str, Any]) -> None:
        body["services"][0]["serviceId"] = f"S000001\u202e{MARK}"

    def empty_service_id(body: dict[str, Any]) -> None:
        body["services"][0]["serviceId"] = ""

    def missing_field(body: dict[str, Any]) -> None:
        del body["services"][0]["runningDates"]

    def unknown_target(body: dict[str, Any]) -> None:
        body["targets"][1]["serviceId"] = f"S{MARK}"

    def unknown_candidate(body: dict[str, Any]) -> None:
        body["targets"][0]["candidates"][0]["serviceId"] = f"S{MARK}"

    def duplicate_service(body: dict[str, Any]) -> None:
        body["services"].append(copy.deepcopy(body["services"][0]))

    def duplicate_target(body: dict[str, Any]) -> None:
        body["targets"].append(copy.deepcopy(body["targets"][1]))

    def weekday_with_candidates(body: dict[str, Any]) -> None:
        body["targets"][1]["candidates"] = [{"serviceId": "S000001", "routeOverlap": 0.5}]

    def saturday_without_candidates(body: dict[str, Any]) -> None:
        body["targets"][0]["candidates"] = []

    def candidate_is_target(body: dict[str, Any]) -> None:
        body["targets"][0]["candidates"][0]["serviceId"] = "S000027"

    def candidate_named_none(body: dict[str, Any]) -> None:
        body["services"][0]["serviceId"] = "none"
        body["targets"][0]["candidates"][0]["serviceId"] = "none"

    def duplicate_candidate(body: dict[str, Any]) -> None:
        body["targets"][0]["candidates"][1]["serviceId"] = "S000001"

    def no_targets(body: dict[str, Any]) -> None:
        body["targets"] = []

    return [(fn.__name__, fn) for fn in locals().values() if callable(fn)]


@pytest.mark.parametrize(("name", "mutate"), _mutations())
def test_bad_shape_is_422_without_echo(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, name: str, mutate: Any
) -> None:
    enable(monkeypatch)
    body = request_body()
    mutate(body)
    response = post(client, body)
    assert response.status_code == 422, (name, response.text)
    detail = response.json()["detail"]
    assert isinstance(detail, str) and detail.startswith("判断材料の形が正しくありません")
    assert MARK not in response.text
    assert "次の指示" not in response.text
    assert upstream.requests == []


@pytest.mark.parametrize("raw", [b"{", b"[]", b"null", b'"x"'])
def test_not_an_object_is_422(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, raw: bytes) -> None:
    enable(monkeypatch)
    response = client.post(
        "/api/service-groups/judge", content=raw, headers={"content-type": "application/json"}
    )
    assert response.status_code == 422
    assert upstream.requests == []


def test_body_over_256kb_is_413(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    body = request_body()
    body["pad"] = "x" * (256 * 1024)
    response = post(client, body)
    assert response.status_code == 413
    assert response.json()["detail"] == "判断材料が大きすぎます"
    assert upstream.requests == []


def test_bad_request_does_not_count_against_ip_limit(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream
) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_JEV_PER_IP_HOUR", "1")
    for _ in range(3):
        assert post(client, {"feed": {}}).status_code == 422
    assert post(client, request_body()).status_code == 200


def test_bad_real_ip_is_400(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_TRUST_PROXY", "1")
    assert post(client, request_body(), **{"X-Real-IP": "not-an-ip"}).status_code == 400
    assert post(client, request_body(), **{"X-Real-IP": "203.0.113.5"}).status_code == 200


# ---- 5. 回数制限と1日の上限 ----


def test_ip_hour_limit(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_JEV_PER_IP_HOUR", "2")
    assert post(client, request_body()).status_code == 200
    assert post(client, request_body()).status_code == 200
    response = post(client, request_body())
    assert response.status_code == 429
    assert "1 時間あたり" in response.json()["detail"]
    assert len(upstream.requests) == 4


def test_ip_day_limit_and_trust_proxy(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_TRUST_PROXY", "1")
    monkeypatch.setenv("DISPATCHER_JEV_PER_IP_DAY", "1")
    assert post(client, request_body(), **{"X-Real-IP": "203.0.113.5"}).status_code == 200
    response = post(client, request_body(), **{"X-Real-IP": "203.0.113.5"})
    assert response.status_code == 429
    assert "1 日あたり" in response.json()["detail"]
    # 別の接続元は数えが別
    assert post(client, request_body(), **{"X-Real-IP": "203.0.113.6"}).status_code == 200


def test_daily_target_limit_marks_budget_and_survives_restart(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream
) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_JEV_TARGETS_PER_DAY", "1")
    monkeypatch.setattr(service_groups, "CONCURRENCY", 1)
    body = post(client, request_body()).json()
    assert [result["serviceId"] for result in body["results"]] == ["S000027"]
    assert body["failures"] == [{"serviceId": "S000014", "role": "weekday", "error": "budget"}]
    assert len(upstream.requests) == 1

    # アプリを作り直しても(同じ SQLite)、上限は続く
    store.reset_stores()
    restarted = TestClient(app)
    assert restarted.get("/api/service-groups").json()["reason"] == "dailyLimit"
    response = post(restarted, request_body())
    assert response.status_code == 429
    assert "1日の上限" in response.json()["detail"]
    assert len(upstream.requests) == 1


def test_daily_cost_limit(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_JEV_COST_CENTS_PER_DAY", "1")  # 1 セント = 10,000 マイクロドル
    monkeypatch.setattr(service_groups, "CONCURRENCY", 1)

    def respond(sent: dict[str, Any], attempt: int) -> httpx2.Response:
        answers, confidence = good_answers(sent)
        return httpx2.Response(200, json=jev_body(answers, confidence, cost="0.02"))

    upstream.respond = respond  # type: ignore[method-assign]
    body = post(client, request_body()).json()
    assert len(body["results"]) == 1
    assert [failure["error"] for failure in body["failures"]] == ["budget"]
    assert body["usage"]["costUsd"] == pytest.approx(0.02)
    store.reset_stores()
    assert client.get("/api/service-groups").json()["reason"] == "dailyLimit"


def test_zero_daily_limit_disables(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_JEV_TARGETS_PER_DAY", "0")
    assert client.get("/api/service-groups").json() == {
        "available": False,
        "provider": "TypeSafe AI Jev",
        "via": "Vercel AI Gateway",
        "reason": "dailyLimit",
    }
    assert post(client, request_body()).status_code == 429
    assert upstream.requests == []


# ---- 6. 送り直しと待ち時間 ----


def _statuses(upstream: Upstream, statuses: list[int]) -> None:
    def respond(sent: dict[str, Any], attempt: int) -> httpx2.Response:
        status = statuses[min(attempt, len(statuses)) - 1]
        if status != 200:
            return httpx2.Response(status, text=f"error for {sent['state']['target']['service_id']} {MARK}")
        answers, confidence = good_answers(sent)
        return httpx2.Response(200, json=jev_body(answers, confidence))

    upstream.respond = respond  # type: ignore[method-assign]


def _single_target(body: dict[str, Any]) -> dict[str, Any]:
    body["targets"] = [body["targets"][1]]
    return body


@pytest.mark.parametrize(
    ("statuses", "calls", "error"),
    [
        ([503, 503, 200], 3, None),
        ([429, 200], 2, None),
        ([429, 429, 429, 200], 3, "rate_limited"),
        ([503, 503, 503, 200], 3, "upstream"),
        ([500, 200], 1, "upstream"),
        ([401, 200], 1, "upstream"),
        ([403, 200], 1, "upstream"),
    ],
)
def test_retries(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
    upstream: Upstream,
    sleeps: list[float],
    statuses: list[int],
    calls: int,
    error: str | None,
) -> None:
    enable(monkeypatch)
    _statuses(upstream, statuses)
    body = post(client, _single_target(request_body())).json()
    assert len(upstream.requests) == calls
    # 送り直しても、送り先は Vercel の口だけ
    assert {str(request.url) for request in upstream.requests} == {URL}
    assert sleeps == list(service_groups.RETRY_DELAYS[: calls - 1])
    if error is None:
        assert len(body["results"]) == 1 and body["failures"] == []
    else:
        assert body["results"] == []
        assert sent_failures(body, upstream) == [{"serviceId": "S000014", "role": "weekday", "error": error}]
    assert MARK not in json.dumps(body)


def test_request_timeout(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    monkeypatch.setattr(service_groups, "REQUEST_TIMEOUT_SECONDS", 0.05)

    async def slow(sent: dict[str, Any], attempt: int) -> httpx2.Response:
        await asyncio.sleep(1)
        return httpx2.Response(200, json={})

    upstream.respond = slow  # type: ignore[method-assign]
    body = post(client, request_body()).json()
    assert body["results"] == []
    assert sorted(failure["error"] for failure in body["failures"]) == ["timeout", "timeout"]


def test_transport_timeout_and_connect_error(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)

    def broken(sent: dict[str, Any], attempt: int) -> httpx2.Response:
        if sent["state"]["target"]["service_id"] == "S000027":
            raise httpx2.ReadTimeout("slow")
        raise httpx2.ConnectError("refused")

    upstream.respond = broken  # type: ignore[method-assign]
    body = post(client, request_body()).json()
    assert sent_failures(body, upstream) == [
        {"serviceId": "S000027", "role": "saturday", "error": "timeout"},
        {"serviceId": "S000014", "role": "weekday", "error": "upstream"},
    ]


def test_total_timeout_keeps_answers_that_arrived(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream
) -> None:
    enable(monkeypatch)
    monkeypatch.setattr(service_groups, "TOTAL_TIMEOUT_SECONDS", 0.2)

    async def partly_slow(sent: dict[str, Any], attempt: int) -> httpx2.Response:
        if sent["state"]["target"]["service_id"] == "S000027":
            await asyncio.sleep(2)
        answers, confidence = good_answers(sent)
        return httpx2.Response(200, json=jev_body(answers, confidence))

    upstream.respond = partly_slow  # type: ignore[method-assign]
    body = post(client, request_body()).json()
    assert [result["serviceId"] for result in body["results"]] == ["S000014"]
    assert sent_failures(body, upstream) == [{"serviceId": "S000027", "role": "saturday", "error": "timeout"}]


# ---- 7. 答えの確かめ ----


def _weekday_answer() -> dict[str, Any]:
    return copy.deepcopy(FIXTURE_ANSWERS["S000014"][0])


def _bad_answers() -> list[tuple[str, Any]]:
    def missing_name(a: dict[str, Any]) -> None:
        del a["is_school_service"]

    def wrong_type(a: dict[str, Any]) -> None:
        a["service_kind"]["type"] = "boolean"

    def choice_not_in_criteria(a: dict[str, Any]) -> None:
        a["service_kind"]["choice"] = "weekday"

    def probability_out_of_range(a: dict[str, Any]) -> None:
        a["is_school_service"]["probability"] = 1.2

    def probability_bool(a: dict[str, Any]) -> None:
        a["is_school_service"]["probability"] = True

    def sum_off(a: dict[str, Any]) -> None:
        a["service_kind"]["probabilities"]["regular_weekday"] = 0.6

    def probability_key_missing(a: dict[str, Any]) -> None:
        del a["service_kind"]["probabilities"]["specific_dates"]

    def probability_key_extra(a: dict[str, Any]) -> None:
        a["service_kind"]["probabilities"]["other"] = 0.0

    def answer_not_object(a: dict[str, Any]) -> None:
        a["service_kind"] = "regular_weekday"

    return [(fn.__name__, fn) for fn in locals().values() if callable(fn)]


@pytest.mark.parametrize(("name", "mutate"), _bad_answers())
def test_invalid_answers(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, name: str, mutate: Any
) -> None:
    enable(monkeypatch)
    answers = _weekday_answer()
    mutate(answers)
    upstream.respond = lambda sent, attempt: httpx2.Response(200, json=jev_body(answers))  # type: ignore[method-assign]
    body = post(client, _single_target(request_body())).json()
    assert body["results"] == [], name
    assert sent_failures(body, upstream) == [{"serviceId": "S000014", "role": "weekday", "error": "invalid_answer"}]


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(200, text="not json"),
        httpx2.Response(200, json=[]),
        httpx2.Response(200, json={"answers": []}),
        httpx2.Response(200, json=jev_body(FIXTURE_ANSWERS["S000014"][0], {"service_kind": 1.5})),
        httpx2.Response(
            200,
            json={**jev_body(FIXTURE_ANSWERS["S000014"][0]), "providerMetadata": {"typesafe": {"confidence": []}}},
        ),
    ],
)
def test_invalid_answer_bodies(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, response: httpx2.Response
) -> None:
    enable(monkeypatch)
    upstream.respond = lambda sent, attempt: response  # type: ignore[method-assign]
    body = post(client, _single_target(request_body())).json()
    assert sent_failures(body, upstream) == [{"serviceId": "S000014", "role": "weekday", "error": "invalid_answer"}]


def test_counterpart_choice_must_be_a_candidate(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream
) -> None:
    enable(monkeypatch)
    answers = {
        "weekday_counterpart": {
            "type": "choice",
            "choice": "S000099",
            "probabilities": {"S000001": 0.5, "S000014": 0.25, "none": 0.25},
        }
    }
    upstream.respond = lambda sent, attempt: httpx2.Response(200, json=jev_body(answers))  # type: ignore[method-assign]
    body = request_body()
    body["targets"] = [body["targets"][0]]
    result = post(client, body).json()
    assert sent_failures(result, upstream) == [{"serviceId": "S000027", "role": "saturday", "error": "invalid_answer"}]


def test_none_choice_and_missing_confidence(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)
    answers = {
        "weekday_counterpart": {
            "type": "choice",
            "choice": "none",
            "probabilities": {"S000001": 0.3, "S000014": 0.0, "none": 0.71},
        },
        "extra_question": {"type": "boolean", "probability": 0.5},
    }
    upstream.respond = lambda sent, attempt: httpx2.Response(200, json={**jev_body(answers), "stats": {"x": 1}})  # type: ignore[method-assign]
    body = request_body()
    body["targets"] = [body["targets"][0]]
    result = post(client, body).json()
    assert result["results"][0]["weekdayCounterpart"] == {
        "choice": "none",
        "probabilities": {"S000001": 0.3, "S000014": 0.0, "none": 0.71},
        "confidence": None,
    }
    assert set(result["results"][0]) == {"serviceId", "role", "provider", "sent", "weekdayCounterpart"}


# ---- 8. ログ ----


def test_logs_have_no_contents(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    enable(monkeypatch)
    # 正常
    assert post(client, request_body()).status_code == 200
    # 422(送られた値に印)
    bad = request_body()
    bad["services"][0]["serviceId"] = MARK + "x" * 200
    assert post(client, bad).status_code == 422
    # 上流の 500(本文に service_id と印)
    _statuses(upstream, [500])
    assert post(client, request_body()).status_code == 200

    text = caplog.text + "\n".join(str(record.args) for record in caplog.records)
    assert "jev 判定しました" in text
    assert "jev 要求を断りました status=422" in text
    fixture = load_fixture("jev_judge_request.json")
    forbidden = [KEY, MARK, "Bearer", fixture["feed"]["agency"], "testclient"]
    for service in fixture["services"]:
        forbidden.append(service["serviceId"])
        forbidden += [route["name"] for route in service["routes"]]
        forbidden += service["headsigns"]
    for word in forbidden:
        assert word not in text, word
    for name in ("httpx2", "httpcore2", "httpx", "httpcore"):
        assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING


def test_settings_defaults() -> None:
    assert settings.jev_api_key() is None
    assert settings.jev_model() == "typesafe-ai/jev"
    assert settings.jev_requests_per_ip_hour() == 6
    assert settings.jev_requests_per_ip_day() == 20
    assert settings.jev_targets_per_day() == 2000
    assert settings.jev_cost_cents_per_day() == 100


# ---- 10. レビューの指摘への対応(送り先・額・入力の形) ----


def test_client_ignores_environment_and_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    # HTTPS_PROXY・SSL_CERT_FILE・.netrc などの環境変数を読まない(キーを付けた要求の通り道を環境で変えさせない)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setenv("ALL_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setattr(service_groups, "transport", None)
    client = service_groups.new_client()
    try:
        assert client.trust_env is False
        assert client.follow_redirects is False
        # 本物の通信(transport が None)でも、環境のプロキシに向かう取っ手が無い(trust_env=True なら HTTPS_PROXY の分が入る)
        assert client._mounts == {}
    finally:
        asyncio.run(client.aclose())


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_redirect_is_not_followed(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, status: int
) -> None:
    enable(monkeypatch)
    upstream.respond = lambda sent, attempt: httpx2.Response(status, headers={"Location": "https://evil.example/"})  # type: ignore[method-assign]
    response = post(client, _single_target(request_body()))
    assert response.status_code == 200
    assert KEY not in response.text
    assert [str(request.url) for request in upstream.requests] == [URL]
    assert sent_failures(response.json(), upstream) == [{"serviceId": "S000014", "role": "weekday", "error": "upstream"}]


def test_failed_after_sending_keeps_the_estimated_cost(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream
) -> None:
    enable(monkeypatch)
    _statuses(upstream, [500])
    body = post(client, _single_target(request_body())).json()
    assert body["usage"]["costUsd"] is None
    sent = json.dumps(upstream.bodies()[0], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert get_store().jev_usage(jst_day(time.time())) == (1, service_groups.estimate_microusd(sent))


def test_estimate_grows_with_the_body() -> None:
    assert service_groups.estimate_microusd(b"x") == service_groups.ESTIMATE_MIN_MICROUSD
    assert service_groups.estimate_microusd(b"x" * 100_000) == 2_000


def test_huge_cost_is_ignored(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)

    def respond(sent: dict[str, Any], attempt: int) -> httpx2.Response:
        answers, confidence = good_answers(sent)
        return httpx2.Response(200, json=jev_body(answers, confidence, cost="1e30"))

    upstream.respond = respond  # type: ignore[method-assign]
    body = post(client, _single_target(request_body())).json()
    # 答えは使い、額は読み違いとみなして見込みの額のまま
    assert len(body["results"]) == 1
    assert body["usage"]["costUsd"] is None
    targets, cost = get_store().jev_usage(jst_day(time.time()))
    assert targets == 1 and cost < service_groups.MAX_COST_MICROUSD_PER_TARGET


@pytest.mark.parametrize("model", ["openai/gpt-5", "typesafe-ai/jev\r\nX-Evil: 1", "", "typesafe-ai/" + "x" * 80])
def test_model_setting_must_be_a_typesafe_model(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, model: str
) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_JEV_MODEL", model)
    assert post(client, _single_target(request_body())).status_code == 200
    assert [request.headers["ai-model-id"] for request in upstream.requests] == ["typesafe-ai/jev"]


def test_model_setting_accepts_another_typesafe_model(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream
) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_JEV_MODEL", "typesafe-ai/jev-2")
    assert post(client, _single_target(request_body())).status_code == 200
    assert upstream.requests[0].headers["ai-model-id"] == "typesafe-ai/jev-2"


@pytest.mark.parametrize("where", ["service_id", "route_name", "headsign", "agency"])
def test_lone_surrogate_is_422(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream, where: str) -> None:
    enable(monkeypatch)
    body = request_body()
    lone = "\ud800"
    if where == "service_id":
        body["services"][0]["serviceId"] = "S" + lone
    elif where == "route_name":
        body["services"][0]["routes"][0]["name"] = "系統" + lone
    elif where == "headsign":
        body["services"][0]["headsigns"] = ["行き先" + lone]
    else:
        body["feed"]["agency"] = "事業者" + lone
    # ensure_ascii の JSON は \ud800 を文字のまま送れる(UTF-8 にはできない)
    raw = json.dumps(body).encode("ascii")
    response = client.post("/api/service-groups/judge", content=raw, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert upstream.requests == []


def test_chunked_body_over_256kb_is_413(monkeypatch: pytest.MonkeyPatch, client: TestClient, upstream: Upstream) -> None:
    enable(monkeypatch)

    def chunks() -> Any:
        yield b'{"pad": "'
        for _ in range(300):
            yield b"x" * 1024
        yield b'"}'

    response = client.post("/api/service-groups/judge", content=chunks(), headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["detail"] == "判断材料が大きすぎます"
    assert upstream.requests == []
