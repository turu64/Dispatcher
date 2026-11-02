"""実データ(data/raw/ に置いた e-Stat・国土数値情報)での確認。ファイルが無ければスキップする。"""

import math
from pathlib import Path

import pytest

from dispatcher_data.build import MissingSourceError, build_refs, find_sources
from dispatcher_data.did import load_did_geojson
from dispatcher_data.estat import read_population
from dispatcher_data.mesh import mesh_bounds
from dispatcher_data.stations import distance_m, load_station_parts, merge_stations

REAL_RAW = Path(__file__).resolve().parents[1] / "raw"
MESH1 = "6542"


@pytest.fixture(scope="module")
def sources():
    try:
        src = find_sources(REAL_RAW)
    except MissingSourceError as e:
        pytest.skip(f"実データがありません: {e}")
    if not any(p.name.endswith(f"Q{MESH1}.txt") for p in src.population_files):
        pytest.skip(f"1次メッシュ {MESH1} の人口データがありません")
    return src


@pytest.fixture(scope="module")
def did_areas(sources):
    return load_did_geojson(sources.did_file)


@pytest.fixture(scope="module")
def ref_6542(sources, did_areas):
    tables = [read_population(p) for p in sources.population_files if p.name.endswith(f"Q{MESH1}.txt")]
    stations = merge_stations(load_station_parts(sources.station_file))
    return build_refs(tables, did_areas, stations, [MESH1])[MESH1]


def test_6542の人口は数十万人(ref_6542):
    total = sum(ref_6542["pop250"].values())
    # 旭川市(約 33 万人)と周辺の町
    assert 300_000 < total < 700_000
    assert all(len(k) == 10 and k.startswith(MESH1) for k in ref_6542["pop250"])


def test_旭川駅が入る(ref_6542):
    asahikawa = [s for s in ref_6542["stations"] if s["name"] == "旭川" and s["operator"] == "北海道旅客鉄道"]
    assert len(asahikawa) == 1
    s = asahikawa[0]
    assert "函館線" in s["line"]
    assert distance_m((s["lat"], s["lon"]), (43.7628, 142.3587)) < 300


def test_DIDのセルは数千(ref_6542):
    assert 2_000 < len(ref_6542["did125"]) < 20_000


def test_DIDのセルの面積はA16の面積とほぼ同じ(ref_6542, did_areas):
    # 緯度経度の取り違えやセルの大きさの誤りを見つける
    b = mesh_bounds(MESH1)
    inside = [
        a
        for a in did_areas
        if b.south <= a.geometry.centroid.y < b.north and b.west <= a.geometry.centroid.x < b.east
    ]
    a16_km2 = sum(a.area_km2 or 0 for a in inside)
    lat = (b.south + b.north) / 2
    cell_km2 = (3.75 / 3600 * 111.32) * (5.625 / 3600 * 111.32 * math.cos(math.radians(lat)))
    assert len(ref_6542["did125"]) * cell_km2 == pytest.approx(a16_km2, rel=0.05)
