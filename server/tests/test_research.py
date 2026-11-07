"""前提情報の調査(サーバーの側)のテスト。docs/interfaces-1105.md §3.2・§4.2、docs/tasks-1103.md の T07。

参照データはテスト用のフィクスチャ(tests/fixtures/research_ref)。T06 の実データが無くても通る。
SDK のクライアントは偽物(tests/fake_anthropic.py)。本物の API は呼ばない。
"""

import asyncio
import json
import logging
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import anthropic
import httpx2
import pytest
from fake_anthropic import RUN_THREAD, FakeAnthropic, FakeStream, tool_use
from fastapi.testclient import TestClient

from dispatcher_server import agent_session, research
from dispatcher_server.app import app
from dispatcher_server.store import get_store, iso

FIXTURE_REF = Path(__file__).parent / "fixtures" / "research_ref"

API_KEY = "sk-ant-test-0123456789-secret"
TOKEN = "test-token-0123456789"
SECRET = "test-session-secret-0123456789abcdef"

SCHOOL = "P29:01234567890A"
HOSPITAL = "P04:0123456789ab"
CLINIC = "P04:ba9876543210"
OPERATOR = "P11:テストバス"
NORTH = "P29:98765432109B"

ROW = "row_test"
NOW = 1_793_700_000.0  # 2026-11-03 頃
DAY = 86400.0


# ---- 道具 ----


@pytest.fixture(autouse=True)
def ref_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    directory = tmp_path / "ref"
    shutil.copytree(FIXTURE_REF, directory)
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(directory))
    research.reset_cache()
    yield directory
    research.reset_cache()


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeAnthropic:
    instance = FakeAnthropic()
    monkeypatch.setattr(agent_session, "get_client", lambda: instance)
    return instance


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def enable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY)
    monkeypatch.setenv("DISPATCHER_AGENT_ID", "agent_test_coordinator")
    monkeypatch.setenv("DISPATCHER_AGENT_VERSION", "1")
    monkeypatch.setenv("DISPATCHER_ENVIRONMENT_ID", "env_test_dispatcher")
    monkeypatch.setenv("DISPATCHER_SESSION_SECRET", SECRET)
    monkeypatch.setenv("DISPATCHER_TOKEN", TOKEN)


def headers(handle: str | None = None) -> dict[str, str]:
    result = {"X-Dispatcher-Token": TOKEN}
    if handle is not None:
        result["X-Dispatcher-Session"] = handle
    return result


def create(client: TestClient) -> str:
    response = client.post("/api/claude/session", json={}, headers=headers())
    assert response.status_code == 200, response.text
    return response.json()["handle"]


def row_id_of(handle: str) -> str:
    return handle.split(".")[1]


def run(name: str, tool_input: Any, now: float = NOW, row: str = ROW) -> tuple[dict[str, Any], bool]:
    text, is_error = research.run_tool(name, row, tool_input, now=now)
    return json.loads(text), is_error


def record(target_id: str = SCHOOL, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "target_id": target_id,
        "status": "found",
        "facts": [
            {"label": "始業時刻", "value": "8時40分", "source": 1},
            {"label": "長期休業", "value": "夏季休業 7月25日〜8月17日", "source": 2},
        ],
        "sources": [
            {"url": "https://example.ed.jp/school/", "title": "学校の案内"},
            {"url": "http://example.ed.jp/calendar.html", "title": "年間行事"},
        ],
        "note": "",
    }
    base.update(overrides)
    return base


def tool_text(event: dict[str, Any]) -> dict[str, Any]:
    return json.loads(event["content"][0]["text"])


def parse_sse(text: str) -> list[tuple[str, dict[str, Any]]]:
    frames = []
    for block in text.split("\n\n"):
        lines = [line for line in block.split("\n") if line and not line.startswith(":")]
        if not lines:
            continue
        event = next(line[len("event: ") :] for line in lines if line.startswith("event: "))
        data = next(line[len("data: ") :] for line in lines if line.startswith("data: "))
        frames.append((event, json.loads(data)))
    return frames


# ---- 参照データ ----


def test_load_targets_reads_facilities_from_the_ref_dir(ref_dir: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING)
    index = research.load_targets()
    assert sorted(index) == sorted([SCHOOL, HOSPITAL, CLINIC, OPERATOR, NORTH])
    assert index[SCHOOL].as_dict() == {
        "target_id": SCHOOL,
        "kind": "school",
        "name": "テスト第一高等学校",
        "municipality": "旭川市",
        "lat": 43.77,
        "lon": 142.36,
    }
    # 同じ target_id はファイル名の順で最初のもの(6542.json)
    assert index[OPERATOR].name == "テストバス" and index[OPERATOR].municipality is None
    # 形の合わない要素は数だけをログに残す(名前は書かない)
    assert "count=3" in caplog.text and "読み飛ばす" not in caplog.text


def test_load_targets_rereads_when_a_file_changes(ref_dir: Path) -> None:
    assert NORTH in research.load_targets()
    (ref_dir / "facilities" / "6642.json").unlink()
    index = research.load_targets()
    assert NORTH not in index and SCHOOL in index


def test_load_targets_also_reads_facilities_at_the_top_of_the_ref_dir(ref_dir: Path) -> None:
    (ref_dir / "facilities" / "6642.json").rename(ref_dir / "6642.json")
    research.reset_cache()
    index = research.load_targets()
    assert NORTH in index and SCHOOL in index
    # facilities/ を先に読むので、事業者は facilities/6542.json の位置
    assert index[OPERATOR].lat == 43.7


def test_load_targets_is_empty_without_ref_data(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(tmp_path / "none"))
    assert research.load_targets() == {}


# ---- get_research_targets ----


def test_targets_are_empty_before_the_user_starts() -> None:
    payload, is_error = run("get_research_targets", {})
    assert not is_error
    assert payload == {"status": "ok", "targets": [], "total": 0, "max_targets": 30}


def test_targets_use_server_data_and_show_cached_results() -> None:
    store = get_store()
    store.set_research_targets(ROW, [HOSPITAL, SCHOOL, OPERATOR])
    research.run_tool("save_research", ROW, record(SCHOOL), now=NOW - DAY)
    payload, is_error = run("get_research_targets", None)
    assert not is_error
    assert [target["target_id"] for target in payload["targets"]] == [HOSPITAL, SCHOOL, OPERATOR]
    hospital, school, operator = payload["targets"]
    assert hospital == {
        "target_id": HOSPITAL,
        "kind": "hospital",
        "name": "テスト総合病院",
        "municipality": "旭川市",
        "lat": 43.76,
        "lon": 142.37,
        "cached": None,
    }
    assert school["cached"] == {"status": "found", "checked_at": research.display_time(iso(NOW - DAY)), "facts": 2}
    assert school["cached"]["checked_at"].endswith("+09:00")
    assert operator["cached"] is None
    assert payload["total"] == 3 and payload["max_targets"] == 30


def test_expired_web_results_are_not_cached_even_before_the_sweep() -> None:
    get_store().set_research_targets(ROW, [SCHOOL])
    research.run_tool("save_research", ROW, record(SCHOOL), now=NOW - 8 * DAY)
    payload, _ = run("get_research_targets", {})
    assert payload["targets"][0]["cached"] is None
    results, _ = run("get_research_results", {"target_ids": None})
    assert results == {"status": "ok", "results": [], "missing": [SCHOOL]}


def test_targets_take_no_input() -> None:
    payload, is_error = run("get_research_targets", {"x": 1})
    assert is_error and payload["status"] == "error"


# ---- get_research_results ----


def test_results_for_null_list_and_missing() -> None:
    get_store().set_research_targets(ROW, [SCHOOL, HOSPITAL])
    research.run_tool("save_research", ROW, record(SCHOOL, note="公式の案内による"), now=NOW - 60)
    payload, is_error = run("get_research_results", {"target_ids": None})
    assert not is_error
    assert payload["missing"] == [HOSPITAL]
    (result,) = payload["results"]
    assert result == {
        "target_id": SCHOOL,
        "kind": "school",
        "name": "テスト第一高等学校",
        "status": "found",
        "facts": record()["facts"],
        "sources": record()["sources"],
        "note": "公式の案内による",
        "checked_at": research.display_time(iso(NOW - 60)),
        "origin": "web",
    }
    payload, _ = run("get_research_results", {"target_ids": [HOSPITAL, SCHOOL, HOSPITAL]})
    assert [item["target_id"] for item in payload["results"]] == [SCHOOL]
    assert payload["missing"] == [HOSPITAL]


@pytest.mark.parametrize(
    ("tool_input", "fragment"),
    [
        (None, "target_ids だけ"),
        ({}, "target_ids だけ"),
        ({"target_ids": None, "x": 1}, "target_ids だけ"),
        ({"target_ids": []}, "1〜50 件"),
        ({"target_ids": [f"P29:{n}" for n in range(51)]}, "1〜50 件"),
        ({"target_ids": "P29:1"}, "1〜50 件"),
        ({"target_ids": [1]}, "文字列"),
        ({"target_ids": [NORTH]}, "この会話の調査の対象ではない target_id があります:P29:98765432109B"),
    ],
)
def test_results_input_is_checked(tool_input: Any, fragment: str) -> None:
    get_store().set_research_targets(ROW, [SCHOOL])
    payload, is_error = run("get_research_results", tool_input)
    assert is_error and payload["status"] == "error"
    assert fragment in payload["message"]


# ---- save_research ----


def test_save_uses_server_names_and_returns_checked_at(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    get_store().set_research_targets(ROW, [SCHOOL])
    payload, is_error = run("save_research", record(SCHOOL))
    assert not is_error
    assert payload == {"status": "ok", "target_id": SCHOOL, "checked_at": research.display_time(iso(NOW))}
    row = get_store().get_research_result(SCHOOL)
    assert row is not None
    assert (row["kind"], row["name"], row["origin"]) == ("school", "テスト第一高等学校", "web")
    assert row["expires_at"] == iso(NOW + 7 * DAY)
    # ログには数だけ(target_id・名前・中身は書かない)
    assert "facts=2 sources=2" in caplog.text
    for secret in (SCHOOL, "テスト第一高等学校", "8時40分", "example.ed.jp"):
        assert secret not in caplog.text


def test_save_not_found_without_sources() -> None:
    get_store().set_research_targets(ROW, [CLINIC])
    payload, is_error = run("save_research", record(CLINIC, status="not_found", facts=[], sources=[], note="見つからなかった"))
    assert not is_error and payload["status"] == "ok"


def test_save_respects_the_cache_days_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPATCHER_RESEARCH_CACHE_DAYS", "3")
    get_store().set_research_targets(ROW, [SCHOOL])
    run("save_research", record(SCHOOL))
    assert get_store().get_research_result(SCHOOL)["expires_at"] == iso(NOW + 3 * DAY)


@pytest.mark.parametrize(
    ("tool_input", "fragment"),
    [
        ("文字列", "入力はオブジェクトにしてください"),
        ({k: v for k, v in record().items() if k != "note"}, "足りない項目があります:note"),
        ({**record(), "name": "ブラウザの名前"}, "知らない項目があります:name"),
        (record(status="done"), "status は found・partial・not_found"),
        (record(target_id=NORTH), "target_id がこの会話の調査の対象にありません"),
        (record(target_id=7), "target_id は文字列"),
        (record(facts=[{"label": "始業", "value": "8時", "source": 1}] * 13), "facts は 12 件まで"),
        (record(facts=[{"label": "始業", "value": "8時", "source": 3}]), "facts の 1 件目の source は sources の番号(1〜2)"),
        (record(facts=[{"label": "始業", "value": "8時", "source": 0}]), "source は sources の番号"),
        (record(facts=[{"label": "始業", "value": "8時", "source": True}]), "source は sources の番号"),
        (record(facts=[{"label": "始業", "value": "8時", "source": "1"}]), "source は sources の番号"),
        (record(facts=[{"label": "始業", "value": "8時"}]), "label・value・source だけ"),
        (record(facts=[{"label": "始業", "value": "8時", "source": 1, "x": 1}]), "label・value・source だけ"),
        (record(facts=[{"label": "あ" * 21, "value": "8時", "source": 1}]), "label は 20 字まで"),
        (record(facts=[{"label": "始業", "value": "あ" * 201, "source": 1}]), "value は 200 字まで"),
        (record(facts=[{"label": " ", "value": "8時", "source": 1}]), "label が空です"),
        (record(sources=[]), "sources は 1〜5 件"),
        (record(sources=[{"url": "https://example.jp/", "title": "t"}] * 6), "sources は 1〜5 件"),
        (record(status="not_found", facts=[], sources=[{"url": "https://example.jp/", "title": "t"}] * 6), "sources は 0〜5 件"),
        (record(sources=[{"url": "ftp://example.jp/a", "title": "t"}, {"url": "https://example.jp/", "title": "t"}]), "sources の 1 件目の url は http か https の URL(2,000 字まで)"),
        (record(sources=[{"url": "javascript:alert(1)", "title": "t"}, {"url": "https://example.jp/", "title": "t"}]), "url は http か https"),
        (record(sources=[{"url": "https://", "title": "t"}, {"url": "https://example.jp/", "title": "t"}]), "url は http か https"),
        (record(sources=[{"url": "https://example.jp/a b", "title": "t"}, {"url": "https://example.jp/", "title": "t"}]), "url は http か https"),
        (record(sources=[{"url": "https://example.jp/" + "a" * 1990, "title": "t"}, {"url": "https://example.jp/", "title": "t"}]), "url は http か https"),
        (record(sources=[{"url": "https://[::1/", "title": "t"}, {"url": "https://example.jp/", "title": "t"}]), "url は http か https"),
        (record(sources=[{"url": "https://example.jp/", "title": "あ" * 101}, {"url": "https://example.jp/", "title": "t"}]), "title は 100 字まで"),
        (record(sources=[{"url": "https://example.jp/"}, {"url": "https://example.jp/", "title": "t"}]), "url と title だけ"),
        (record(note="あ" * 201), "note は 200 字まで"),
        (record(note=None), "note は文字列"),
    ],
)
def test_save_input_is_checked(tool_input: Any, fragment: str) -> None:
    get_store().set_research_targets(ROW, [SCHOOL])
    payload, is_error = run("save_research", tool_input)
    assert is_error and payload["status"] == "error"
    assert payload["message"].startswith("save_research の入力が正しくありません。")
    assert fragment in payload["message"]
    assert get_store().get_research_result(SCHOOL) is None


def test_save_lists_several_problems_at_once() -> None:
    get_store().set_research_targets(ROW, [SCHOOL])
    payload, _ = run("save_research", record(status="x", note="あ" * 201, sources=[]))
    assert "status は" in payload["message"] and "note は" in payload["message"] and "sources は" in payload["message"]


def test_url_of_exactly_2000_chars_is_accepted() -> None:
    get_store().set_research_targets(ROW, [SCHOOL])
    url = "https://example.jp/" + "a" * (2000 - len("https://example.jp/"))
    payload, is_error = run("save_research", record(sources=[{"url": url, "title": "t"}, {"url": "https://example.jp/", "title": "t"}]))
    assert not is_error, payload


def test_save_does_not_overwrite_valid_or_demo_rows_but_replaces_expired_web_rows() -> None:
    store = get_store()
    store.set_research_targets(ROW, [SCHOOL, HOSPITAL])
    run("save_research", record(SCHOOL, note="最初"), now=NOW)
    # 期限内:上書きしない
    payload, is_error = run("save_research", record(SCHOOL, note="二度目"), now=NOW + DAY)
    assert is_error
    assert payload["message"] == (
        f"この対象は保存済みです({research.display_time(iso(NOW))} に確認)。期限が切れるまで調べ直せません"
    )
    assert store.get_research_result(SCHOOL)["note"] == "最初"
    # 期限切れの web:置き換える
    payload, is_error = run("save_research", record(SCHOOL, note="新しい"), now=NOW + 8 * DAY)
    assert not is_error and store.get_research_result(SCHOOL)["note"] == "新しい"
    # demo:いつまでも上書きしない
    store.seed_research_results(
        [{"target_id": HOSPITAL, "kind": "hospital", "name": "テスト総合病院", "checked_at": iso(NOW - 30 * DAY), **research._clean_record(record(HOSPITAL))}]
    )
    payload, is_error = run("save_research", record(HOSPITAL), now=NOW + 365 * DAY)
    assert is_error and "保存済みです" in payload["message"]
    assert store.get_research_result(HOSPITAL)["origin"] == "demo"


def test_save_is_refused_when_the_target_left_the_ref_data(ref_dir: Path) -> None:
    get_store().set_research_targets(ROW, [NORTH])
    (ref_dir / "facilities" / "6642.json").unlink()
    payload, is_error = run("save_research", record(NORTH))
    assert is_error and "参照データにありません" in payload["message"]


def test_tool_failure_is_a_fixed_message(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    def broken(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("中身 secret")

    monkeypatch.setattr(research, "session_targets", broken)
    payload, is_error = run("get_research_targets", {})
    assert is_error and payload == {"status": "error", "message": research.MSG_TOOL_FAILED}
    assert "secret" not in caplog.text


# ---- 中継:ツールの振り分けと saved の知らせ ----


def test_save_from_a_run_thread_is_saved_and_reported_as_progress(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    get_store().set_research_targets(row_id_of(handle), [SCHOOL, HOSPITAL])
    fake.streams = [
        FakeStream(
            [
                tool_use("get_research_targets", event_id="sevt_targets"),
                tool_use("save_research", event_id="sevt_save", thread=RUN_THREAD, **record(SCHOOL)),
                tool_use("get_research_results", event_id="sevt_results", target_ids=None),
            ]
        )
    ]
    response = client.get("/api/claude/session/stream", headers=headers(handle))
    frames = parse_sse(response.text)
    targets, saved, results = (events[0] for events in fake.sent)
    assert not targets["is_error"] and [t["target_id"] for t in tool_text(targets)["targets"]] == [SCHOOL, HOSPITAL]
    assert not saved["is_error"] and tool_text(saved)["target_id"] == SCHOOL
    assert not results["is_error"] and tool_text(results)["missing"] == [HOSPITAL]
    assert ("research", {"kind": "saved", "saved": 1, "total": 2}) in frames
    assert get_store().get_research_result(SCHOOL)["name"] == "テスト第一高等学校"


def test_refused_save_sends_no_progress(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    get_store().set_research_targets(row_id_of(handle), [SCHOOL])
    fake.streams = [FakeStream([tool_use("save_research", event_id="sevt_save", thread=RUN_THREAD, **record(NORTH))])]
    frames = parse_sse(client.get("/api/claude/session/stream", headers=headers(handle)).text)
    assert fake.sent[0][0]["is_error"] is True
    assert not any(kind == "research" for kind, _ in frames)


# ---- POST / GET /api/claude/session/research ----


def test_save_answered_again_after_a_failed_send_reuses_the_first_result(fake: FakeAnthropic) -> None:
    # 保存の後に events.send が届かない(400 以外の APIError)と、次の settle で同じ呼び出しに答え直す。
    # そのとき保存を2度実行せず(2度目は「保存済み」の is_error になる)、1度目の結果をそのまま返す
    get_store().set_research_targets(ROW, [SCHOOL])
    state = agent_session.SessionState(row_id=ROW, session_id="sesn_test", primary_thread_id="sthr_primary")
    call = {"type": "agent.custom_tool_use", "id": "sevt_save", "name": "save_research", "input": record(SCHOOL), "session_thread_id": RUN_THREAD}
    state.observe(call)

    request = httpx2.Request("POST", "https://api.anthropic.com/v1/sessions/x/events")
    failures = [anthropic.InternalServerError("upstream", response=httpx2.Response(500, request=request), body=None)]

    def fail_once(_events: list[dict[str, Any]]) -> None:
        if failures:
            raise failures.pop()

    fake.on_send = fail_once
    runs: list[str] = []
    original = research.run_tool

    def counting(name: str, *args: Any, **kwargs: Any) -> tuple[str, bool]:
        runs.append(name)
        return original(name, *args, **kwargs)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(research, "run_tool", counting)
        first = asyncio.run(agent_session.settle(state, fake))
        assert "sevt_save" not in state.answered
        second = asyncio.run(agent_session.settle(state, fake))
    assert runs == ["save_research"]
    assert len(fake.sent) == 2
    for sent in fake.sent:
        assert sent[0]["custom_tool_use_id"] == "sevt_save"
        assert sent[0]["is_error"] is False and tool_text(sent[0])["target_id"] == SCHOOL
    assert "sevt_save" in state.answered
    # 保存の知らせは、どちらの回にも流れる(1度目の行はブラウザに届いている)
    for frames in (first, second):
        assert ("research", {"kind": "saved", "saved": 1, "total": 1}) in parse_sse("".join(frames))
    # reset(履歴からの作り直し)の後も、同じ call_id には同じ結果で答える
    state.reset()
    state.observe(call)
    third_sent = len(fake.sent)
    asyncio.run(agent_session.settle(state, fake))
    assert runs == ["save_research"]
    assert fake.sent[third_sent][0]["is_error"] is False


def test_post_research_sets_targets_and_puts_the_screen_line_into_the_conversation(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    response = client.post(
        "/api/claude/session/research", json={"target_ids": [HOSPITAL, SCHOOL, HOSPITAL]}, headers=headers(handle)
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [target["target_id"] for target in body["targets"]] == [HOSPITAL, SCHOOL]
    assert body["targets"][0]["name"] == "テスト総合病院" and body["targets"][0]["cached"] is None
    assert body["total"] == 2 and body["max_targets"] == 30
    (events,) = fake.sent
    assert events == [
        {
            "type": "user.message",
            "content": [{"type": "text", "text": "[画面の操作] 利用者が前提情報の調査を始めました(対象 2 件)。"}],
        }
    ]
    row_id = row_id_of(handle)
    assert get_store().research_target_ids(row_id) == [HOSPITAL, SCHOOL]
    assert get_store().get_session(row_id)["messages"] == 1
    # 次の POST は対象の後ろに足す(重なりは除く)。返す一覧は足した後の対象
    response = client.post("/api/claude/session/research", json={"target_ids": [OPERATOR, SCHOOL]}, headers=headers(handle))
    assert response.status_code == 200
    assert get_store().research_target_ids(row_id) == [HOSPITAL, SCHOOL, OPERATOR]
    assert [target["target_id"] for target in response.json()["targets"]] == [HOSPITAL, SCHOOL, OPERATOR]
    # 会話に入れる行の件数は、送った対象の数
    assert fake.sent[-1][0]["content"][0]["text"] == "[画面の操作] 利用者が前提情報の調査を始めました(対象 2 件)。"


def test_post_research_keeps_the_targets_registered_from_saved_results(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, tmp_path: Path) -> None:
    # 保存済みの結果(デモ)で登録した対象は、利用者が調査を始めても消えない(調整役が読み続けられる)
    enable(monkeypatch)
    seed = tmp_path / "demo.json"
    seed.write_text(json.dumps([seed_item(SCHOOL), seed_item(HOSPITAL)], ensure_ascii=False), encoding="utf-8")
    assert research.run_seed([str(seed)]) == 0
    handle = create(client)
    row_id = row_id_of(handle)
    assert post_known(client, handle, {"target_ids": [SCHOOL, HOSPITAL]}).json() == {"registered": 2, "total": 2}
    response = client.post("/api/claude/session/research", json={"target_ids": [CLINIC, SCHOOL]}, headers=headers(handle))
    assert response.status_code == 200, response.text
    assert get_store().research_target_ids(row_id) == [SCHOOL, HOSPITAL, CLINIC]
    body = response.json()
    assert body["total"] == 3
    assert [(target["target_id"], target["cached"] is not None) for target in body["targets"]] == [(SCHOOL, True), (HOSPITAL, True), (CLINIC, False)]
    results, is_error = run("get_research_results", {"target_ids": None}, now=time.time(), row=row_id)
    assert not is_error
    assert [r["target_id"] for r in results["results"]] == [SCHOOL, HOSPITAL]
    assert results["missing"] == [CLINIC]


@pytest.mark.parametrize(
    ("body", "status", "fragment"),
    [
        ([SCHOOL], 400, "本文は target_ids だけ"),
        ({"target_ids": [SCHOOL], "names": ["ブラウザの名前"]}, 400, "本文は target_ids だけ"),
        ({"target_ids": []}, 400, "1〜80 件"),
        ({"target_ids": SCHOOL}, 400, "1〜80 件"),
        ({"target_ids": [1]}, 400, "target_id の文字列"),
        ({"target_ids": [SCHOOL, "P29:無い学校"]}, 400, "参照データに無い対象があります:P29:無い学校"),
    ],
)
def test_post_research_rejects_bad_bodies(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, body: Any, status: int, fragment: str) -> None:
    enable(monkeypatch)
    handle = create(client)
    response = client.post("/api/claude/session/research", json=body, headers=headers(handle))
    assert response.status_code == status
    assert fragment in response.json()["detail"]
    assert fake.calls_named("events.send") == []
    assert get_store().research_target_ids(row_id_of(handle)) == []


def test_post_research_respects_the_max_targets(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_RESEARCH_MAX_TARGETS", "2")
    handle = create(client)
    response = client.post("/api/claude/session/research", json={"target_ids": [SCHOOL, HOSPITAL, CLINIC]}, headers=headers(handle))
    assert response.status_code == 400
    assert response.json()["detail"] == "調べる対象(周辺のバス事業者を除く)は 2 件までにしてください(選んだのは 3 件)"


def test_post_research_does_not_count_operators_in_the_max_targets(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_RESEARCH_MAX_TARGETS", "2")
    handle = create(client)
    response = client.post("/api/claude/session/research", json={"target_ids": [SCHOOL, HOSPITAL, OPERATOR]}, headers=headers(handle))
    assert response.status_code == 200
    assert response.json()["total"] == 3


def test_post_research_without_ref_data_is_503(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, tmp_path: Path) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(tmp_path / "none"))
    handle = create(client)
    response = client.post("/api/claude/session/research", json={"target_ids": [SCHOOL]}, headers=headers(handle))
    assert response.status_code == 503
    assert response.json()["detail"] == research.MSG_NO_REF


def test_post_research_rolls_back_when_a_browser_tool_waits(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    row_id = row_id_of(handle)
    get_store().set_research_targets(row_id, [CLINIC])
    fake.history = [tool_use("apply_policy", event_id="sevt_wait")]
    response = client.post("/api/claude/session/research", json={"target_ids": [SCHOOL]}, headers=headers(handle))
    assert response.status_code == 409
    assert response.json()["detail"] == "AI がツールの結果を待っています。少し待ってから送ってください"
    assert get_store().research_target_ids(row_id) == [CLINIC]
    assert fake.calls_named("events.send") == []


def test_post_research_counts_as_a_message_for_the_limits(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_MESSAGES_PER_IP_HOUR", "1")
    handle = create(client)
    assert client.post("/api/claude/session/research", json={"target_ids": [SCHOOL]}, headers=headers(handle)).status_code == 200
    response = client.post("/api/claude/session/research", json={"target_ids": [SCHOOL]}, headers=headers(handle))
    assert response.status_code == 429


def test_research_endpoints_need_the_token_and_the_handle(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    for method in ("get", "post"):
        call = getattr(client, method)
        kwargs = {"json": {"target_ids": [SCHOOL]}} if method == "post" else {}
        wrong_token = call("/api/claude/session/research", headers={"X-Dispatcher-Token": "wrong-token", "X-Dispatcher-Session": handle}, **kwargs)
        assert wrong_token.status_code == 401
        no_handle = call("/api/claude/session/research", headers=headers(), **kwargs)
        assert no_handle.status_code == 404
        bad_handle = call("/api/claude/session/research", headers=headers(handle[:-2] + "xx"), **kwargs)
        assert bad_handle.status_code == 404
    assert fake.calls_named("events.send") == []
    # 終えた会話は 410
    assert client.delete("/api/claude/session", headers=headers(handle)).status_code == 202
    assert client.get("/api/claude/session/research", headers=headers(handle)).status_code == 410


def test_get_research_returns_targets_and_saved_results(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    empty = client.get("/api/claude/session/research", headers=headers(handle))
    assert empty.status_code == 200
    assert empty.json() == {"targets": [], "results": [], "missing": [], "saved": 0, "total": 0, "max_targets": 30}
    row_id = row_id_of(handle)
    get_store().set_research_targets(row_id, [SCHOOL, OPERATOR])
    research.run_tool("save_research", row_id, record(SCHOOL))
    body = client.get("/api/claude/session/research", headers=headers(handle)).json()
    assert [target["target_id"] for target in body["targets"]] == [SCHOOL, OPERATOR]
    assert body["targets"][0]["cached"]["status"] == "found"
    assert [result["target_id"] for result in body["results"]] == [SCHOOL]
    assert body["results"][0]["sources"][0]["url"] == "https://example.ed.jp/school/"
    assert body["missing"] == [OPERATOR] and body["saved"] == 1 and body["total"] == 2


# ---- POST /api/claude/session/research/known(指摘15.1。会話の行を送らずに保存済みの結果の対象を登録する) ----


def post_known(client: TestClient, handle: str, body: Any) -> Any:
    return client.post("/api/claude/session/research/known", json=body, headers=headers(handle))


def test_known_registers_demo_targets_so_the_coordinator_can_read_them_without_a_message(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, tmp_path: Path) -> None:
    enable(monkeypatch)
    seed = tmp_path / "demo.json"
    seed.write_text(json.dumps([seed_item(SCHOOL), seed_item(HOSPITAL)], ensure_ascii=False), encoding="utf-8")
    assert research.run_seed([str(seed)]) == 0
    handle = create(client)
    row_id = row_id_of(handle)
    # 登録の前は、調整役が読んでも空(15.1 の「保存済みの調査結果はありませんでした」)
    before, is_error = run("get_research_results", {"target_ids": None}, now=time.time(), row=row_id)
    assert not is_error and before == {"status": "ok", "results": [], "missing": []}

    response = post_known(client, handle, {"target_ids": [SCHOOL, HOSPITAL]})
    assert response.status_code == 200, response.text
    assert response.json() == {"registered": 2, "total": 2}
    after, is_error = run("get_research_results", {"target_ids": None}, now=time.time(), row=row_id)
    assert not is_error
    assert [(r["target_id"], r["origin"]) for r in after["results"]] == [(SCHOOL, "demo"), (HOSPITAL, "demo")]
    assert after["missing"] == []
    targets, _ = run("get_research_targets", None, now=time.time(), row=row_id)
    assert all(target["cached"] is not None for target in targets["targets"])
    # 会話には何も入れず、発言にも数えない
    assert fake.calls_named("events.send") == []
    assert get_store().get_session(row_id)["messages"] == 0


def test_known_appends_without_duplicates_and_skips_ids_without_usable_results(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    handle = create(client)
    row_id = row_id_of(handle)
    now = time.time()
    store = get_store()
    common = {"facts": [], "sources": [], "note": "", "status": "not_found", "cache_days": 7}
    store.save_research_result(target_id=CLINIC, kind="clinic", name="テスト診療所", now=now, **common)
    store.save_research_result(target_id=SCHOOL, kind="school", name="テスト第一高等学校", now=now, origin="demo", **common)
    # 期限の切れた web の結果は使えない(掃除の前でも)
    store.save_research_result(target_id=HOSPITAL, kind="hospital", name="テスト総合病院", now=now - 30 * DAY, **common)
    store.set_research_targets(row_id, [CLINIC])

    response = post_known(client, handle, {"target_ids": [SCHOOL, CLINIC, HOSPITAL, OPERATOR, SCHOOL]})
    assert response.status_code == 200, response.text
    # CLINIC は既にある、HOSPITAL は期限切れ、OPERATOR は結果が無い
    assert response.json() == {"registered": 1, "total": 2}
    assert store.research_target_ids(row_id) == [CLINIC, SCHOOL]
    # 同じ集まりをもう一度送っても増えない
    again = post_known(client, handle, {"target_ids": [SCHOOL, CLINIC]})
    assert again.json() == {"registered": 0, "total": 2}
    assert store.research_target_ids(row_id) == [CLINIC, SCHOOL]
    # 結果の無い ID だけでも 200(何も足さない)
    none = post_known(client, handle, {"target_ids": [OPERATOR]})
    assert none.status_code == 200 and none.json() == {"registered": 0, "total": 2}
    assert fake.calls_named("events.send") == []


@pytest.mark.parametrize(
    ("body", "status", "fragment"),
    [
        ([SCHOOL], 400, "本文は target_ids だけ"),
        ({"target_ids": [SCHOOL], "names": ["ブラウザの名前"]}, 400, "本文は target_ids だけ"),
        ({"target_ids": []}, 400, "1〜50 件"),
        ({"target_ids": None}, 400, "1〜50 件"),
        ({"target_ids": SCHOOL}, 400, "1〜50 件"),
        ({"target_ids": [f"P29:{n:012d}" for n in range(51)]}, 400, "1〜50 件"),
        ({"target_ids": [1]}, 400, "target_id の文字列"),
        ({"target_ids": [""]}, 400, "target_id の文字列"),
        ({"target_ids": [SCHOOL, "P29:無い学校"]}, 400, "参照データに無い対象があります:P29:無い学校"),
    ],
)
def test_known_rejects_bad_bodies(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, body: Any, status: int, fragment: str) -> None:
    enable(monkeypatch)
    handle = create(client)
    get_store().seed_research_results(
        [{"target_id": SCHOOL, "kind": "school", "name": "テスト第一高等学校", "checked_at": iso(NOW), **research._clean_record(record(SCHOOL))}]
    )
    response = post_known(client, handle, body)
    assert response.status_code == status
    assert fragment in response.json()["detail"]
    assert get_store().research_target_ids(row_id_of(handle)) == []
    assert fake.calls_named("events.send") == []


def test_known_accepts_more_than_the_research_max_targets(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    # 上限は get_research_results と同じ 50 件(調べる対象の上限 DISPATCHER_RESEARCH_MAX_TARGETS ではない)
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_RESEARCH_MAX_TARGETS", "1")
    handle = create(client)
    response = post_known(client, handle, {"target_ids": [SCHOOL, HOSPITAL]})
    assert response.status_code == 200, response.text


def test_known_without_ref_data_is_503(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, tmp_path: Path) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(tmp_path / "none"))
    handle = create(client)
    response = post_known(client, handle, {"target_ids": [SCHOOL]})
    assert response.status_code == 503
    assert response.json()["detail"] == research.MSG_NO_REF


def test_known_does_not_count_as_a_message_and_works_while_a_browser_tool_waits(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic) -> None:
    enable(monkeypatch)
    monkeypatch.setenv("DISPATCHER_MESSAGES_PER_IP_HOUR", "1")
    handle = create(client)
    for _ in range(3):
        assert post_known(client, handle, {"target_ids": [SCHOOL]}).status_code == 200
    # 発言の上限(1 時間に 1 回)は使っていない
    assert client.post("/api/claude/session/research", json={"target_ids": [SCHOOL]}, headers=headers(handle)).status_code == 200
    assert client.post("/api/claude/session/research", json={"target_ids": [SCHOOL]}, headers=headers(handle)).status_code == 429
    sent = len(fake.calls_named("events.send"))
    # AI がブラウザのツールの結果を待っていても、会話に何も入れないので登録できる(409 にならない)
    other = create(client)
    fake.history = [tool_use("apply_policy", event_id="sevt_wait")]
    assert post_known(client, other, {"target_ids": [SCHOOL]}).status_code == 200
    assert len(fake.calls_named("events.send")) == sent


def test_known_needs_the_token_and_the_handle_and_logs_only_counts(monkeypatch: pytest.MonkeyPatch, client: TestClient, fake: FakeAnthropic, caplog: pytest.LogCaptureFixture) -> None:
    enable(monkeypatch)
    handle = create(client)
    url = "/api/claude/session/research/known"
    body = {"target_ids": [SCHOOL]}
    assert client.post(url, json=body, headers={"X-Dispatcher-Token": "wrong-token", "X-Dispatcher-Session": handle}).status_code == 401
    assert client.post(url, json=body, headers=headers()).status_code == 404
    assert client.post(url, json=body, headers=headers(handle[:-2] + "xx")).status_code == 404
    get_store().seed_research_results(
        [{"target_id": SCHOOL, "kind": "school", "name": "テスト第一高等学校", "checked_at": iso(NOW), **research._clean_record(record(SCHOOL))}]
    )
    with caplog.at_level(logging.INFO, logger="dispatcher_server"):
        assert client.post(url, json=body, headers=headers(handle)).status_code == 200
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "requested=1 registered=1 total=1" in logged
    for secret in (SCHOOL, "テスト第一高等学校", handle, TOKEN):
        assert secret not in logged
    assert client.delete("/api/claude/session", headers=headers(handle)).status_code == 202
    assert client.post(url, json=body, headers=headers(handle)).status_code == 410


# ---- デモ用の結果の取り込み ----


def seed_item(target_id: str = SCHOOL, **overrides: Any) -> dict[str, Any]:
    return {**record(target_id), "checked_at": "2026-11-06T10:00:00+09:00", **overrides}


def test_seed_imports_demo_rows_that_research_cannot_overwrite(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    store = get_store()
    store.set_research_targets(ROW, [SCHOOL])
    # 先に web の行があっても、デモ用の結果で置き換える
    run("save_research", record(SCHOOL, note="web の結果"), now=time.time())
    path = tmp_path / "demo.json"
    path.write_text(
        json.dumps({"results": [seed_item(SCHOOL, name="ファイルの名前", kind="clinic"), seed_item(OPERATOR, status="partial")]}, ensure_ascii=False),
        encoding="utf-8",
    )
    assert research.run_seed([str(path)]) == 0
    assert "2 件入れました" in capsys.readouterr().out
    row = store.get_research_result(SCHOOL)
    assert row is not None
    # 種類と名前はサーバーの参照データから入れる(ファイルの kind・name は読まない)
    assert (row["origin"], row["expires_at"], row["kind"], row["name"]) == ("demo", None, "school", "テスト第一高等学校")
    assert row["checked_at"] == iso(datetime(2026, 11, 6, 1, 0, tzinfo=UTC).timestamp())  # 2026-11-06T10:00:00+09:00
    assert row["note"] == ""
    # 調査では上書きされない
    payload, is_error = run("save_research", record(SCHOOL), now=time.time() + 400 * DAY)
    assert is_error and "2026-11-06T10:00:00+09:00 に確認" in payload["message"]


def test_seed_accepts_a_plain_list(tmp_path: Path) -> None:
    path = tmp_path / "demo.json"
    path.write_text(json.dumps([seed_item(CLINIC, status="not_found", facts=[], sources=[])]), encoding="utf-8")
    assert research.run_seed([str(path)]) == 0
    assert get_store().get_research_result(CLINIC)["status"] == "not_found"


@pytest.mark.parametrize(
    ("items", "fragment"),
    [
        ([seed_item(), seed_item("P29:無い学校")], "2 件目:target_id P29:無い学校 が参照データにありません"),
        ([seed_item(), seed_item()], "2 件目:target_id P29:01234567890A が2回あります"),
        ([seed_item(checked_at="2026-11-06T10:00:00")], "1 件目:checked_at は時差つき"),
        ([{k: v for k, v in seed_item().items() if k != "checked_at"}], "checked_at は時差つき"),
        ([seed_item(sources=[{"url": "ftp://x", "title": "t"}])], "url は http か https"),
        ([seed_item(extra=1)], "知らない項目があります:extra"),
        ([], "空か、ありません"),
    ],
)
def test_seed_imports_nothing_when_something_is_wrong(tmp_path: Path, capsys: pytest.CaptureFixture[str], items: list[Any], fragment: str) -> None:
    path = tmp_path / "demo.json"
    path.write_text(json.dumps({"results": items}, ensure_ascii=False), encoding="utf-8")
    assert research.run_seed([str(path)]) == 1
    err = capsys.readouterr().err
    assert "1件も入れていません" in err and fragment in err
    assert get_store().get_research_result(SCHOOL) is None


def test_seed_rejects_unreadable_files(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "broken.json"
    path.write_text("{", encoding="utf-8")
    assert research.run_seed([str(path)]) == 1
    assert "JSON として読めません" in capsys.readouterr().err
    assert research.run_seed([str(tmp_path / "none.json")]) == 1


def test_export_then_seed_round_trip(tmp_path: Path) -> None:
    store = get_store()
    store.set_research_targets(ROW, [SCHOOL, HOSPITAL])
    run("save_research", record(SCHOOL), now=time.time())
    run("save_research", record(HOSPITAL, note="外来は午前のみ"), now=time.time())
    exported = tmp_path / "export.json"
    assert research.run_seed(["--export", str(exported)]) == 0
    data = json.loads(exported.read_text(encoding="utf-8"))
    assert [item["target_id"] for item in data["results"]] == [HOSPITAL, SCHOOL]
    # 書き出したファイルを、そのままデモ用に取り込める
    assert research.run_seed([str(exported)]) == 0
    assert store.get_research_result(HOSPITAL)["origin"] == "demo"
    assert store.get_research_result(HOSPITAL)["note"] == "外来は午前のみ"


def test_seed_script_is_declared() -> None:
    pyproject = (Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    assert 'dispatcher-research-seed = "dispatcher_server.research:seed_main"' in pyproject
