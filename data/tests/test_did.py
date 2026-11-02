from pathlib import Path

from dispatcher_data.did import load_did_geojson, did_cells, parse_did_geojson
from dispatcher_data.mesh import code_from_index

I0, J0 = 65 * 640, 42 * 640  # 1次メッシュ 6542 の南西の角
I_6642 = 66 * 640


def _cells(rows: range, cols: range, skip: set[tuple[int, int]] = frozenset()) -> set[str]:
    return {code_from_index(i, j, 11) for i in rows for j in cols if (i, j) not in skip}


def _areas(fixture_raw: Path):
    return load_did_geojson(fixture_raw / "did" / "A16-20_01_GML" / "A16-20_01_DID.geojson")


def test_中心がDIDの中にあるセルだけを選ぶ(fixture_raw: Path):
    cells = set(did_cells(_areas(fixture_raw), "6542"))
    rect = _cells(range(I0 + 10, I0 + 13), range(J0 + 20, J0 + 24))
    assert len(rect) == 12
    assert rect <= cells
    # 辺がセルの境界に乗っていても、外側のセルは入らない
    assert code_from_index(I0 + 9, J0 + 20, 11) not in cells
    assert code_from_index(I0 + 13, J0 + 20, 11) not in cells
    assert code_from_index(I0 + 10, J0 + 24, 11) not in cells
    assert code_from_index(I0 + 10, J0 + 19, 11) not in cells


def test_穴の中のセルは入らない(fixture_raw: Path):
    cells = set(did_cells(_areas(fixture_raw), "6542"))
    ring = _cells(range(I0 + 100, I0 + 105), range(J0 + 100, J0 + 105), skip={(I0 + 102, J0 + 102)})
    assert len(ring) == 24
    assert ring <= cells
    assert code_from_index(I0 + 102, J0 + 102, 11) not in cells


def test_1次メッシュの外のセルは入れない(fixture_raw: Path):
    areas = _areas(fixture_raw)
    south = set(did_cells(areas, "6542"))
    north = set(did_cells(areas, "6642"))
    straddle_s = _cells(range(I0 + 638, I0 + 640), range(J0 + 300, J0 + 302))
    straddle_n = _cells(range(I_6642, I_6642 + 2), range(J0 + 300, J0 + 302))
    assert straddle_s <= south
    assert north == straddle_n
    assert all(c.startswith("6542") for c in south)
    assert all(c.startswith("6642") for c in north)
    # 6542 の中は 12 + 24 + 4
    assert len(south) == 40
    # DID の無い1次メッシュは空
    assert did_cells(areas, "6543") == []


def test_結果は並べ替えた11桁のコード(fixture_raw: Path):
    cells = did_cells(_areas(fixture_raw), "6542")
    assert cells == sorted(cells)
    assert all(len(c) == 11 and c.isdigit() for c in cells)
    # 明示的な値でも確かめる(南西の角から 10 行・20 列目)
    # 3次は緯度 10//8=1・経度 20//8=2、2分の1は南東 2、4分の1は北西 3、8分の1は南西 1
    assert code_from_index(I0 + 10, J0 + 20, 11) == "65420012231"
    assert "65420012231" in cells


def test_面以外の地物は無視する():
    data = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [142.3, 43.7]}},
            {"type": "Feature", "properties": {}, "geometry": None},
        ],
    }
    assert parse_did_geojson(data) == []
