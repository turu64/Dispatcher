"""参照データの加工(順6)の検証。実装とは別の方法で作った値と突き合わせる。

- 手作りのデータ:境界にそろえる幅(web の mesh.ts と同じ約 0.1mm)、コードの形の確認
- 実データ(data/raw/ に無ければスキップ):
  - e-Stat の境界データ(estat_mesh_boundary_250m_6542.zip)と mesh_bounds の突き合わせ
  - 1次メッシュ全体の総当たりと did_cells の突き合わせ
  - 秘匿処理で人口総数が合算されていないことを、年齢別の列から確かめる
  - 駅のまとめ方が線の順に左右されないこと
"""

from __future__ import annotations

import csv
import io
import struct
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np
import pytest
import shapely

from dispatcher_data import main
from dispatcher_data.build import MissingSourceError, build_refs, find_sources
from dispatcher_data.did import did_cells, load_did_geojson
from dispatcher_data.estat import parse_population, read_population
from dispatcher_data.mesh import (
    code_from_index,
    code_to_index,
    lat_index,
    lon_index,
    mesh_bounds,
    mesh_code,
)
from dispatcher_data.stations import distance_m, load_station_parts, merge_stations

REAL_RAW = Path(__file__).resolve().parents[1] / "raw"

# 緯度 1度・経度 1度あたりのメートル(北緯 44度付近の目安)
M_PER_DEG_LAT = 111_100.0


# ---- 手作りのデータ ----


def test_境界から0_1mm未満の値は境界にそろえる_webのmesh_tsと同じ幅():
    # web/src/reach/mesh.ts は SNAP = 1e-6(1行・1列に対する割合、約 0.1mm)。同じ点は同じセルにする
    i = 42003
    j = 42 * 640 + 5
    lat_005mm = i / 960 - 0.05e-3 / M_PER_DEG_LAT  # 境界の 0.05mm 南
    assert lat_index(lat_005mm) == i
    lon_005mm = 100 + j / 640 - 0.05e-3 / (M_PER_DEG_LAT * 0.72)  # 境界の 0.05mm 西
    assert lon_index(lon_005mm) == j
    # 1mm 離れていれば隣のセル
    assert lat_index(i / 960 - 1e-3 / M_PER_DEG_LAT) == i - 1
    assert lon_index(100 + j / 640 - 1e-3 / (M_PER_DEG_LAT * 0.72)) == j - 1


def test_全角数字のメッシュコードは受け付けない():
    with pytest.raises(ValueError):
        code_to_index("６５４２")
    with pytest.raises(ValueError):
        code_to_index("６５４２０００００１１")


def test_コマンド_全角数字の1次メッシュはエラー(tmp_path: Path):
    with pytest.raises(SystemExit):
        main(["--raw", str(tmp_path), "--out", str(tmp_path / "ref"), "--mesh1", "６５４２"])
    assert not (tmp_path / "ref").exists()


def test_桁の値が地域メッシュとして不正なコードは飛ばす():
    text = (
        "KEY_CODE,HTKSYORI,T001142001\r\n"
        ",,\r\n"
        "6542000015,0,5\r\n"  # 分割地域メッシュの数字は 1〜4
        "6542800011,0,6\r\n"  # 2次メッシュの数字は 0〜7
        "６５４２０００００１１,0,7\r\n"  # 全角数字
        "6542000011,0,2\r\n"
    )
    t = parse_population(text)
    assert t.bad_key == 3
    assert t.pop == {"6542000011": 2}


def test_人口総数が全角や上付きの数字でも落ちない():
    text = "KEY_CODE,HTKSYORI,T001142001\r\n,,\r\n6542000011,0,²\r\n6542000012,0,3\r\n"
    t = parse_population(text)
    assert t.non_numeric == 1
    assert t.pop == {"6542000012": 3}


# ---- 実データ ----


@pytest.fixture(scope="module")
def sources():
    try:
        return find_sources(REAL_RAW)
    except MissingSourceError as e:
        pytest.skip(f"実データがありません: {e}")


@pytest.fixture(scope="module")
def did_areas(sources):
    return load_did_geojson(sources.did_file)


def _population_file(sources, mesh1: str) -> Path:
    for p in sources.population_files:
        if p.name.endswith(f"Q{mesh1}.txt"):
            return p
    pytest.skip(f"1次メッシュ {mesh1} の人口データがありません")


def _read_dbf(data: bytes) -> list[dict[str, str]]:
    nrec = struct.unpack("<I", data[4:8])[0]
    hlen, rlen = struct.unpack("<HH", data[8:12])
    fields = []
    pos = 32
    while data[pos] != 0x0D:
        name = data[pos : pos + 11].split(b"\0")[0].decode("ascii")
        fields.append((name, data[pos + 16]))
        pos += 32
    rows = []
    for r in range(nrec):
        off = hlen + r * rlen + 1
        row = {}
        for name, flen in fields:
            row[name] = data[off : off + flen].decode("ascii", "replace").strip()
            off += flen
        rows.append(row)
    return rows


def _read_shp_bboxes(data: bytes) -> list[tuple[float, float, float, float] | None]:
    """シェープファイルの各図形の外接矩形 (西, 南, 東, 北)。"""
    pos = 100
    out: list[tuple[float, float, float, float] | None] = []
    while pos < len(data):
        _num, clen = struct.unpack(">ii", data[pos : pos + 8])
        content = data[pos + 8 : pos + 8 + clen * 2]
        pos += 8 + clen * 2
        if struct.unpack("<i", content[0:4])[0] == 0:
            out.append(None)
            continue
        out.append(struct.unpack("<4d", content[4:36]))
    return out


def test_e_Statの境界データと250mメッシュの範囲が一致する(sources):
    # web/src/reach/mesh.verify.test.ts が取得した e-Stat の境界データ(4分の1地域メッシュ、6542)
    path = REAL_RAW / "mesh" / "estat_mesh_boundary_250m_6542.zip"
    if not path.exists():
        pytest.skip(f"{path} がありません")
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        dbf = z.read(next(n for n in names if n.lower().endswith(".dbf")))
        shp = z.read(next(n for n in names if n.lower().endswith(".shp")))
    rows = _read_dbf(dbf)
    boxes = _read_shp_bboxes(shp)
    assert len(rows) == len(boxes) == 102_400
    codes = set()
    for row, box in zip(rows, boxes, strict=True):
        code = row["KEY_CODE"]
        codes.add(code)
        assert box is not None
        b = mesh_bounds(code)
        west, south, east, north = box
        assert (b.west, b.south, b.east, b.north) == pytest.approx((west, south, east, north), abs=1e-9), code
        # 境界データの南西の角の値(浮動小数の誤差を含む)から、同じコードに戻る
        assert mesh_code(south, west, 10) == code
    # 人口のキーは、すべて e-Stat の 250m メッシュのコード
    pop = read_population(_population_file(sources, "6542")).pop
    assert set(pop) <= codes


@pytest.mark.parametrize("mesh1", ["6541", "6542"])
def test_DIDのセルは1次メッシュ全体の総当たりと一致する(sources, did_areas, mesh1):
    # did_cells は多角形ごとの外接矩形で絞ってから判定する。絞り方の誤りを、絞らない判定と比べて見つける
    union = shapely.union_all([a.geometry for a in did_areas])
    shapely.prepare(union)
    i0, j0, size = code_to_index(mesh1)
    ii, jj = np.meshgrid(np.arange(i0, i0 + size), np.arange(j0, j0 + size), indexing="ij")
    inside = shapely.contains_xy(union, 100 + (jj + 0.5) / 640, (ii + 0.5) / 960)
    brute = sorted(code_from_index(i, j, 11) for i, j in zip(ii[inside].tolist(), jj[inside].tolist(), strict=True))
    assert len(brute) > 1000
    assert did_cells(did_areas, mesh1) == brute


def test_秘匿対象の人口総数は合算先に足されていない(sources):
    # 合算先(HTKSYORI=1)の年齢別の列には秘匿対象の人が足されている。人口総数が合算先自身だけの値なら
    # 「0〜14歳 + 15歳以上 = 合算先の人口総数 + 秘匿対象の人口総数」(年齢不詳の分だけ左が小さいことはある)
    exact = short = over = 0
    for p in sources.population_files:
        rows = list(csv.reader(io.StringIO(p.read_bytes().decode("cp932"), newline="")))
        h = rows[0]
        key, hide, dest, total, a014, a15 = (
            h.index(c) for c in ("KEY_CODE", "HTKSYORI", "HTKSAKI", "T001142001", "T001142004", "T001142007")
        )
        hidden_total: dict[str, int] = defaultdict(int)
        for r in rows[2:]:
            if r[hide] == "2":
                hidden_total[r[dest]] += int(r[total])
        for r in rows[2:]:
            if r[hide] != "1" or not (r[a014].isdigit() and r[a15].isdigit()):
                continue
            ages = int(r[a014]) + int(r[a15])
            expected = int(r[total]) + hidden_total[r[key]]
            if ages == expected:
                exact += 1
            elif ages < expected:
                short += 1
            else:
                over += 1
    assert over == 0
    assert exact > 1000
    assert exact > 10 * short


def test_駅のまとめ方は線の順に左右されない(sources):
    # 同じ駅にまとめた線どうしは 1,000m 以内、同じ駅名・同じ会社の別の駅とは 1,000m より離れている。
    # これが成り立てば、先にまとめた駅から近いものを足していく方法でも、線の順によらず同じ結果になる
    parts = load_station_parts(sources.station_file)
    merged = merge_stations(parts)
    assert len(merge_stations(list(reversed(parts)))) == len(merged)
    by_key = defaultdict(list)
    for s in merged:
        by_key[(s.name, s.operator)].append(s)
        for a in s.points:
            for b in s.points:
                assert distance_m(a, b) <= 1000, s.name
    for key, group in by_key.items():
        for x in range(len(group)):
            for y in range(x + 1, len(group)):
                d = min(distance_m(a, b) for a in group[x].points for b in group[y].points)
                assert d > 1000, key


@pytest.mark.xfail(
    strict=True,
    reason="留萌線 深川〜石狩沼田は 2026-03-31 に廃止されたが、N02-25(2025-12-31 時点)に残っている。扱いは指示役が決める",
)
def test_2026年4月より前に廃止された駅は入らない(sources, did_areas):
    tables = [read_population(_population_file(sources, m)) for m in ("6541", "6542")]
    stations = merge_stations(load_station_parts(sources.station_file))
    refs = build_refs(tables, did_areas, stations, ["6541", "6542"])
    names = {s["name"] for ref in refs.values() for s in ref["stations"]}
    assert not names & {"石狩沼田", "秩父別", "北秩父別", "北一已"}
