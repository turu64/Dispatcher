"""参照データ(data/out/ref/{1次メッシュ}.json)を作る。

形は docs/interfaces-1103.md の「参照データ」のとおり。

    {
      "mesh1": "6542",
      "pop250": {"6542xxxxxx": 123},     4分の1地域メッシュ(10 桁)ごとの人口総数。0 人のセルは入れない
      "did125": ["6542xxxxxxx"],         中心が DID(2020 年)の中にある 8分の1地域メッシュ(11 桁)
      "stations": [{"name", "line", "operator", "lat", "lon"}],
      "sources": [...]
    }
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .did import DidArea, did_cells, load_did_geojson
from .estat import PopulationTable, read_population
from .mesh import mesh_code
from .stations import (
    CLOSED_STATIONS_CSV,
    ClosedResult,
    Station,
    exclude_closed,
    load_closed_stations,
    load_station_parts,
    merge_stations,
)

SOURCES = [
    "令和2年国勢調査 地域メッシュ統計(e-Stat)を加工して作成",
    "国土数値情報(人口集中地区 A16、鉄道 N02)を加工して作成",
]

# 元データのファイル名(data/raw/ からの相対。glob)
POPULATION_GLOB = "mesh/**/tblT001142Q*.txt"
DID_GLOB = "did/**/A16-*_DID.geojson"
STATION_GLOB = "rail/**/UTF-8/N02-*_Station.geojson"

COORD_DIGITS = 6


class MissingSourceError(Exception):
    """元データが見つからない。"""


@dataclass
class Sources:
    population_files: list[Path]
    did_file: Path
    station_file: Path


@dataclass
class BuildReport:
    """加工の結果(画面に出す件数)。"""

    population_rows: int = 0
    non_numeric: int = 0
    bad_key: int = 0
    # 廃止駅として除いた駅の線の数(N02 の線の単位)と、どの線にも一致しなかった廃止駅の行(「路線 駅名」)
    closed_removed: int = 0
    closed_unmatched: list[str] = field(default_factory=list)
    # 指定されたが、人口の元データに1行も無かった1次メッシュ(海だけ・範囲外など)。pop250 を空にして書く
    no_population: list[str] = field(default_factory=list)
    files: list[tuple[str, Path, int, dict[str, int]]] = field(default_factory=list)


def _latest(paths: list[Path]) -> Path | None:
    """ファイル名で並べて最後(年度の新しいもの)を返す。"""
    return sorted(paths, key=lambda p: p.name)[-1] if paths else None


def find_sources(raw: Path) -> Sources:
    population = sorted(raw.glob(POPULATION_GLOB))
    did = _latest(list(raw.glob(DID_GLOB)))
    station = _latest(list(raw.glob(STATION_GLOB)))
    missing = []
    if not population:
        missing.append(f"人口メッシュ(e-Stat の統計データ tblT001142Q????.txt)を {raw / 'mesh'} に")
    if did is None:
        missing.append(f"人口集中地区(A16-20_01_DID.geojson)を {raw / 'did'} に")
    if station is None:
        missing.append(f"鉄道(N02-??_GML/UTF-8/N02-??_Station.geojson)を {raw / 'rail'} に")
    if missing or did is None or station is None:
        raise MissingSourceError("元データがありません。次のファイルを展開して置いてください:\n- " + "\n- ".join(missing))
    return Sources(population_files=population, did_file=did, station_file=station)


def load_stations(station_file: Path, closed_csv: Path = CLOSED_STATIONS_CSV) -> tuple[list[Station], ClosedResult]:
    """N02 の駅を読み、廃止された駅の線を除いてから、駅をまとめる。"""
    closed = exclude_closed(load_station_parts(station_file), load_closed_stations(closed_csv))
    return merge_stations(closed.kept), closed


def station_json(s: Station) -> dict[str, Any]:
    return {
        "name": s.name,
        "line": s.line,
        "operator": s.operator,
        "lat": round(s.lat, COORD_DIGITS),
        "lon": round(s.lon, COORD_DIGITS),
    }


def make_ref(mesh1: str, pop: dict[str, int], did: list[str], stations: list[Station]) -> dict[str, Any]:
    """1次メッシュ1つ分の参照データ。"""
    return {
        "mesh1": mesh1,
        "pop250": {k: pop[k] for k in sorted(pop) if pop[k] > 0},
        "did125": sorted(did),
        "stations": [
            station_json(s) for s in sorted(stations, key=lambda s: (s.name, s.operator, s.lat, s.lon))
        ],
        "sources": list(SOURCES),
    }


def merge_population(tables: list[PopulationTable]) -> dict[str, dict[str, int]]:
    """1次メッシュごとの人口(10 桁のコード → 人口)。"""
    by_mesh1: dict[str, dict[str, int]] = {}
    for t in tables:
        for code, n in t.pop.items():
            cells = by_mesh1.setdefault(code[:4], {})
            if code in cells:
                raise ValueError(f"同じ 4分の1地域メッシュが2つのファイルにあります: {code}")
            cells[code] = n
    return by_mesh1


def build_refs(
    tables: list[PopulationTable],
    did_areas: list[DidArea],
    stations: list[Station],
    mesh1_list: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """1次メッシュごとの参照データ。mesh1_list が無ければ、人口のある1次メッシュすべて。

    mesh1_list で指定した1次メッシュは、人口・DID・駅のどれが無くても(海だけ・範囲外でも)必ず作る。
    web は参照データが1つでも 404 だと全体を使わないため、無いものは空の pop250・did125・stations にする。
    """
    pop = merge_population(tables)
    targets = sorted(mesh1_list) if mesh1_list else sorted(pop)
    stations_by_mesh1: dict[str, list[Station]] = {}
    for s in stations:
        stations_by_mesh1.setdefault(mesh_code(s.lat, s.lon, 4), []).append(s)
    return {
        m: make_ref(m, pop.get(m, {}), did_cells(did_areas, m), stations_by_mesh1.get(m, []))
        for m in targets
    }


def write_refs(refs: dict[str, dict[str, Any]], out_dir: Path) -> list[tuple[str, Path, int]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for mesh1, ref in refs.items():
        path = out_dir / f"{mesh1}.json"
        text = json.dumps(ref, ensure_ascii=False, separators=(",", ":"))
        path.write_text(text + "\n", encoding="utf-8")
        written.append((mesh1, path, path.stat().st_size))
    return written


def run(
    raw: Path,
    out_dir: Path,
    mesh1_list: list[str] | None = None,
    closed_csv: Path = CLOSED_STATIONS_CSV,
) -> BuildReport:
    """元データを読んで、参照データを書き出す。"""
    src = find_sources(raw)
    tables = [read_population(p) for p in src.population_files]
    did_areas = load_did_geojson(src.did_file)
    stations, closed = load_stations(src.station_file, closed_csv)
    refs = build_refs(tables, did_areas, stations, mesh1_list)
    report = BuildReport(
        population_rows=sum(t.rows for t in tables),
        non_numeric=sum(t.non_numeric for t in tables),
        bad_key=sum(t.bad_key for t in tables),
        closed_removed=len(closed.removed),
        closed_unmatched=[f"{c.line} {c.name}" for c in closed.unmatched],
        no_population=sorted(set(refs) - {code[:4] for t in tables for code in t.pop}),
    )
    for mesh1, path, size in write_refs(refs, out_dir):
        ref = refs[mesh1]
        counts = {
            "pop250": len(ref["pop250"]),
            "人口": sum(ref["pop250"].values()),
            "did125": len(ref["did125"]),
            "stations": len(ref["stations"]),
        }
        report.files.append((mesh1, path, size, counts))
    return report
