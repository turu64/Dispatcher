import math
from pathlib import Path

import pytest

from dispatcher_data.stations import distance_m, line_midpoint, load_station_parts, merge_stations


def _stations(fixture_raw: Path):
    path = fixture_raw / "rail" / "N02-25_GML" / "UTF-8" / "N02-25_Station.geojson"
    return merge_stations(load_station_parts(path))


def test_2点の線の中点():
    lat, lon = line_midpoint([[[142.35949, 43.76299], [142.35635, 43.76389]]])
    assert lat == pytest.approx((43.76299 + 43.76389) / 2)
    assert lon == pytest.approx((142.35949 + 142.35635) / 2)


def test_折れ線の中点は長さの半分の位置():
    # 北へ 0.001 度、東へ 0.004 度の L 字。経度は緯度に応じて縮めて測る
    coords = [[142.4600, 44.3500], [142.4600, 44.3510], [142.4640, 44.3510]]
    lat0 = sum(c[1] for c in coords) / 3
    kx = math.cos(math.radians(lat0))
    north, east = 0.001, 0.004 * kx
    half = (north + east) / 2
    # 半分の位置は東向きの区間の途中
    expected_lon = 142.4600 + (half - north) / kx
    lat, lon = line_midpoint([coords])
    assert lat == pytest.approx(44.3510)
    assert lon == pytest.approx(expected_lon)


def test_複数の線_MultiLineString_の中点():
    lat, lon = line_midpoint([[[142.0, 43.0], [142.0, 43.001]], [[142.0, 43.002], [142.0, 43.003]]])
    # 長さの合計 0.002 度の半分は、1本目の終わり
    assert lat == pytest.approx(43.001)
    assert lon == pytest.approx(142.0)


def test_同じ駅名_同じ会社の線は1つにまとめる(fixture_raw: Path):
    stations = _stations(fixture_raw)
    jr = [s for s in stations if s.name == "旭川" and s.operator == "北海道旅客鉄道"]
    assert len(jr) == 1
    asahikawa = jr[0]
    assert asahikawa.line == "宗谷線・函館線・富良野線"
    assert len(asahikawa.points) == 3
    # 代表点は各線の中点の平均
    mids = [(43.76344, 142.35792), (43.76344, 142.35792), (43.76229, 142.35822)]
    assert asahikawa.lat == pytest.approx(sum(m[0] for m in mids) / 3)
    assert asahikawa.lon == pytest.approx(sum(m[1] for m in mids) / 3)


def test_会社が違えばまとめない(fixture_raw: Path):
    stations = _stations(fixture_raw)
    names = [(s.name, s.operator) for s in stations]
    assert ("旭川", "架空鉄道") in names
    assert names.count(("旭川", "北海道旅客鉄道")) == 1


def test_同じ名前_同じ会社でも離れた駅はまとめない(fixture_raw: Path):
    stations = _stations(fixture_raw)
    okubo = [s for s in stations if s.name == "大久保"]
    assert len(okubo) == 2
    assert distance_m((okubo[0].lat, okubo[0].lon), (okubo[1].lat, okubo[1].lon)) > 100_000
    assert {s.line for s in okubo} == {"中央線", "奥羽線"}


def test_距離():
    # 緯度 1 度はおよそ 111km
    assert distance_m((43.0, 142.0), (44.0, 142.0)) == pytest.approx(111_195, rel=1e-3)
