"""国土数値情報 人口集中地区(A16)から、中心が DID の中にある 8分の1地域メッシュ(11 桁)を求める。

配布物の GeoJSON(A16-20_01_DID.geojson、UTF-8、座標は JGD2011 の [経度, 緯度])を読む。
地物は Polygon と MultiPolygon。属性は A16_001(DIDid)、A16_003(市区町村名称)、A16_005(人口)、A16_006(面積 km²)など。

各多角形の外接矩形と1次メッシュの重なりに入るセルの中心だけを、shapely の contains_xy でまとめて判定する。
中心がちょうど DID の境界上にあるセルは外とみなす(contains の定義)。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import shapely
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from .mesh import (
    LAT_UNITS_PER_DEG,
    LON_ORIGIN_DEG,
    LON_UNITS_PER_DEG,
    code_from_index,
    code_to_index,
)


@dataclass
class DidArea:
    geometry: BaseGeometry
    did_id: str
    name: str
    area_km2: float | None


def parse_did_geojson(data: dict[str, Any]) -> list[DidArea]:
    if data.get("type") != "FeatureCollection":
        raise ValueError("DID の GeoJSON が FeatureCollection ではありません")
    areas: list[DidArea] = []
    for f in data.get("features", []):
        geom = f.get("geometry")
        if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        g = shape(geom)
        if g.is_empty:
            continue
        if not g.is_valid:
            g = shapely.make_valid(g)
        props = f.get("properties") or {}
        area = props.get("A16_006")
        areas.append(
            DidArea(
                geometry=g,
                did_id=str(props.get("A16_001", "")),
                name=str(props.get("A16_003", "")),
                area_km2=float(area) if isinstance(area, (int, float)) else None,
            )
        )
    return areas


def load_did_geojson(path: Path) -> list[DidArea]:
    with open(path, encoding="utf-8") as f:
        return parse_did_geojson(json.load(f))


def _index_range(lo_deg: float, hi_deg: float, units: int, origin: float) -> tuple[int, int]:
    """[lo, hi] の度の範囲に中心が入りうるセルの番号の範囲(終わりを含まない)。"""
    lo = math.floor((lo_deg - origin) * units) - 1
    hi = math.floor((hi_deg - origin) * units) + 2
    return lo, hi


def did_cells(areas: list[DidArea], mesh1: str) -> list[str]:
    """1次メッシュ mesh1 の中で、中心が DID の中にある 8分の1地域メッシュのコード(並べ替え済み)。"""
    if len(mesh1) != 4:
        raise ValueError(f"1次メッシュのコードは4桁です: {mesh1!r}")
    i0, j0, size = code_to_index(mesh1)
    i_end, j_end = i0 + size, j0 + size
    found: set[tuple[int, int]] = set()
    for area in areas:
        minx, miny, maxx, maxy = area.geometry.bounds
        a, b = _index_range(miny, maxy, LAT_UNITS_PER_DEG, 0.0)
        c, d = _index_range(minx, maxx, LON_UNITS_PER_DEG, LON_ORIGIN_DEG)
        a, b = max(a, i0), min(b, i_end)
        c, d = max(c, j0), min(d, j_end)
        if a >= b or c >= d:
            continue
        ii, jj = np.meshgrid(np.arange(a, b), np.arange(c, d), indexing="ij")
        lat = (ii + 0.5) / LAT_UNITS_PER_DEG
        lon = LON_ORIGIN_DEG + (jj + 0.5) / LON_UNITS_PER_DEG
        shapely.prepare(area.geometry)
        inside = shapely.contains_xy(area.geometry, lon, lat)
        for i, j in zip(ii[inside].tolist(), jj[inside].tolist(), strict=True):
            found.add((i, j))
    return sorted(code_from_index(i, j, 11) for i, j in found)
