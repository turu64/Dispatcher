"""周辺の施設の調査の対象(事業者・学校・病院・診療所)の参照データを作る。

国土数値情報の次の3つから、1次メッシュごとの JSON(data/out/ref/facilities/{1次メッシュ}.json)を書く。

- バス停留所 P11(2022年度、GML。座標は JGD2011 の「緯度 経度」の順)
- 学校 P29(2023年度、GeoJSON。座標は「経度, 緯度」)
- 医療機関 P04(2020年度、GeoJSON)

形は次のとおり。各施設の項目の順は固定で、同じ入力からは同じバイト列ができる。

    {
      "mesh1": "6542",
      "facilities": [
        {"target_id": "P29:C101220400011", "kind": "school", "name": "…", "municipality": "旭川市",
         "lat": 43.7, "lon": 142.3, "detail": {…}}
      ],
      "busstops": [
        {"name": "旭川駅前", "lat": 43.76, "lon": 142.36, "operators": ["P11:旭川電気軌道(株)"], "routes": ["1", "2"]}
      ],
      "sources": ["国土数値情報(バス停留所 P11、学校 P29、医療機関 P04)を加工して作成"]
    }

kind と detail:

- ``operator``(事業者。P11 のバス停留所の事業者名ごと)
    detail ``{"stops": 事業者の停留所の総数, "stops_here": この1次メッシュの停留所の数, "bbox": [南, 西, 北, 東]}``
    bbox はこの1次メッシュにある停留所の外接矩形で、停留所の外周 +2km の範囲との交わりを調べるのに使う。
    lat/lon はこの1次メッシュにある停留所の重心。
    事業者は停留所のある1次メッシュすべてのファイルに入る。同じ target_id が複数のファイルに現れるので、
    読む側は target_id で重複をまとめる(位置は1次メッシュごとに違う)。事業者が自治体の名前のとき
    (コミュニティバスは自治体名)は municipality にその名前を入れ、そうでなければ空文字にする。
- ``school``(学校。休校中を除く)
    detail ``{"school_type", "school_type_code", "school_code", "management", "open_status", "address"}``
    学校コードが同じでキャンパスが複数あるとき(北海道大学など)は、キャンパスごとに別の対象にして
    ``"campus"`` を足す。school_code で学校としてまとめられる。
- ``hospital`` / ``clinic``(病床数が 20 床以上なら hospital、未満なら clinic。歯科診療所は入れない)
    detail ``{"beds", "emergency"(救急告示病院か), "disaster_base"("基幹"・"地域"・null), "address"}``

busstops(バス停留所 P11 の停留所ごと。平日便を戻す手順の「判断材料を調べる」で、編集する GTFS の停留所の近くにある他事業者の停留所と系統を数えるのに使う):

- 停留所はその位置の1次メッシュのファイルにだけ入る(事業者と違い、複数のファイルには現れない)
- name は停留所名(bsn)、operators は事業者の target_id(上の ``P11:…`` と同じ)、routes は系統名(bri の brn。重複なし、名前の順)
- 停留所名・座標(小数6桁に丸めたもの)・事業者が同じものは1件にまとめ、系統名を合わせる。
  事業者の違うものはまとめない(系統名をその事業者のものとして数えるため)。そのため operators はいつも1件
- P11 には時刻表が無いので、本数や時間帯は入らない
- 並びは (緯度, 経度, 停留所名, 事業者) の順。事業者名が空のもの、座標が無い・不正なものは数えて飛ばす。
  停留所名が空のものは、事業者の停留所には数えるが busstops には入れない(notes に数える)
- P11 が無いときは空の配列

target_id(同じ入力なら同じ ID になる):

- 学校 ``P29:<学校コード>``。キャンパスが 00 以外のものは ``P29:<学校コード>-<キャンパスコード>``
- 医療機関 ``P04:<sha1(NFKC(名称) + "|" + NFKC(所在地))の先頭12桁>``(NFKC で整えたあと、空白をすべて除く)
- 事業者 ``P11:<NFKC で整えた事業者名>``(空白をすべて除く)

市区町村は、学校は行政区域コード(P29_001)から、医療機関は所在地の先頭から、
行政区域コードの一覧(hokkaido_municipalities.csv。国土数値情報の AdminiBoundary_CD.xlsx から作った)で引く。

元データは信用しないデータとして扱う。GML は DOCTYPE・ENTITY を含むものを読まない。座標と型が不正な行は数えて飛ばす。
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .mesh import mesh_code

SOURCES = ["国土数値情報(バス停留所 P11、学校 P29、医療機関 P04)を加工して作成"]

COORD_DIGITS = 6
# 病床数がこの値以上なら入院設備のある病院(医療法の病院の定義)
HOSPITAL_MIN_BEDS = 20
# 座標の有効な範囲(日本全体の外側。外れたものは壊れた行として飛ばす)
LAT_RANGE = (20.0, 46.5)
LON_RANGE = (122.0, 154.0)

MUNICIPALITIES_CSV = Path(__file__).with_name("hokkaido_municipalities.csv")
MUNICIPALITIES_HEADER = ["行政区域コード", "市区町村名"]

# 元データの置き場所(data/raw/ からの相対。glob)。KS-META-… のメタデータは P11-… で始まらないので当たらない
SCHOOL_GLOB = "school/**/P29-*.geojson"
MEDICAL_GLOB = "medical/**/P04-*.geojson"
BUSSTOP_GLOB = "busstop/**/P11-*.xml"

# 学校分類コード(国土数値情報 SchoolClassCd-v2_0)
SCHOOL_TYPES = {
    "16001": "小学校",
    "16002": "中学校",
    "16003": "中等教育学校",
    "16004": "高等学校",
    "16005": "高等専門学校",
    "16006": "短期大学",
    "16007": "大学",
    "16011": "幼稚園",
    "16012": "特別支援学校",
    "16013": "幼保連携型認定こども園",
    "16014": "義務教育学校",
    "16015": "各種学校",
    "16016": "専修学校",
}
# 周辺の施設の調査の対象外の学校(幼稚園・幼保連携型認定こども園・小学校・中学校・義務教育学校)。施設に入れない
# (2026-11-06 に利用者が決定。中等教育学校 16003 は高校の課程を含むので残す)。画面の読み込み(web/src/ref/facilities.ts の
# EXCLUDED_SCHOOL_TYPES)でも外す
EXCLUDED_SCHOOL_CODES = {"16001", "16002", "16011", "16013", "16014"}
EXCLUDED_SCHOOL_REASON = "調査の対象外の学校(幼稚園・小学校・中学校など)"
# 管理者コード(AdminCd)
MANAGEMENTS = {"0": "その他", "1": "国", "2": "都道府県", "3": "市区町村", "4": "民間"}
# 休校コード(ClosedSchoolCode)。2 は休校中。9 は定義に無いが、廃校になった学校(森町立石谷小学校など)に付いている
CLOSED_CODE = "2"
OPEN_STATUSES = {"0": "調査なし", "1": "開校中"}
# 医療機関分類コード(MedClassCd)
MED_HOSPITAL, MED_CLINIC, MED_DENTAL = 1, 2, 3
# 災害拠点病院区分コード
DISASTER_BASES = {1: "基幹", 2: "地域"}


class FacilityDataError(Exception):
    """元データを読めない(DOCTYPE がある、GeoJSON でない、など)。"""


# ---------------------------------------------------------------------------
# 文字・ID
# ---------------------------------------------------------------------------


def normalize_text(value: object) -> str:
    """NFKC で整え、空白(全角を含む)をすべて除く。"""
    return "".join(unicodedata.normalize("NFKC", str(value or "")).split())


def school_target_id(code: str, campus: str) -> str:
    return f"P29:{code}" if campus in ("", "00") else f"P29:{code}-{campus}"


def clinic_target_id(name: str, address: str) -> str:
    key = normalize_text(name) + "|" + normalize_text(address)
    return "P04:" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def operator_target_id(name: str) -> str:
    return "P11:" + normalize_text(name)


# ---------------------------------------------------------------------------
# 市区町村
# ---------------------------------------------------------------------------


@dataclass
class Municipalities:
    by_code: dict[str, str]
    # 前方一致の探索用(長い名前が先。札幌市中央区が札幌市より先に当たる)
    names_longest_first: list[str]

    def of_address(self, address: str) -> str:
        """所在地の先頭の市区町村名。「標津郡中標津町…」のように郡が付くときは郡を飛ばす。見つからなければ空文字。"""
        addr = normalize_text(address).removeprefix("北海道")
        candidates = [addr]
        # 郡の名前は市を含むことがある(余市郡)ので、先頭の8文字以内の「郡」までを飛ばす
        gun = addr.find("郡")
        if 0 < gun <= 8:
            candidates.append(addr[gun + 1 :])
        for text in candidates:
            for name in self.names_longest_first:
                if text.startswith(name):
                    return name
        return ""


def load_municipalities(path: Path = MUNICIPALITIES_CSV) -> Municipalities:
    with path.open(encoding="utf-8", newline="") as f:
        rows = list(csv.reader(f))
    if not rows or rows[0] != MUNICIPALITIES_HEADER:
        raise FacilityDataError(f"{path.name} の見出しが違います(期待:{','.join(MUNICIPALITIES_HEADER)})")
    by_code = {r[0]: r[1] for r in rows[1:] if len(r) == 2 and r[0] and r[1]}
    return Municipalities(by_code, sorted(set(by_code.values()), key=lambda n: (-len(n), n)))


# ---------------------------------------------------------------------------
# 施設
# ---------------------------------------------------------------------------


@dataclass
class Facility:
    target_id: str
    kind: str
    name: str
    municipality: str
    lat: float
    lon: float
    detail: dict[str, Any]

    def to_json(self) -> dict[str, Any]:
        return {
            "target_id": self.target_id,
            "kind": self.kind,
            "name": self.name,
            "municipality": self.municipality,
            "lat": round(self.lat, COORD_DIGITS),
            "lon": round(self.lon, COORD_DIGITS),
            "detail": self.detail,
        }


@dataclass
class BusStop:
    """他事業者の停留所の1件(P11)。"""

    name: str
    lat: float
    lon: float
    operators: list[str]
    routes: list[str]

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "lat": round(self.lat, COORD_DIGITS),
            "lon": round(self.lon, COORD_DIGITS),
            "operators": list(self.operators),
            "routes": list(self.routes),
        }


@dataclass
class LoadResult:
    """1つの元データを読んだ結果。"""

    facilities: list[Facility] = field(default_factory=list)
    # バス停留所(P11 を読んだときだけ入る)
    busstops: list[BusStop] = field(default_factory=list)
    # 数えて飛ばした行(理由 → 件数)
    skipped: dict[str, int] = field(default_factory=dict)
    # 施設は入れたが、一部の項目を引けなかった件数(理由 → 件数)
    notes: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1

    def note(self, reason: str) -> None:
        self.notes[reason] = self.notes.get(reason, 0) + 1


def _valid_lat_lon(lat: object, lon: object) -> bool:
    if isinstance(lat, bool) or isinstance(lon, bool) or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return False
    return (
        math.isfinite(lat)
        and math.isfinite(lon)
        and LAT_RANGE[0] <= lat <= LAT_RANGE[1]
        and LON_RANGE[0] <= lon <= LON_RANGE[1]
    )


def _str(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _read_features(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise FacilityDataError(f"{path.name} を GeoJSON として読めません: {e}") from e
    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list):
        raise FacilityDataError(f"{path.name} に features がありません")
    return features


def _point_and_props(feature: object) -> tuple[float, float, dict[str, Any]] | None:
    """GeoJSON の Point 1つの (緯度, 経度, 属性)。形が違えば None。"""
    if not isinstance(feature, dict):
        return None
    geometry, props = feature.get("geometry"), feature.get("properties")
    if not isinstance(geometry, dict) or geometry.get("type") != "Point" or not isinstance(props, dict):
        return None
    coords = geometry.get("coordinates")
    if not isinstance(coords, list) or len(coords) < 2:
        return None
    lon, lat = coords[0], coords[1]
    if not _valid_lat_lon(lat, lon):
        return None
    return float(lat), float(lon), props


def load_schools(path: Path, municipalities: Municipalities) -> LoadResult:
    """学校(P29)。休校中と、調査の対象外の学校(EXCLUDED_SCHOOL_CODES)は除く。"""
    result = LoadResult()
    seen: set[str] = set()
    for feature in _read_features(path):
        point = _point_and_props(feature)
        if point is None:
            result.skip("座標・形が不正")
            continue
        lat, lon, p = point
        code, name = _str(p.get("P29_002")), _str(p.get("P29_004"))
        if not code or not name:
            result.skip("学校コードか名称が空")
            continue
        if _str(p.get("P29_003")) in EXCLUDED_SCHOOL_CODES:
            result.skip(EXCLUDED_SCHOOL_REASON)
            continue
        if _str(p.get("P29_007")) == CLOSED_CODE:
            result.skip("休校中")
            continue
        campus = _str(p.get("P29_008"))
        target_id = school_target_id(code, campus)
        if target_id in seen:
            result.skip("target_id の重複")
            continue
        seen.add(target_id)
        note = _str(p.get("P29_009"))
        display = f"{name}({note})" if note and campus not in ("", "00") else name
        type_code = _str(p.get("P29_003"))
        detail: dict[str, Any] = {
            "school_type": SCHOOL_TYPES.get(type_code, ""),
            "school_type_code": type_code,
            "school_code": code,
            "management": MANAGEMENTS.get(_str(p.get("P29_006")), ""),
            "open_status": OPEN_STATUSES.get(_str(p.get("P29_007")), "不明"),
            "address": _str(p.get("P29_005")),
        }
        if campus not in ("", "00"):
            detail["campus"] = campus
        muni = municipalities.by_code.get(_str(p.get("P29_001")), "")
        if not muni:
            result.note("市区町村を引けない(施設は入れた)")
        result.facilities.append(Facility(target_id, "school", display, muni, lat, lon, detail))
    return result


def load_medical(path: Path, municipalities: Municipalities) -> LoadResult:
    """医療機関(P04)。病床数 20 床以上を hospital、未満を clinic にする。歯科診療所は除く。"""
    result = LoadResult()
    seen: set[str] = set()
    for feature in _read_features(path):
        point = _point_and_props(feature)
        if point is None:
            result.skip("座標・形が不正")
            continue
        lat, lon, p = point
        name, address = _str(p.get("P04_002")), _str(p.get("P04_003"))
        if not name:
            result.skip("名称が空")
            continue
        if p.get("P04_001") == MED_DENTAL:
            result.skip("歯科診療所")
            continue
        beds = p.get("P04_008")
        beds = beds if isinstance(beds, int) and not isinstance(beds, bool) and beds >= 0 else 0
        target_id = clinic_target_id(name, address)
        if target_id in seen:
            result.skip("target_id の重複")
            continue
        seen.add(target_id)
        muni = municipalities.of_address(address)
        if not muni:
            result.note("市区町村を引けない(施設は入れた)")
        detail = {
            "beds": beds,
            "emergency": p.get("P04_009") == 1,
            "disaster_base": DISASTER_BASES.get(p.get("P04_010")),
            "address": address,
        }
        kind = "hospital" if beds >= HOSPITAL_MIN_BEDS else "clinic"
        result.facilities.append(Facility(target_id, kind, name, muni, lat, lon, detail))
    return result


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _attr(elem: ET.Element, local_name: str) -> str | None:
    for key, value in elem.attrib.items():
        if _local(key) == local_name:
            return value
    return None


@dataclass
class _RawBusStop:
    """GML の BusStop 1つ。ref は位置(gml:Point)の ID。"""

    ref: str
    name: str
    operator: str
    routes: list[str]


def _text(elem: ET.Element, local_name: str) -> str:
    child = next((c for c in elem if _local(c.tag) == local_name), None)
    return (child.text or "").strip() if child is not None else ""


def _read_busstops(path: Path) -> tuple[list[_RawBusStop], dict[str, tuple[float, float]]]:
    """P11 の GML から、停留所(位置の参照・停留所名 bsn・事業者名 boc・系統名 bri/brn)の並びと、位置の ID → (緯度, 経度) を取る。"""
    try:
        with path.open("rb") as f:
            head = f.read(8192)
            if re.search(rb"<!(DOCTYPE|ENTITY)", head, re.IGNORECASE):
                raise FacilityDataError(f"{path.name} に DOCTYPE があるので読みません")
            f.seek(0)
            stops: list[_RawBusStop] = []
            points: dict[str, tuple[float, float]] = {}
            for _event, elem in ET.iterparse(f, events=("end",)):
                name = _local(elem.tag)
                if name == "Point":
                    pid = _attr(elem, "id")
                    pos = next((c.text for c in elem if _local(c.tag) == "pos"), None)
                    if pid and pos:
                        parts = pos.split()
                        if len(parts) == 2:
                            try:
                                points[pid] = (float(parts[0]), float(parts[1]))  # 緯度 経度の順
                            except ValueError:
                                pass
                    elem.clear()
                elif name == "BusStop":
                    loc = next((c for c in elem if _local(c.tag) == "loc"), None)
                    href = _attr(loc, "href") if loc is not None else None
                    # 系統(bri)は停留所ごとに0個以上。系統名(brn)が空のものは入れない
                    routes = [r for r in (_text(c, "brn") for c in elem if _local(c.tag) == "bri") if r]
                    stops.append(_RawBusStop((href or "").lstrip("#"), _text(elem, "bsn"), _text(elem, "boc"), routes))
                    elem.clear()
    except ET.ParseError as e:
        raise FacilityDataError(f"{path.name} を GML として読めません: {e}") from e
    except OSError as e:
        raise FacilityDataError(f"{path.name} を読めません: {e}") from e
    return stops, points


def load_operators(path: Path, municipalities: Municipalities) -> LoadResult:
    """バス停留所(P11)を事業者ごとにまとめる。事業者は停留所のある1次メッシュごとに1件(位置はその1次メッシュの停留所の重心)。

    停留所ごとの位置・停留所名・事業者・系統名は result.busstops に入れる(書き出しで busstops の鍵になる)。
    """
    result = LoadResult()
    stops, points = _read_busstops(path)
    by_operator: dict[str, dict[str, list[tuple[float, float]]]] = {}
    display_names: dict[str, str] = {}
    # (停留所名, 緯度, 経度, 事業者の target_id) → 系統名の集合。同じ停留所が二重に載っているときに1件にまとめる
    merged: dict[tuple[str, float, float, str], set[str]] = {}
    for stop in stops:
        key = normalize_text(stop.operator)
        pos = points.get(stop.ref)
        if not key:
            result.skip("事業者名が空")
        elif pos is None or not _valid_lat_lon(*pos):
            result.skip("座標が無い・不正")
        else:
            display_names.setdefault(key, unicodedata.normalize("NFKC", stop.operator).strip())
            by_operator.setdefault(key, {}).setdefault(mesh_code(pos[0], pos[1], 4), []).append(pos)
            # 事業者としては数えるが、停留所名の無いものは一覧に出せないので停留所には入れない
            stop_name = unicodedata.normalize("NFKC", stop.name).strip()
            if not stop_name:
                result.note("停留所名が空(事業者には数え、停留所の一覧には入れない)")
                continue
            routes = merged.setdefault(
                (stop_name, round(pos[0], COORD_DIGITS), round(pos[1], COORD_DIGITS), operator_target_id(key)), set()
            )
            routes.update(unicodedata.normalize("NFKC", r).strip() for r in stop.routes)
    result.busstops = [
        BusStop(name, lat, lon, [op], sorted(r for r in routes if r))
        # 並びは (緯度, 経度, 停留所名, 事業者) の順
        for (name, lat, lon, op), routes in sorted(merged.items(), key=lambda kv: (kv[0][1], kv[0][2], kv[0][0], kv[0][3]))
    ]
    municipality_names = set(municipalities.names_longest_first)
    for key in sorted(by_operator):
        meshes = by_operator[key]
        total = sum(len(v) for v in meshes.values())
        muni = key if key in municipality_names else ""
        for _mesh1, pts in sorted(meshes.items()):
            lats, lons = [p[0] for p in pts], [p[1] for p in pts]
            detail = {
                "stops": total,
                "stops_here": len(pts),
                "bbox": [round(min(lats), COORD_DIGITS), round(min(lons), COORD_DIGITS), round(max(lats), COORD_DIGITS), round(max(lons), COORD_DIGITS)],
            }
            result.facilities.append(
                Facility(
                    operator_target_id(key),
                    "operator",
                    display_names[key],
                    muni,
                    sum(lats) / len(lats),
                    sum(lons) / len(lons),
                    detail,
                )
            )
    return result


# ---------------------------------------------------------------------------
# 書き出し
# ---------------------------------------------------------------------------


def group_by_mesh1(facilities: list[Facility]) -> dict[str, list[Facility]]:
    out: dict[str, list[Facility]] = {}
    for fac in facilities:
        out.setdefault(mesh_code(fac.lat, fac.lon, 4), []).append(fac)
    for items in out.values():
        items.sort(key=lambda f: f.target_id)
    return out


def group_busstops_by_mesh1(busstops: list[BusStop]) -> dict[str, list[BusStop]]:
    """停留所を位置の1次メッシュごとに分ける(並びは元の並び。load_operators が決まった順に並べている)。"""
    out: dict[str, list[BusStop]] = {}
    for stop in busstops:
        out.setdefault(mesh_code(stop.lat, stop.lon, 4), []).append(stop)
    return out


def make_ref(mesh1: str, facilities: list[Facility], busstops: list[BusStop] | None = None) -> dict[str, Any]:
    return {
        "mesh1": mesh1,
        "facilities": [f.to_json() for f in facilities],
        "busstops": [b.to_json() for b in busstops or []],
        "sources": list(SOURCES),
    }


@dataclass
class FacilityReport:
    """加工の結果(画面に出す件数)。"""

    # 見つけた元データ(P11・P29・P04 → ファイル名)。無かったものは入らない
    sources: dict[str, str] = field(default_factory=dict)
    # 無かった元データの案内(あれば、施設データを作らなかったか一部だけ作った)
    missing: list[str] = field(default_factory=list)
    # 元データごとに飛ばした行(元データ → 理由 → 件数)
    skipped: dict[str, dict[str, int]] = field(default_factory=dict)
    # 元データごとの、施設は入れたが項目を引けなかった件数(元データ → 理由 → 件数)
    notes: dict[str, dict[str, int]] = field(default_factory=dict)
    # 指定された1次メッシュの外にあって書かなかった施設の数
    outside_mesh1: int = 0
    # (1次メッシュ, ファイル, バイト数, 種類 → 件数)。件数には停留所(busstops)の数も "busstop" として入る
    files: list[tuple[str, Path, int, dict[str, int]]] = field(default_factory=list)


def _latest(paths: list[Path]) -> Path | None:
    return sorted(paths, key=lambda p: p.name)[-1] if paths else None


def run(raw: Path, out_dir: Path, mesh1_list: list[str] | None = None) -> FacilityReport:
    """元データ(data/raw の school・medical・busstop)を読んで、out_dir/{1次メッシュ}.json を書く。

    元データは無くてもよい(無ければ飛ばして report.missing に書く。3つとも無ければ何も書かない)。
    mesh1_list を指定したときは、その1次メッシュのファイルを(施設が無くても空で)必ず書き、ほかの施設は書かない。
    指定が無ければ、施設のある1次メッシュすべて。
    """
    report = FacilityReport()
    muni = load_municipalities()
    found = {
        "P29": (_latest(list(raw.glob(SCHOOL_GLOB))), "学校", f"{raw / 'school'} に P29-23_01_GML(GeoJSON)", load_schools),
        "P04": (_latest(list(raw.glob(MEDICAL_GLOB))), "医療機関", f"{raw / 'medical'} に P04-20_01_GML(GeoJSON)", load_medical),
        "P11": (_latest(list(raw.glob(BUSSTOP_GLOB))), "バス停留所", f"{raw / 'busstop'} に P11-22_01_GML(GML)", load_operators),
    }
    facilities: list[Facility] = []
    busstops: list[BusStop] = []
    for code, (path, label, where, loader) in found.items():
        if path is None:
            report.missing.append(f"{label}({code})が無いので飛ばしました。展開して {where} に置いてください")
            continue
        report.sources[code] = path.name
        loaded = loader(path, muni)
        facilities.extend(loaded.facilities)
        busstops.extend(loaded.busstops)
        report.skipped[code] = loaded.skipped
        report.notes[code] = loaded.notes
    if not report.sources:
        return report

    by_mesh1 = group_by_mesh1(facilities)
    stops_by_mesh1 = group_busstops_by_mesh1(busstops)
    if mesh1_list:
        targets = sorted(set(mesh1_list))
        report.outside_mesh1 = sum(len(v) for m, v in by_mesh1.items() if m not in targets)
    else:
        targets = sorted(set(by_mesh1) | set(stops_by_mesh1))
    out_dir.mkdir(parents=True, exist_ok=True)
    for mesh1 in targets:
        items = by_mesh1.get(mesh1, [])
        stops_here = stops_by_mesh1.get(mesh1, [])
        path = out_dir / f"{mesh1}.json"
        path.write_text(
            json.dumps(make_ref(mesh1, items, stops_here), ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        counts: dict[str, int] = {}
        for item in items:
            counts[item.kind] = counts.get(item.kind, 0) + 1
        if stops_here:
            counts["busstop"] = len(stops_here)
        report.files.append((mesh1, path, path.stat().st_size, counts))
    return report


def describe(report: FacilityReport) -> list[str]:
    """画面・端末に出す要約の行。"""
    lines = [f"施設データ:{code} = {name}" for code, name in report.sources.items()]
    lines += [f"  {note}" for note in report.missing]
    for code, reasons in report.skipped.items():
        for reason, n in sorted(reasons.items()):
            lines.append(f"  {code}:{reason} {n} 件を飛ばしました")
    for code, reasons in report.notes.items():
        for reason, n in sorted(reasons.items()):
            lines.append(f"  {code}:{reason} {n} 件")
    if report.outside_mesh1:
        lines.append(f"  指定した1次メッシュの外の施設 {report.outside_mesh1} 件は書きませんでした")
    for mesh1, path, size, counts in report.files:
        kinds = "、".join(f"{k} {n}" for k, n in sorted(counts.items())) or "施設なし"
        lines.append(f"{mesh1}: {kinds} → {path}({size:,} バイト)")
    return lines


def main(argv: list[str] | None = None) -> int:
    """python -m dispatcher_data.facilities [--raw …] [--out …] [--mesh1 …]"""
    import argparse

    data_dir = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(prog="dispatcher_data.facilities", description="周辺の施設の調査の対象の参照データを作る")
    parser.add_argument("--raw", type=Path, default=data_dir / "raw")
    parser.add_argument("--out", type=Path, default=data_dir / "out" / "ref" / "facilities")
    parser.add_argument("--mesh1", nargs="+", help="1次メッシュ(4桁)。省略すると施設のある1次メッシュすべて")
    args = parser.parse_args(argv)
    if args.mesh1:
        bad = [m for m in args.mesh1 if len(m) != 4 or not (m.isascii() and m.isdigit())]
        if bad:
            parser.error(f"1次メッシュは数字4桁で指定してください: {' '.join(bad)}")
    try:
        report = run(args.raw, args.out, args.mesh1)
    except FacilityDataError as e:
        print(str(e), file=sys.stderr)
        return 1
    print("\n".join(describe(report)))
    return 0 if report.sources else 1


if __name__ == "__main__":
    sys.exit(main())
