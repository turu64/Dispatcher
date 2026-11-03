"""SQLite の表(store.py)と回数制限(ratelimit.py)のテスト。docs/interfaces-1105.md §4.10・§4.11・§3.2。"""

import time
from datetime import datetime

import pytest

from dispatcher_server.ratelimit import JST, RateLimiter, jst_day
from dispatcher_server.store import get_store


def test_tables_have_no_columns_for_conversation_or_ip() -> None:
    store = get_store()
    columns = {row["name"] for row in store._all("PRAGMA table_info(agent_sessions)")}
    assert columns == {
        "row_id", "session_id", "agent_version", "created_at", "last_activity_at", "ended_at", "deleted_at",
        "delete_pending", "delete_attempts", "cost_cents", "messages", "tool_calls",
    }


def test_sessions_are_counted_by_jst_day() -> None:
    store = get_store()
    # 日本時間 11/5 の 0:30 は UTC では 11/4 の 15:30
    just_after_midnight = datetime(2026, 11, 5, 0, 30, tzinfo=JST).timestamp()
    store.insert_session("a", "sesn_a", 1, just_after_midnight)
    store.insert_session("b", "sesn_b", 1, just_after_midnight - 3600)  # 11/4 の 23:30
    assert store.sessions_created_on("2026-11-05") == 1
    assert store.sessions_created_on("2026-11-04") == 1


def test_record_cost_adds_only_the_increase_to_the_jst_day() -> None:
    store = get_store()
    now = time.time()
    store.insert_session("a", "sesn_a", 1, now)
    assert store.record_cost("a", 10, now) == 10
    assert store.record_cost("a", 10, now) == 0
    assert store.record_cost("a", 7, now) == 0  # 下がった値では戻さない
    assert store.record_cost("a", 25, now) == 15
    assert store.ledger_cents(jst_day(now)) == 25
    assert store.record_cost("missing", 99, now) == 0


def test_reserved_cents_counts_rows_that_are_not_deleted() -> None:
    store = get_store()
    now = time.time()
    store.insert_session("a", "sesn_a", 1, now)
    store.insert_session("b", "sesn_b", 1, now)
    store.insert_session("c", "sesn_c", 1, now)
    store.record_cost("a", 100, now)
    store.record_cost("b", 400, now)  # 予算を超えた分は 0 として数える
    store.mark_deleted("c", now)
    assert store.reserved_cents(300) == 200


def test_research_results_are_not_overwritten_while_valid_or_from_demo() -> None:
    store = get_store()
    now = time.time()
    common = {"kind": "school", "name": "旭川東高校", "status": "found", "facts": [{"label": "始業", "value": "8:40", "source": 1}], "sources": [{"url": "https://example.jp", "title": "学校"}], "note": ""}
    saved, existing = store.save_research_result(target_id="P29:1", now=now, cache_days=7, **common)
    assert saved and existing is None
    saved, existing = store.save_research_result(target_id="P29:1", now=now + 86400, cache_days=7, **{**common, "note": "上書き"})
    assert not saved and existing is not None and existing["note"] == ""
    # 期限が切れた web の行は置き換わる
    saved, _ = store.save_research_result(target_id="P29:1", now=now + 8 * 86400, cache_days=7, **{**common, "note": "新しい"})
    assert saved and store.get_research_result("P29:1")["note"] == "新しい"
    # demo の行は期限が無く、上書きしない
    store.save_research_result(target_id="P04:9", now=now, cache_days=7, origin="demo", **common)
    saved, existing = store.save_research_result(target_id="P04:9", now=now + 100 * 86400, cache_days=7, **common)
    assert not saved and existing["origin"] == "demo"


def test_purge_removes_rows_two_days_after_delete_and_expired_web_results() -> None:
    store = get_store()
    now = time.time()
    store.insert_session("old", "sesn_old", 1, now - 5 * 86400)
    store.mark_deleted("old", now - 3 * 86400)
    store.insert_session("recent", "sesn_recent", 1, now - 86400)
    store.mark_deleted("recent", now - 86400)
    common = {"kind": "k", "name": "n", "status": "found", "facts": [], "sources": [], "note": ""}
    store.save_research_result(target_id="web", now=now - 10 * 86400, cache_days=7, **common)
    store.save_research_result(target_id="demo", now=now - 10 * 86400, cache_days=7, origin="demo", **common)
    assert store.purge(now) == (1, 1)
    assert store.get_session("old") is None and store.get_session("recent") is not None
    assert store.get_research_result("web") is None and store.get_research_result("demo") is not None


def test_ratelimiter_hour_window_and_jst_day() -> None:
    clock = [datetime(2026, 11, 5, 22, 0, tzinfo=JST).timestamp()]
    limiter = RateLimiter(clock=lambda: clock[0])
    for _ in range(3):
        assert limiter.check("session", "a", per_hour=3, per_day=5) is None
        limiter.record("session", "a")
    assert limiter.check("session", "a", per_hour=3, per_day=5) == "hour"
    assert limiter.check("session", "b", per_hour=3, per_day=5) is None  # 接続元ごと
    assert limiter.check("message", "a", per_hour=3) is None  # 種類ごと
    clock[0] += 3601
    for _ in range(2):
        assert limiter.check("session", "a", per_hour=3, per_day=5) is None
        limiter.record("session", "a")
    assert limiter.check("session", "a", per_hour=3, per_day=5) == "day"
    # 日本時間の翌日(0:30)には 1 日の数え上げが戻る
    clock[0] = datetime(2026, 11, 6, 0, 30, tzinfo=JST).timestamp()
    assert limiter.check("session", "a", per_hour=3, per_day=5) is None


@pytest.mark.parametrize("value", ["-1", "abc", ""])
def test_invalid_numbers_fall_back_to_defaults(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    from dispatcher_server import settings

    monkeypatch.setenv("DISPATCHER_SESSIONS_PER_IP_HOUR", value)
    monkeypatch.setenv("DISPATCHER_SESSION_BUDGET_CENTS", value)
    assert settings.sessions_per_ip_hour() == 3
    assert settings.session_budget_cents() == 300
