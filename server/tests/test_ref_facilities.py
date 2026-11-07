"""施設の参照データ(GET /api/ref/facilities/{mesh1})と、デモ用の保存済みの調査の結果(GET /api/research/demo)。

どちらも公開データなので合言葉を掛けない(利用者の決定 11/3)。参照データはテスト用のフィクスチャ(tests/fixtures/research_ref)。
"""

import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from dispatcher_server import research
from dispatcher_server.app import app
from dispatcher_server.store import get_store, iso

FIXTURE_REF = Path(__file__).parent / "fixtures" / "research_ref"

SCHOOL = "P29:01234567890A"
HOSPITAL = "P04:0123456789ab"

client = TestClient(app)


@pytest.fixture(autouse=True)
def ref_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    directory = tmp_path / "ref"
    shutil.copytree(FIXTURE_REF, directory)
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(directory))
    research.reset_cache()
    yield directory
    research.reset_cache()


def demo_row(target_id: str, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "target_id": target_id,
        "kind": "school",
        "name": "ブラウザやファイルの名前は使わない",
        "status": "found",
        "facts": [{"label": "始業", "value": "8時40分", "source": 1}],
        "sources": [{"url": "https://example.jp/school", "title": "学校の案内"}],
        "note": "",
        "checked_at": iso(1_793_700_000.0),
    }
    row.update(overrides)
    return row


# ---- 施設の参照データ ----


def test_施設の参照データをそのまま返す(ref_dir: Path) -> None:
    res = client.get("/api/ref/facilities/6542")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/json"
    assert res.headers["cache-control"] == "public, max-age=3600"
    assert res.content == (ref_dir / "facilities" / "6542.json").read_bytes()


def test_施設のファイルが無ければ日本語の404() -> None:
    res = client.get("/api/ref/facilities/6543")
    assert res.status_code == 404
    detail = res.json()["detail"]
    assert "6543" in detail
    assert "施設" in detail


@pytest.mark.parametrize("mesh1", ["654", "65421", "abcd", "%EF%BC%96%EF%BC%95%EF%BC%94%EF%BC%92", "6542%0A"])
def test_施設の1次メッシュは数字4桁だけ(mesh1: str) -> None:
    res = client.get(f"/api/ref/facilities/{mesh1}")
    assert res.status_code == 404
    assert "数字4桁" in res.json()["detail"]


def test_施設の経路を足しても参照データと区切りの受け皿はそのまま(ref_dir: Path) -> None:
    assert client.get("/api/ref/6542").status_code == 200
    res = client.get("/api/ref/facilities/6542/x")
    assert res.status_code == 404
    assert "数字4桁" in res.json()["detail"]


def test_施設の参照データに合言葉は要らない(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPATCHER_TOKEN", "test-token-0123456789")
    assert client.get("/api/ref/facilities/6542").status_code == 200
    assert client.get("/api/research/demo").status_code == 200


# ---- デモ用の保存済みの結果 ----


def test_デモの結果が無ければ空() -> None:
    res = client.get("/api/research/demo")
    assert res.status_code == 200
    assert res.json() == {"results": []}


def test_デモの結果だけを参照データの名前と位置で返す() -> None:
    store = get_store()
    store.seed_research_results([demo_row(SCHOOL), demo_row("P29:参照データに無い")])
    # web の行(期限内)はデモの一覧に入れない
    store.save_research_result(
        target_id=HOSPITAL,
        kind="hospital",
        name="テスト総合病院",
        status="found",
        facts=[],
        sources=[{"url": "https://example.jp/h", "title": "病院"}],
        note="",
        now=time.time(),
        cache_days=7,
    )
    res = client.get("/api/research/demo")
    assert res.status_code == 200
    results = res.json()["results"]
    assert [r["target_id"] for r in results] == [SCHOOL]
    first = results[0]
    assert first["name"] == "テスト第一高等学校"
    assert first["kind"] == "school"
    assert first["municipality"] == "旭川市"
    assert first["lat"] == 43.77 and first["lon"] == 142.36
    assert first["origin"] == "demo"
    assert first["status"] == "found"
    assert first["facts"] == [{"label": "始業", "value": "8時40分", "source": 1}]
    assert first["sources"] == [{"url": "https://example.jp/school", "title": "学校の案内"}]
    # 確認日時は日本時間で返す
    assert first["checked_at"].endswith("+09:00")
