import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from dispatcher_server.app import DEFAULT_REF_DIR, app, ref_dir_path

client = TestClient(app)

SAMPLE = {
    "mesh1": "6542",
    "pop250": {"6542123456": 123},
    "did125": ["65421234567"],
    "stations": [
        {
            "name": "テスト駅",
            "line": "テスト線",
            "operator": "テスト鉄道",
            "lat": 43.7,
            "lon": 142.3,
        }
    ],
    "sources": ["テスト用の参照データ"],
}


@pytest.fixture
def ref_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "ref"
    d.mkdir()
    (d / "6542.json").write_text(json.dumps(SAMPLE, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(d))
    return d


def test_参照データをそのまま返す(ref_dir: Path) -> None:
    res = client.get("/api/ref/6542")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/json"
    assert res.headers["cache-control"] == "public, max-age=3600"
    assert res.content == (ref_dir / "6542.json").read_bytes()
    assert res.json() == SAMPLE


def test_ファイルが無ければ日本語の404(ref_dir: Path) -> None:
    res = client.get("/api/ref/6543")
    assert res.status_code == 404
    detail = res.json()["detail"]
    assert "6543" in detail
    assert "見つかりません" in detail


@pytest.mark.parametrize(
    "mesh1",
    [
        "654",  # 3桁
        "65421",  # 5桁
        "abcd",  # 数字でない
        "%EF%BC%96%EF%BC%95%EF%BC%94%EF%BC%92",  # 全角数字の 6542
        "6542%0A",  # 末尾に改行
    ],
)
def test_数字4桁でない入力は404(ref_dir: Path, mesh1: str) -> None:
    res = client.get(f"/api/ref/{mesh1}")
    assert res.status_code == 404
    assert "数字4桁" in res.json()["detail"]


def test_区切り文字でパスを書き換えても読ませない(tmp_path: Path, ref_dir: Path) -> None:
    # ..%2Fx は「../x」になり、ref_dir の1つ上の x.json を指す。存在しても読ませない。
    (ref_dir.parent / "x.json").write_text("{}", encoding="utf-8")
    res = client.get("/api/ref/..%2Fx")
    assert res.status_code == 404
    assert "数字4桁" in res.json()["detail"]


def test_環境変数はリクエストのたびに読む(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "6542.json").write_text('{"from": "a"}', encoding="utf-8")
    (b / "6542.json").write_text('{"from": "b"}', encoding="utf-8")

    monkeypatch.setenv("DISPATCHER_REF_DIR", str(a))
    assert client.get("/api/ref/6542").json() == {"from": "a"}

    monkeypatch.setenv("DISPATCHER_REF_DIR", str(b))
    assert client.get("/api/ref/6542").json() == {"from": "b"}


def test_環境変数の置き場所が無ければ404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(tmp_path / "missing"))
    res = client.get("/api/ref/6542")
    assert res.status_code == 404


def test_既定の置き場所はdata_out_ref(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DISPATCHER_REF_DIR", raising=False)
    assert ref_dir_path() == DEFAULT_REF_DIR
    assert DEFAULT_REF_DIR.parts[-2:] == ("out", "ref")
