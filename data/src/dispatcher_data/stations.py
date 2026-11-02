"""国土数値情報 鉄道(N02)の駅を点にする。

配布物の GeoJSON(N02-25_GML/UTF-8/N02-25_Station.geojson、座標は JGD2011 の [経度, 緯度])を読む。
駅は鉄道路線の一部分(線)として収録されている。属性は次のとおり(国土数値情報の定義)。

- N02_001 鉄道区分、N02_002 事業者種別、N02_003 路線名、N02_004 運営会社、N02_005 駅名
- N02_005c 駅コード、N02_005g グループコード(300m 以内の同じ名称の駅のまとまり。事業者は問わない)

代表点は線の中点(線の長さの半分の位置)。長さは緯度に応じて経度を縮めた平面で測る。
同じ駅名・同じ運営会社の複数の線(旭川の函館線・宗谷線・富良野線など)は1つにまとめ、代表点は各線の中点の平均にする。
ただし同じ名前・同じ会社でも離れた別の駅(JR東日本の大久保は東京と秋田にある)をまとめないように、
既にまとめた駅のどれかから MERGE_DISTANCE_M 以内のものだけをまとめる。
全国のデータで、同じ駅の線どうしの距離は最大 515m(土合)、同名の別の駅は 78km 以上離れている(2025年度版で確認)。

廃止された駅は、まとめる前に線の単位で除く(closed_stations.csv)。N02-25 は 2025年12月31日時点で、
2026年3月に廃止された函館線の仁山・二股や、2026年4月1日に廃止された留萌線(深川〜石狩沼田)の線が残っている。
除く単位は N02 の線(feature)なので、深川の留萌線の線だけを除けば、深川は函館線だけの駅として残る。
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

MERGE_DISTANCE_M = 1000.0
# 廃止された駅の一覧(パッケージの中にある)
CLOSED_STATIONS_CSV = Path(__file__).with_name("closed_stations.csv")
CLOSED_STATIONS_HEADER = ["駅名", "事業者", "路線", "廃止日", "出典URL"]
_EARTH_RADIUS_M = 6_371_008.8


@dataclass
class StationPart:
    """駅の線1本。"""

    name: str
    line: str
    operator: str
    lat: float
    lon: float


@dataclass
class Station:
    """まとめた駅。line は路線名を「・」でつないだもの(データの出てくる順)。"""

    name: str
    operator: str
    lines: list[str] = field(default_factory=list)
    points: list[tuple[float, float]] = field(default_factory=list)

    @property
    def line(self) -> str:
        return "・".join(self.lines)

    @property
    def lat(self) -> float:
        return sum(p[0] for p in self.points) / len(self.points)

    @property
    def lon(self) -> float:
        return sum(p[1] for p in self.points) / len(self.points)


@dataclass(frozen=True)
class ClosedStation:
    """廃止された駅の線1本(closed_stations.csv の1行)。N02 の事業者(N02_004)・路線名(N02_003)・駅名(N02_005)で照合する。"""

    name: str
    operator: str
    line: str
    closed_on: date
    source_url: str

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.operator, self.line, self.name)


@dataclass
class ClosedResult:
    """廃止駅を除いた結果。"""

    kept: list[StationPart]
    removed: list[StationPart]
    # どの線にも一致しなかった CSV の行(新しい版の N02 で既に消えているか、書き間違い)
    unmatched: list[ClosedStation]


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """2点 (緯度, 経度) の距離(大円距離、メートル)。"""
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def line_midpoint(parts: list[list[list[float]]]) -> tuple[float, float]:
    """線(LineString の座標列のリスト。MultiLineString は複数)の長さの半分の位置 (緯度, 経度)。"""
    coords = [(float(c[0]), float(c[1])) for part in parts for c in part]
    if not coords:
        raise ValueError("駅の線に座標がありません")
    lat0 = sum(c[1] for c in coords) / len(coords)
    kx = math.cos(math.radians(lat0))
    segments: list[tuple[tuple[float, float], tuple[float, float], float]] = []
    for part in parts:
        for p, q in zip(part, part[1:]):
            dx = (float(q[0]) - float(p[0])) * kx
            dy = float(q[1]) - float(p[1])
            segments.append(((float(p[0]), float(p[1])), (float(q[0]), float(q[1])), math.hypot(dx, dy)))
    total = sum(s[2] for s in segments)
    if total == 0:
        lon, lat = coords[0]
        return lat, lon
    half = total / 2
    walked = 0.0
    for p, q, length in segments:
        if length > 0 and walked + length >= half:
            t = (half - walked) / length
            return p[1] + (q[1] - p[1]) * t, p[0] + (q[0] - p[0]) * t
        walked += length
    lon, lat = segments[-1][1]
    return lat, lon


def parse_station_geojson(data: dict[str, Any]) -> list[StationPart]:
    if data.get("type") != "FeatureCollection":
        raise ValueError("駅の GeoJSON が FeatureCollection ではありません")
    parts: list[StationPart] = []
    for f in data.get("features", []):
        geom = f.get("geometry") or {}
        props = f.get("properties") or {}
        if geom.get("type") == "LineString":
            lines = [geom["coordinates"]]
        elif geom.get("type") == "MultiLineString":
            lines = geom["coordinates"]
        elif geom.get("type") == "Point":
            lines = [[geom["coordinates"]]]
        else:
            continue
        name = str(props.get("N02_005") or "").strip()
        if not name:
            continue
        lat, lon = line_midpoint(lines)
        parts.append(
            StationPart(
                name=name,
                line=str(props.get("N02_003") or "").strip(),
                operator=str(props.get("N02_004") or "").strip(),
                lat=lat,
                lon=lon,
            )
        )
    return parts


def load_station_parts(path: Path) -> list[StationPart]:
    with open(path, encoding="utf-8") as f:
        return parse_station_geojson(json.load(f))


def merge_stations(parts: list[StationPart], merge_distance_m: float = MERGE_DISTANCE_M) -> list[Station]:
    """同じ駅名・同じ運営会社で、近い(merge_distance_m 以内)線を1つの駅にまとめる。"""
    groups: dict[tuple[str, str], list[Station]] = {}
    for part in parts:
        candidates = groups.setdefault((part.name, part.operator), [])
        point = (part.lat, part.lon)
        target = next(
            (s for s in candidates if any(distance_m(point, p) <= merge_distance_m for p in s.points)),
            None,
        )
        if target is None:
            target = Station(name=part.name, operator=part.operator)
            candidates.append(target)
        target.points.append(point)
        if part.line and part.line not in target.lines:
            target.lines.append(part.line)
    return [s for group in groups.values() for s in group]


def load_closed_stations(path: Path = CLOSED_STATIONS_CSV) -> list[ClosedStation]:
    """廃止駅の一覧(UTF-8、見出しつき)を読む。形が違えば ValueError。

    各欄の前後の空白は取る。空行は飛ばす。廃止日は YYYY-MM-DD。同じ(事業者・路線・駅名)が2行あればエラー。
    廃止日は記録で、除くかどうかの判定には使わない(一覧にある線はすべて除く)。
    """
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header is None or [h.strip() for h in header] != CLOSED_STATIONS_HEADER:
            raise ValueError(f"{path.name} の見出しが {','.join(CLOSED_STATIONS_HEADER)} ではありません")
        closed: list[ClosedStation] = []
        seen: set[tuple[str, str, str]] = set()
        for number, row in enumerate(reader, start=2):
            cells = [c.strip() for c in row]
            if not any(cells):
                continue
            if len(cells) != len(CLOSED_STATIONS_HEADER) or not all(cells):
                raise ValueError(f"{path.name} の {number} 行目は {len(CLOSED_STATIONS_HEADER)} 列すべてを埋めてください: {row}")
            name, operator, line, closed_on, source_url = cells
            try:
                # 'YYYY-MM-DD' だけを許す(fromisoformat は 'YYYYMMDD' なども読むため桁を確かめる)
                if len(closed_on) != 10:
                    raise ValueError(closed_on)
                day = date.fromisoformat(closed_on)
            except ValueError:
                raise ValueError(f"{path.name} の {number} 行目の廃止日が YYYY-MM-DD ではありません: {closed_on}") from None
            item = ClosedStation(name, operator, line, day, source_url)
            if item.key in seen:
                raise ValueError(f"{path.name} の {number} 行目が重複しています: {operator} {line} {name}")
            seen.add(item.key)
            closed.append(item)
    return closed


def exclude_closed(parts: list[StationPart], closed: list[ClosedStation]) -> ClosedResult:
    """事業者・路線・駅名がすべて一致する線を除く(駅をまとめる前に呼ぶ)。順序は保つ。"""
    keys = {c.key: c for c in closed}
    matched: set[tuple[str, str, str]] = set()
    kept: list[StationPart] = []
    removed: list[StationPart] = []
    for part in parts:
        key = (part.operator, part.line, part.name)
        if key in keys:
            matched.add(key)
            removed.append(part)
        else:
            kept.append(part)
    return ClosedResult(kept=kept, removed=removed, unmatched=[c for c in closed if c.key not in matched])
