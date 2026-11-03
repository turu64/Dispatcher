"""前提情報の調査の対象(事業者・学校・病院・診療所)の参照データ。

手作りの小さな元データ(tests/fixtures/facilities_raw/。data/raw/ と同じ並び)と、
data/raw/ に実データがあるときの確認(無ければスキップ)。
"""

import hashlib
import json
from pathlib import Path

import pytest

from dispatcher_data import build, facilities
from dispatcher_data.facilities import (
    FacilityDataError,
    clinic_target_id,
    load_medical,
    load_municipalities,
    load_operators,
    load_schools,
    normalize_text,
    operator_target_id,
    school_target_id,
)

FIXTURE_FAC = Path(__file__).resolve().parent / "fixtures" / "facilities_raw"
REAL_RAW = Path(__file__).resolve().parents[1] / "raw"
FIELD_ORDER = ["target_id", "kind", "name", "municipality", "lat", "lon", "detail"]


@pytest.fixture(scope="module")
def muni() -> facilities.Municipalities:
    return load_municipalities()


def _by_id(items: list[facilities.Facility]) -> dict[str, facilities.Facility]:
    return {f.target_id: f for f in items}


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# --- target_id -------------------------------------------------------------


def test_target_idの形():
    assert school_target_id("C101220400011", "00") == "P29:C101220400011"
    assert school_target_id("C101220400011", "") == "P29:C101220400011"
    assert school_target_id("F101110100010", "07") == "P29:F101110100010-07"
    assert operator_target_id("道北バス（株）") == "P11:道北バス(株)"
    assert operator_target_id(" ジェイ・アール　北海道バス(株) ") == "P11:ジェイ・アール北海道バス(株)"


def test_医療機関のtarget_idは名称と所在地のSHA1の先頭12桁():
    # 値は shasum で別に求めた: printf '%s' '旭川テスト病院|旭川市1条通1丁目' | shasum
    assert clinic_target_id("旭川テスト病院", "旭川市1条通1丁目") == "P04:577e541e898d"
    # NFKC で整えるので、全角の数字・空白の違いは同じ ID になる
    assert clinic_target_id("旭川テスト病院", "旭川市１条通１丁目") == "P04:577e541e898d"
    assert clinic_target_id(" 旭川テスト　病院", "旭川市 1条通1丁目") == "P04:577e541e898d"
    assert clinic_target_id("旭川テスト病院", "旭川市1条通2丁目") != "P04:577e541e898d"
    assert normalize_text(None) == ""


# --- 市区町村 ---------------------------------------------------------------


def test_所在地から市区町村を引く(muni: facilities.Municipalities):
    of = muni.of_address
    assert of("旭川市1条通1丁目") == "旭川市"
    assert of("北海道旭川市1条通1丁目") == "旭川市"
    assert of("標津郡中標津町りんどう町5番地6") == "中標津町"
    assert of("上川郡東川町北町1丁目") == "東川町"
    assert of("余市郡余市町黒川町19丁目1番地1") == "余市町"  # 余市郡の「市」に引きずられない
    assert of("札幌市中央区南2条西2丁目") == "札幌市中央区"  # 区まで(長い名前が先)
    assert of("小清水町") == "小清水町"
    assert of("谷地頭町27番18号") == ""  # 市町村名が無い所在地は空
    assert of("") == ""


def test_行政区域コードの一覧(muni: facilities.Municipalities):
    assert muni.by_code["01204"] == "旭川市"
    assert muni.by_code["01101"] == "札幌市中央区"
    assert muni.by_code["01395"] == "ニセコ町"  # 末尾の読み仮名は除いてある
    assert all(code.startswith("01") and len(code) == 5 for code in muni.by_code)
    assert "01000" not in muni.by_code


# --- 学校 --------------------------------------------------------------------


def test_学校(muni: facilities.Municipalities):
    res = load_schools(FIXTURE_FAC / "school/P29-23_01_GML/P29-23_01.geojson", muni)
    by_id = _by_id(res.facilities)
    # 休校中(7)・座標が無い・範囲外は入らない。開校の情報が 9(定義に無い)のものは入れる
    assert sorted(by_id) == [
        "P29:C101110100055",
        "P29:C101220400011",
        "P29:F101220400022-01",
        "P29:F101220400022-02",
        "P29:K101222100044",
    ]
    assert res.skipped == {"休校中": 1, "座標・形が不正": 2}

    high = by_id["P29:C101220400011"]
    assert (high.kind, high.name, high.municipality) == ("school", "旭川テスト高等学校", "旭川市")
    assert (high.lat, high.lon) == (43.77, 142.36)
    assert high.detail == {
        "school_type": "高等学校",
        "school_type_code": "16004",
        "school_code": "C101220400011",
        "management": "都道府県",
        "open_status": "開校中",
        "address": "北海道旭川市1条通1丁目",
    }
    # キャンパスが違えば別の対象。学校コードは detail に残る。メモがあれば名前に添える
    c1, c2 = by_id["P29:F101220400022-01"], by_id["P29:F101220400022-02"]
    assert (c1.name, c2.name) == ("旭川テスト大学", "旭川テスト大学(医学部キャンパス)")
    assert c1.detail["campus"] == "01" and c2.detail["campus"] == "02"
    assert c1.detail["school_code"] == c2.detail["school_code"] == "F101220400022"
    assert c1.detail["school_type"] == "大学"
    assert "campus" not in high.detail
    assert by_id["P29:K101222100044"].detail["open_status"] == "不明"
    assert by_id["P29:C101110100055"].municipality == "札幌市中央区"


# --- 医療機関 ------------------------------------------------------------------


def test_病院と診療所は病床数で分ける(muni: facilities.Municipalities):
    res = load_medical(FIXTURE_FAC / "medical/P04-20_01_GML/P04-20_01.geojson", muni)
    by_name = {f.name: f for f in res.facilities}
    hospital = by_name["旭川テスト病院"]
    assert hospital.kind == "hospital"
    assert hospital.target_id == "P04:577e541e898d"
    assert hospital.detail == {"beds": 60, "emergency": True, "disaster_base": "地域", "address": "旭川市1条通1丁目"}
    assert hospital.municipality == "旭川市"

    clinic = by_name["東川テスト医院"]
    assert (clinic.kind, clinic.detail["beds"], clinic.municipality) == ("clinic", 19, "東川町")
    assert clinic.detail["emergency"] is False and clinic.detail["disaster_base"] is None
    assert by_name["余市テスト医院"].municipality == "余市町"
    assert by_name["札幌テスト内科"].municipality == "札幌市中央区"
    assert by_name["所在地に市が無い医院"].municipality == ""

    assert "旭川テスト歯科" not in by_name  # 歯科診療所は入れない
    # 同じ名称・同じ所在地(NFKC で同じ)の2行目は ID が重なるので飛ばす
    assert res.skipped == {"歯科診療所": 1, "target_id の重複": 1}
    assert res.notes == {"市区町村を引けない(施設は入れた)": 1}


def test_20床がちょうど境目(muni: facilities.Municipalities, tmp_path: Path):
    def feature(name: str, beds: int) -> dict:
        return {
            "type": "Feature",
            "properties": {"P04_001": 1, "P04_002": name, "P04_003": "旭川市1条", "P04_008": beds, "P04_009": 9, "P04_010": 9},
            "geometry": {"type": "Point", "coordinates": [142.36, 43.77]},
        }

    path = tmp_path / "P04-x.geojson"
    path.write_text(json.dumps({"features": [feature("十九", 19), feature("二十", 20)]}), encoding="utf-8")
    kinds = {f.name: f.kind for f in load_medical(path, muni).facilities}
    assert kinds == {"十九": "clinic", "二十": "hospital"}


# --- 事業者 --------------------------------------------------------------------


def test_事業者は停留所のある1次メッシュごとに1件(muni: facilities.Municipalities):
    res = load_operators(FIXTURE_FAC / "busstop/P11-22_01_GML/P11-22_01.xml", muni)
    assert res.skipped == {"座標が無い・不正": 2}
    ops = [f for f in res.facilities if f.target_id == "P11:テスト電気軌道(株)"]
    assert [round(f.lat, 2) for f in ops] == [43.77, 44.37]  # 1次メッシュ 6542 と 6642 の重心
    assert [round(f.lon, 2) for f in ops] == [142.37, 142.47]
    assert all(f.kind == "operator" and f.name == "テスト電気軌道(株)" and f.municipality == "" for f in ops)
    assert [f.detail["stops"] for f in ops] == [4, 4]
    assert [f.detail["stops_here"] for f in ops] == [2, 2]
    assert ops[0].detail["bbox"] == [43.76, 142.36, 43.78, 142.38]  # 南・西・北・東

    # 事業者名が自治体の名前のとき(コミュニティバス)は市区町村にその名前を入れる
    (town,) = [f for f in res.facilities if f.target_id == "P11:東川町"]
    assert (town.municipality, town.detail["stops"], town.detail["stops_here"]) == ("東川町", 1, 1)
    assert (town.lat, town.lon) == (43.7, 142.5)


P11_HEAD = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<ksj:Dataset xmlns:ksj="http://nlftp.mlit.go.jp/ksj/schemas/ksj-app" '
    'xmlns:gml="http://schemas.opengis.net/gml/3.2.1" xmlns:xlink="http://www.w3.org/1999/xlink">'
)


def _p11(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "P11-small.xml"
    path.write_text(P11_HEAD + body + "</ksj:Dataset>", encoding="utf-8")
    return path


def _point(pid: str, lat: float, lon: float) -> str:
    return f'<gml:Point gml:id="{pid}"><gml:pos>{lat} {lon}</gml:pos></gml:Point>'


def _stop(sid: str, ref: str, name: str, operator: str, routes: list[str]) -> str:
    bri = "".join(f"<ksj:bri><ksj:brn>{r}</ksj:brn><ksj:brt>1</ksj:brt></ksj:bri>" for r in routes)
    return (
        f'<ksj:BusStop gml:id="{sid}"><ksj:loc xlink:href="#{ref}"/><ksj:bsn>{name}</ksj:bsn>'
        f"<ksj:boc>{operator}</ksj:boc>{bri}</ksj:BusStop>"
    )


def test_停留所ごとの位置と停留所名と系統名(muni: facilities.Municipalities, tmp_path: Path):
    path = _p11(
        tmp_path,
        _point("n1", 43.7700001, 142.3600004)
        + _point("n2", 43.78, 142.37)
        + _point("n3", 43.79, 142.38)
        # 系統(bri)が3つ。重複と空の系統名は除き、名前の順に並べる。全角の数字は NFKC で整える
        + _stop("bs1", "n1", "旭川駅前", "テスト電気軌道（株）", ["2番", "１番", "2番", " "])
        # 系統の無い停留所(停留所としては入れ、系統名は空)
        + _stop("bs2", "n2", "大学前", "テスト電気軌道（株）", [])
        # 座標の無い停留所(位置の参照が無い)は飛ばす
        + _stop("bs3", "n99", "位置の無い停留所", "テスト電気軌道（株）", ["1番"])
        # 同じ位置・同じ名前でも事業者が違えば別の停留所(系統名をその事業者のものとして数えるため)
        + _stop("bs4", "n1", "旭川駅前", "ほかのバス", ["快速"])
        # 同じ事業者が同じ停留所を二重に載せているときは1件にまとめ、系統名を合わせる
        + _stop("bs5", "n1", "旭川駅前", "テスト電気軌道(株)", ["3番"])
        # 停留所名が空なら、事業者には数えるが停留所には入れない
        + _stop("bs6", "n3", "", "テスト電気軌道（株）", ["1番"]),
    )
    res = load_operators(path, muni)
    assert res.skipped == {"座標が無い・不正": 1}
    assert res.notes == {"停留所名が空(事業者には数え、停留所の一覧には入れない)": 1}
    assert [b.to_json() for b in res.busstops] == [
        {"name": "旭川駅前", "lat": 43.77, "lon": 142.36, "operators": ["P11:ほかのバス"], "routes": ["快速"]},
        {
            "name": "旭川駅前",
            "lat": 43.77,
            "lon": 142.36,
            "operators": ["P11:テスト電気軌道(株)"],
            "routes": ["1番", "2番", "3番"],
        },
        {"name": "大学前", "lat": 43.78, "lon": 142.37, "operators": ["P11:テスト電気軌道(株)"], "routes": []},
    ]
    # 事業者の数え方は今までどおり(停留所名の空のものも事業者の停留所には数える)
    (op,) = [f for f in res.facilities if f.target_id == "P11:テスト電気軌道(株)"]
    assert op.detail["stops"] == 4
    # 停留所の target_id は事業者の target_id と同じ形
    ids = {f.target_id for f in res.facilities}
    assert {o for b in res.busstops for o in b.operators} <= ids


def test_GMLのDOCTYPEは読まない(muni: facilities.Municipalities, tmp_path: Path):
    path = tmp_path / "P11-bad.xml"
    path.write_text(
        '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', encoding="utf-8"
    )
    with pytest.raises(FacilityDataError, match="DOCTYPE"):
        load_operators(path, muni)


def test_壊れた元データはFacilityDataError(muni: facilities.Municipalities, tmp_path: Path):
    bad_xml = tmp_path / "P11-bad.xml"
    bad_xml.write_text("<a><b></a>", encoding="utf-8")
    with pytest.raises(FacilityDataError):
        load_operators(bad_xml, muni)
    bad_json = tmp_path / "P29-bad.geojson"
    bad_json.write_text("{", encoding="utf-8")
    with pytest.raises(FacilityDataError):
        load_schools(bad_json, muni)
    no_features = tmp_path / "P04-bad.geojson"
    no_features.write_text('{"type":"FeatureCollection"}', encoding="utf-8")
    with pytest.raises(FacilityDataError):
        load_medical(no_features, muni)


# --- 書き出し ------------------------------------------------------------------


def test_1次メッシュごとにJSONを書く(tmp_path: Path):
    report = facilities.run(FIXTURE_FAC, tmp_path)
    assert sorted(report.sources) == ["P04", "P11", "P29"]
    assert report.missing == []
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "6240.json",  # 函館(所在地に市が無い医院)
        "6440.json",  # 余市
        "6441.json",  # 札幌
        "6542.json",  # 旭川
        "6642.json",  # 名寄
    ]
    ref = _read(tmp_path / "6542.json")
    assert list(ref) == ["mesh1", "facilities", "busstops", "sources"]
    assert ref["mesh1"] == "6542"
    assert ref["sources"] == facilities.SOURCES
    ids = [f["target_id"] for f in ref["facilities"]]
    assert ids == sorted(ids)
    assert all(list(f) == FIELD_ORDER for f in ref["facilities"])
    kinds = sorted({f["kind"] for f in ref["facilities"]})
    assert kinds == ["clinic", "hospital", "operator", "school"]
    # 2つの1次メッシュに停留所がある事業者は、両方のファイルに入る
    assert "P11:テスト電気軌道(株)" in ids
    assert "P11:テスト電気軌道(株)" in [f["target_id"] for f in _read(tmp_path / "6642.json")["facilities"]]
    # 緯度経度は小数6桁に丸める
    assert all(f["lat"] == round(f["lat"], 6) and f["lon"] == round(f["lon"], 6) for f in ref["facilities"])
    # 停留所は位置の1次メッシュのファイルにだけ入る(6542 に2つ、6642 に2つ、東川町の1つは 6542)
    assert ref["busstops"] == [
        {"name": "東川役場", "lat": 43.7, "lon": 142.5, "operators": ["P11:東川町"], "routes": ["東川線"]},
        {"name": "旭川駅前", "lat": 43.76, "lon": 142.36, "operators": ["P11:テスト電気軌道(株)"], "routes": ["1"]},
        {"name": "大学前", "lat": 43.78, "lon": 142.38, "operators": ["P11:テスト電気軌道(株)"], "routes": ["1"]},
    ]
    assert [b["name"] for b in _read(tmp_path / "6642.json")["busstops"]] == ["名寄駅前", "公園前"]
    # 停留所の無い1次メッシュは空の配列
    assert _read(tmp_path / "6441.json")["busstops"] == []
    assert dict(report.files[[f[0] for f in report.files].index("6542")][3])["busstop"] == 3


def test_同じ入力なら同じバイト列(tmp_path: Path):
    a, b = tmp_path / "a", tmp_path / "b"
    facilities.run(FIXTURE_FAC, a)
    facilities.run(FIXTURE_FAC, b)
    names = sorted(p.name for p in a.iterdir())
    assert names == sorted(p.name for p in b.iterdir())
    for name in names:
        assert (a / name).read_bytes() == (b / name).read_bytes()
    # target_id もすべて同じ
    ids_a = [f["target_id"] for n in names for f in _read(a / n)["facilities"]]
    ids_b = [f["target_id"] for n in names for f in _read(b / n)["facilities"]]
    assert ids_a == ids_b and ids_a


def test_target_idは1次メッシュのファイルの中で重ならない(tmp_path: Path):
    facilities.run(FIXTURE_FAC, tmp_path)
    for path in tmp_path.glob("*.json"):
        ids = [f["target_id"] for f in _read(path)["facilities"]]
        assert len(ids) == len(set(ids)), path.name


def test_1次メッシュを指定すると空でも書きほかは書かない(tmp_path: Path):
    report = facilities.run(FIXTURE_FAC, tmp_path, ["6542", "9999"])
    assert sorted(p.name for p in tmp_path.iterdir()) == ["6542.json", "9999.json"]
    empty = _read(tmp_path / "9999.json")
    assert empty["facilities"] == [] and empty["mesh1"] == "9999" and empty["sources"] == facilities.SOURCES
    assert empty["busstops"] == []
    assert report.outside_mesh1 > 0
    assert [f[0] for f in report.files] == ["6542", "9999"]


def test_元データが無ければ飛ばす(tmp_path: Path):
    # 3つとも無い: 何も書かず、例外にもならない
    raw = tmp_path / "raw"
    raw.mkdir()
    out = tmp_path / "out"
    report = facilities.run(raw, out)
    assert report.sources == {} and len(report.missing) == 3 and not out.exists()

    # 学校だけある: 学校の分だけ書き、無いものは report.missing に出る
    school_dir = raw / "school" / "P29-23_01_GML"
    school_dir.mkdir(parents=True)
    (school_dir / "P29-23_01.geojson").write_bytes(
        (FIXTURE_FAC / "school/P29-23_01_GML/P29-23_01.geojson").read_bytes()
    )
    report = facilities.run(raw, out)
    assert list(report.sources) == ["P29"] and len(report.missing) == 2
    kinds = {f["kind"] for p in out.glob("*.json") for f in _read(p)["facilities"]}
    assert kinds == {"school"}
    assert any("医療機関" in m for m in report.missing) and any("バス停留所" in m for m in report.missing)


def test_メタデータのXMLは元データに数えない(tmp_path: Path):
    raw = tmp_path / "raw"
    d = raw / "busstop" / "P11-22_01_GML"
    d.mkdir(parents=True)
    (d / "KS-META-P11-22_01.xml").write_text("<MD_Metadata/>", encoding="utf-8")
    assert facilities.run(raw, tmp_path / "out").sources == {}


def test_describeは件数を日本語で返す(tmp_path: Path):
    lines = facilities.describe(facilities.run(FIXTURE_FAC, tmp_path))
    text = "\n".join(lines)
    assert "P29 = P29-23_01.geojson" in text
    assert "歯科診療所 1 件を飛ばしました" in text
    assert "6542: " in text


# --- build.run から呼ぶ ---------------------------------------------------------


def test_buildのrunは施設の元データがあれば施設も書く(fixture_raw: Path, tmp_path: Path):
    # 施設の元データが無い fixture_raw では facilities/ を作らない(従来どおりの出力)
    out = tmp_path / "plain"
    report = build.run(fixture_raw, out)
    assert not (out / "facilities").exists()
    assert report.facility_report is not None and report.facility_report.sources == {}

    # 人口・DID・駅の元データ(fixture_raw)に施設の元データを足した置き場で、ref と facilities が並ぶ
    raw = tmp_path / "raw"
    raw.mkdir()
    for sub in ("mesh", "did", "rail"):
        (raw / sub).symlink_to(fixture_raw / sub)
    for sub in ("school", "medical", "busstop"):
        (raw / sub).symlink_to(FIXTURE_FAC / sub)
    out = tmp_path / "both"
    report = build.run(raw, out)
    assert (out / "6542.json").is_file() and (out / "facilities" / "6542.json").is_file()
    assert report.facility_report is not None and sorted(report.facility_report.sources) == ["P04", "P11", "P29"]
    # 参照データ側の形は変わらない
    assert list(_read(out / "6542.json")) == ["mesh1", "pop250", "did125", "stations", "sources"]


# --- 実データ(data/raw/ に置いてあるとき) ----------------------------------------


@pytest.fixture(scope="module")
def real_report(tmp_path_factory: pytest.TempPathFactory):
    out = tmp_path_factory.mktemp("facilities")
    try:
        report = facilities.run(REAL_RAW, out)
    except FacilityDataError as e:
        pytest.skip(f"実データを読めません: {e}")
    if sorted(report.sources) != ["P04", "P11", "P29"]:
        pytest.skip(f"施設の実データがそろっていません: {report.missing}")
    return out, report


def _real_all(out: Path) -> list[dict]:
    return [f for p in sorted(out.glob("*.json")) for f in _read(p)["facilities"]]


def test_実データの件数(real_report):
    out, report = real_report
    items = _real_all(out)
    by_kind: dict[str, int] = {}
    for f in items:
        by_kind[f["kind"]] = by_kind.get(f["kind"], 0) + 1
    assert by_kind["hospital"] == 550
    assert by_kind["clinic"] == 3464
    assert by_kind["school"] == 2824 - report.skipped["P29"].get("休校中", 0)
    assert len({f["target_id"] for f in items if f["kind"] == "operator"}) == 67
    assert report.skipped["P04"]["歯科診療所"] == 2889
    # 行政区域コードは全部引ける。医療機関の所在地が市町村名で始まらないものだけ空
    assert all(f["municipality"] for f in items if f["kind"] == "school")
    unresolved = sum(1 for f in items if f["kind"] in ("hospital", "clinic") and not f["municipality"])
    assert unresolved < 30


def test_実データのtarget_idは重ならない(real_report):
    out, _ = real_report
    non_operators = [f["target_id"] for f in _real_all(out) if f["kind"] != "operator"]
    assert len(non_operators) == len(set(non_operators))
    # 事業者は1次メッシュごとに1件。同じファイルの中では重ならない
    for path in out.glob("*.json"):
        ids = [f["target_id"] for f in _read(path)["facilities"]]
        assert len(ids) == len(set(ids)), path.name


def test_実データの病院は病床数20床以上(real_report):
    out, _ = real_report
    for f in _real_all(out):
        if f["kind"] == "hospital":
            assert f["detail"]["beds"] >= 20
        elif f["kind"] == "clinic":
            assert f["detail"]["beds"] < 20


def test_実データの北大のキャンパスは別の対象(real_report):
    out, _ = real_report
    campuses = [f for f in _real_all(out) if f["kind"] == "school" and f["name"].startswith("北海道大学")]
    assert len(campuses) == 15
    assert len({f["target_id"] for f in campuses}) == 15


def test_実データの医療機関のIDは名称と所在地から再計算できる(real_report):
    out, _ = real_report
    sample = [f for f in _real_all(out) if f["kind"] in ("hospital", "clinic")][:200]
    for f in sample:
        key = normalize_text(f["name"]) + "|" + normalize_text(f["detail"]["address"])
        assert f["target_id"] == "P04:" + hashlib.sha1(key.encode()).hexdigest()[:12]


def test_実データの停留所(real_report):
    out, report = real_report
    stops = [b for p in sorted(out.glob("*.json")) for b in _read(p)["busstops"]]
    # P11 の停留所 14,474 から、座標の不正なものと、同じ事業者の二重の登録(1件)を除いた数
    skipped = sum(report.skipped["P11"].values())
    assert len(stops) == 14474 - skipped - 1
    assert all(len(b["operators"]) == 1 and b["operators"][0].startswith("P11:") for b in stops)
    assert all(b["name"] and b["routes"] == sorted(set(b["routes"])) for b in stops)
    # 停留所の事業者は、どれも事業者の対象としてある
    operator_ids = {f["target_id"] for f in _real_all(out) if f["kind"] == "operator"}
    assert {b["operators"][0] for b in stops} <= operator_ids
