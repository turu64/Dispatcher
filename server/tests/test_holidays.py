import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from dispatcher_server.app import HOLIDAYS_NOT_FOUND, app

client = TestClient(app)

# data/ の dispatcher-holidays が書く holidays.json と同じ形(docs/interfaces-1104.md の §2)
SAMPLE = {
    "source": "内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成",
    "url": "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv",
    "first": "20261103",
    "last": "20270101",
    "coveredUntil": "20271231",
    "holidays": [["20261103", "文化の日"], ["20270101", "元日"]],
}


@pytest.fixture
def ref_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "ref"
    d.mkdir()
    (d / "holidays.json").write_text(
        json.dumps(SAMPLE, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(d))
    return d


def test_祝日一覧をそのまま返す(ref_dir: Path) -> None:
    res = client.get("/api/holidays")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/json"
    assert res.headers["cache-control"] == "public, max-age=3600"
    assert res.content == (ref_dir / "holidays.json").read_bytes()
    assert res.json() == SAMPLE


def test_ファイルが無ければ日本語の404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(empty))
    res = client.get("/api/holidays")
    assert res.status_code == 404
    assert res.json()["detail"] == (
        "祝日一覧が見つかりません。data/ の dispatcher-holidays で data/out/ref に作ってください。"
    )
    assert res.json()["detail"] == HOLIDAYS_NOT_FOUND


def test_置き場所が無ければ404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(tmp_path / "missing"))
    assert client.get("/api/holidays").status_code == 404


def test_祝日一覧は1次メッシュの経路に入らない(ref_dir: Path) -> None:
    # /api/ref/holidays は数字4桁でないので 404(祝日一覧は返さない)
    res = client.get("/api/ref/holidays")
    assert res.status_code == 404
    assert "数字4桁" in res.json()["detail"]


def test_1次メッシュのJSONは祝日一覧として返さない(ref_dir: Path) -> None:
    (ref_dir / "6542.json").write_text('{"mesh1": "6542"}', encoding="utf-8")
    assert client.get("/api/holidays").json() == SAMPLE
    assert client.get("/api/ref/6542").json() == {"mesh1": "6542"}


def test_環境変数はリクエストのたびに読む(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "holidays.json").write_text('{"from": "a"}', encoding="utf-8")
    (b / "holidays.json").write_text('{"from": "b"}', encoding="utf-8")

    monkeypatch.setenv("DISPATCHER_REF_DIR", str(a))
    assert client.get("/api/holidays").json() == {"from": "a"}

    monkeypatch.setenv("DISPATCHER_REF_DIR", str(b))
    assert client.get("/api/holidays").json() == {"from": "b"}


def test_空文字の環境変数は未設定として扱う(monkeypatch: pytest.MonkeyPatch) -> None:
    # Path("") は現在のディレクトリになるので、そこの holidays.json を配ってしまわない
    monkeypatch.setenv("DISPATCHER_REF_DIR", "")
    from dispatcher_server.app import DEFAULT_REF_DIR, ref_dir_path

    assert ref_dir_path() == DEFAULT_REF_DIR
