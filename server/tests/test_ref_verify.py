"""参照データの配信(GET /api/ref/{mesh1})を、反証の立場で確かめる。

前半は、配信される参照データ(data/out/ref/{1次メッシュ}.json。DISPATCHER_REF_DIR で変えられる)の形が
取り決め(docs/interfaces-1103.md)どおりかを確かめる。ファイルが1つも無ければスキップする。
後半は、サーバーの端の挙動を確かめる。こちらはデータが無くても走る。
"""

import itertools
import json
import re
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from dispatcher_server.app import DEFAULT_REF_DIR, REPO_ROOT, app, ref_dir_path

client = TestClient(app)

REF_DIR = ref_dir_path()
# 1次メッシュのファイル(数字4桁.json)だけを調べる。同じ場所にある holidays.json(祝日一覧)は
# 形が違うので含めない(test_holidays.py で確かめる)
REAL_FILES = sorted(REF_DIR.glob("[0-9][0-9][0-9][0-9].json")) if REF_DIR.is_dir() else []

EXPECTED_KEYS = {"mesh1", "pop250", "did125", "stations", "sources"}
STATION_KEYS = {"name", "line", "operator", "lat", "lon"}

# 駅がファイルの1次メッシュの外にあってよい幅(度)。
# 取り決めは「駅を1次メッシュのどのファイルに入れるか」を決めていない。
# 境界付近の駅を両側のファイルに入れる作りも許す。最大の徒歩圏 1,600m は、
# 緯度で約 0.015 度、北海道の経度で約 0.021 度なので、余裕を見て 0.03 度にする。
# これより外にあれば、緯度と経度の取り違えや、ファイルの取り違えを疑う。
BOUNDARY_MARGIN_DEG = 0.03


def is_digits(s: object, n: int) -> bool:
    return isinstance(s, str) and re.fullmatch(rf"[0-9]{{{n}}}", s) is not None


def has_valid_mesh_digits(code: str) -> bool:
    # 2次メッシュ(5・6桁目)は 0〜7。分割地域メッシュ(9桁目以降)は 1〜4(南西 1・南東 2・北西 3・北東 4)
    return all(c in "01234567" for c in code[4:6]) and all(c in "1234" for c in code[8:])


def mesh1_bounds(code: str) -> tuple[float, float, float, float]:
    # 1次メッシュ:南の緯度 = 上2桁 × 2/3 度、西の経度 = 100 + 下2桁 度。大きさは 2/3 度 × 1 度。
    south = int(code[:2]) * 2 / 3
    west = 100 + int(code[2:])
    return south, west, south + 2 / 3, west + 1


def reject_constant(name: str) -> None:
    # Python の json は NaN・Infinity を黙って読む。ブラウザの JSON.parse は読めずに失敗する
    raise ValueError(f"JSON に書けない値 {name} が入っています")


@pytest.fixture(params=REAL_FILES or [None], ids=lambda p: p.name if p else "データなし")
def ref_file(request: pytest.FixtureRequest) -> tuple[Path, dict]:
    path: Path | None = request.param
    if path is None:
        pytest.skip("参照データ(data/out/ref/*.json)が無いため、形の検証をスキップします")
    # BOM は utf-8-sig で読み飛ばす。BOM の有無は専用のテストで確かめる(全テストを巻き込まないため)
    return path, json.loads(path.read_bytes().decode("utf-8-sig"))


def test_キーは取り決めどおり(ref_file: tuple[Path, dict]) -> None:
    _, data = ref_file
    assert set(data) == EXPECTED_KEYS


def test_ブラウザの_JSON_parse_で読める(ref_file: tuple[Path, dict]) -> None:
    path, _ = ref_file
    raw = path.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf"), "BOM が付いています"
    json.loads(raw.decode("utf-8"), parse_constant=reject_constant)


def test_メッシュコードはファイル名と一致(ref_file: tuple[Path, dict]) -> None:
    path, data = ref_file
    assert is_digits(path.stem, 4)
    assert data["mesh1"] == path.stem


def test_人口のコードは1次メッシュの中(ref_file: tuple[Path, dict]) -> None:
    path, data = ref_file
    pop = data["pop250"]
    assert isinstance(pop, dict)
    for code, count in pop.items():
        assert is_digits(code, 10), code
        assert code.startswith(path.stem), code
        assert has_valid_mesh_digits(code), code
        # 0 人のセルは入れない
        assert isinstance(count, int) and not isinstance(count, bool) and count >= 1, code


def test_DIDのコードは1次メッシュの中(ref_file: tuple[Path, dict]) -> None:
    path, data = ref_file
    did = data["did125"]
    assert isinstance(did, list)
    assert len(did) == len(set(did))
    for code in did:
        assert is_digits(code, 11), code
        assert code.startswith(path.stem), code
        assert has_valid_mesh_digits(code), code


def test_駅は形が正しく1次メッシュの近くにある(ref_file: tuple[Path, dict]) -> None:
    path, data = ref_file
    south, west, north, east = mesh1_bounds(path.stem)
    m = BOUNDARY_MARGIN_DEG
    assert isinstance(data["stations"], list)
    for st in data["stations"]:
        assert set(st) == STATION_KEYS, st
        for key in ("name", "line", "operator"):
            assert isinstance(st[key], str) and st[key], st
        for key in ("lat", "lon"):
            assert isinstance(st[key], (int, float)) and not isinstance(st[key], bool), st
        assert south - m <= st["lat"] < north + m, st
        assert west - m <= st["lon"] < east + m, st


def test_同じ駅名と事業者の駅は1つにまとめてある(ref_file: tuple[Path, dict]) -> None:
    # 取り決め:同じ駅名・同じ事業者の複数の線は1つにまとめる。
    # 北海道の N02 では、同じ駅名・同じ事業者で離れた場所にある駅は無い(11/3 に実データで確認)
    _, data = ref_file
    keys = [(st["name"], st["operator"]) for st in data["stations"]]
    dup = sorted({k for k in keys if keys.count(k) > 1})
    assert not dup, dup


def test_出典は加工した旨を含む(ref_file: tuple[Path, dict]) -> None:
    _, data = ref_file
    sources = data["sources"]
    assert isinstance(sources, list) and sources
    assert all(isinstance(s, str) and s for s in sources)
    # CLAUDE.md:e-Stat は加工した旨も書く。国土数値情報も加工して使う
    assert any("e-Stat" in s and "加工" in s for s in sources), sources
    assert any("国土数値情報" in s and "加工" in s for s in sources), sources


def test_配信される本文はファイルと同じ(ref_file: tuple[Path, dict]) -> None:
    path, _ = ref_file
    res = client.get(f"/api/ref/{path.stem}")
    assert res.status_code == 200
    assert res.content == path.read_bytes()


# ここから下はデータが無くても走る。サーバーの端の挙動。


@pytest.fixture
def small_ref_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "ref"
    d.mkdir()
    (d / "6542.json").write_text('{"mesh1": "6542"}', encoding="utf-8")
    # ref_dir の1つ上にも置いておく。パスを書き換えられたら、こちらが読まれてしまう
    (tmp_path / "x.json").write_text('{"leak": true}', encoding="utf-8")
    (tmp_path / "6542.json").write_text('{"leak": true}', encoding="utf-8")
    monkeypatch.setenv("DISPATCHER_REF_DIR", str(d))
    return d


# 経路の区切りや改行など、検査をすり抜けそうな文字
TRICKY = ["\n", "\r", "/", "\\", ".", " ", "\x00", "あ", "６"]


def tricky_inputs() -> list[str]:
    out: set[str] = set()
    for n in (1, 2, 3):
        out.update("".join(p) for p in itertools.product(TRICKY, repeat=n))
    for pre, suf in itertools.product(["", *TRICKY], repeat=2):
        out.add(f"{pre}6542{suf}")
        out.add(f"{pre}65{suf}42")
    # 空は経路が変わる。「.」「..」だけの区間はクライアントが整えて消える。「6542」だけは正しい入力
    out -= {"", ".", "..", "6542"}
    return sorted(out)


def test_数字4桁以外はどんな文字の混ざり方でも同じ日本語の404(small_ref_dir: Path) -> None:
    bad = []
    for s in tricky_inputs():
        res = client.get(f"/api/ref/{quote(s, safe='')}")
        body = res.json()
        if res.status_code != 404 or "数字4桁" not in body.get("detail", ""):
            bad.append((s, res.status_code, body))
    assert not bad, bad[:10]


def test_数字4桁だけが通る(small_ref_dir: Path) -> None:
    assert client.get("/api/ref/6542").status_code == 200
    assert client.get("/api/ref/0000").status_code == 404  # 形は正しいがファイルが無い


def test_空の環境変数は未設定として扱う(
    tmp_path: Path, small_ref_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Path("") は現在のディレクトリ。cwd の 6542.json を配ってはいけない
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    (cwd / "6542.json").write_text('{"from": "cwd"}', encoding="utf-8")
    monkeypatch.chdir(cwd)
    monkeypatch.setenv("DISPATCHER_REF_DIR", "")
    assert ref_dir_path() == DEFAULT_REF_DIR
    res = client.get("/api/ref/6542")
    assert not (res.status_code == 200 and res.json() == {"from": "cwd"})


def test_ディレクトリは配らない(small_ref_dir: Path) -> None:
    (small_ref_dir / "6543.json").mkdir()
    res = client.get("/api/ref/6543")
    assert res.status_code == 404
    assert "見つかりません" in res.json()["detail"]


def test_404にはキャッシュの指示を付けない(small_ref_dir: Path) -> None:
    # 無いファイルが後からできるので、404 を共有キャッシュに残させない
    res = client.get("/api/ref/6543")
    assert res.status_code == 404
    assert "max-age" not in res.headers.get("cache-control", "")


def test_既定の置き場所はリポジトリのdata_out_ref() -> None:
    # REPO_ROOT の段数が1つずれても parts の末尾は変わらないので、実在するディレクトリで確かめる
    assert DEFAULT_REF_DIR == REPO_ROOT / "data" / "out" / "ref"
    assert (REPO_ROOT / "data" / "pyproject.toml").is_file()
    assert (REPO_ROOT / "server" / "pyproject.toml").is_file()
