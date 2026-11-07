"""JIS X 0410 の地域メッシュ(1次〜8分の1)。

docs/interfaces-1103.md の表どおり。web のコードは import できないため、同じ規則を Python で書く。

| 区画 | 桁数 | 大きさ(緯度 × 経度) |
| 1次 | 4 | 40分 × 1度 |
| 2次 | 6 | 5分 × 7分30秒 |
| 3次 | 8 | 30秒 × 45秒 |
| 2分の1 | 9 | 15秒 × 22.5秒 |
| 4分の1 | 10 | 7.5秒 × 11.25秒 |
| 8分の1 | 11 | 3.75秒 × 5.625秒 |

分割地域メッシュの末尾の数字は、南西 1・南東 2・北西 3・北東 4。

浮動小数の誤差で境界上の点が隣のセルにずれないように、計算は 8分の1地域メッシュを単位にした整数で行う。
緯度は 1/960 度(3.75秒)、経度は 100 度からの 1/640 度(5.625秒)が1単位。
境界上の点は、そのセルの南西側の端を含む(北・東の端は隣のセル)。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# 1度あたりの 8分の1地域メッシュの数
LAT_UNITS_PER_DEG = 960
LON_UNITS_PER_DEG = 640
LON_ORIGIN_DEG = 100

# 桁数ごとのセルの大きさ(8分の1地域メッシュの数。緯度・経度とも同じ)
CELL_UNITS: dict[int, int] = {4: 640, 6: 80, 8: 8, 9: 4, 10: 2, 11: 1}

# 境界とみなす幅(8分の1地域メッシュの単位)。1単位は緯度方向で約 116m、経度方向で約 80m(北緯 44度)なので、
# 1e-6 単位は約 0.1mm。浮動小数の誤差(1e-11 単位程度)より十分大きく、web/src/reach/mesh.ts の SNAP と同じ値
_SNAP = 1e-6


@dataclass(frozen=True)
class Bounds:
    south: float
    west: float
    north: float
    east: float


def _floor_units(x: float) -> int:
    """x(単位の数)を切り捨てる。整数のごく近くなら、その整数にそろえる。"""
    n = round(x)
    if abs(x - n) < _SNAP:
        return int(n)
    return math.floor(x)


def lat_index(lat: float) -> int:
    """緯度を 8分の1地域メッシュの行番号(赤道から数えた整数)にする。"""
    return _floor_units(lat * LAT_UNITS_PER_DEG)


def lon_index(lon: float) -> int:
    """経度を 8分の1地域メッシュの列番号(東経 100 度から数えた整数)にする。"""
    return _floor_units(lon * LON_UNITS_PER_DEG - LON_ORIGIN_DEG * LON_UNITS_PER_DEG)


def code_from_index(i: int, j: int, digits: int) -> str:
    """8分の1地域メッシュの行番号 i・列番号 j から、指定の桁数のメッシュコードを作る。"""
    if digits not in CELL_UNITS:
        raise ValueError(f"メッシュコードの桁数が不正です: {digits}")
    if i < 0 or j < 0:
        raise ValueError(f"地域メッシュの範囲外です(行 {i}、列 {j})")
    p, u = i // 640, j // 640
    if p > 99 or u > 99:
        raise ValueError(f"地域メッシュの範囲外です(行 {i}、列 {j})")
    code = f"{p:02d}{u:02d}"
    if digits >= 6:
        code += f"{(i // 80) % 8}{(j // 80) % 8}"
    if digits >= 8:
        code += f"{(i // 8) % 10}{(j // 8) % 10}"
    # 分割地域メッシュ:南西 1・南東 2・北西 3・北東 4
    for d, size in ((9, 4), (10, 2), (11, 1)):
        if digits >= d:
            code += str(1 + (j // size) % 2 + 2 * ((i // size) % 2))
    return code


def mesh_code(lat: float, lon: float, digits: int) -> str:
    """緯度経度を含むセルのメッシュコード。"""
    return code_from_index(lat_index(lat), lon_index(lon), digits)


def code_to_index(code: str) -> tuple[int, int, int]:
    """メッシュコードの南西の角の (行番号, 列番号) と、セルの大きさ(単位の数)を返す。"""
    # isdigit() は全角数字なども真になるため、ASCII に限る
    if not (code.isascii() and code.isdigit()) or len(code) not in CELL_UNITS:
        raise ValueError(f"メッシュコードが不正です: {code!r}")
    i = int(code[0:2]) * 640
    j = int(code[2:4]) * 640
    if len(code) >= 6:
        q, v = int(code[4]), int(code[5])
        if q > 7 or v > 7:
            raise ValueError(f"2次メッシュの数字が不正です: {code!r}")
        i += q * 80
        j += v * 80
    if len(code) >= 8:
        i += int(code[6]) * 8
        j += int(code[7]) * 8
    for pos, size in ((8, 4), (9, 2), (10, 1)):
        if len(code) > pos:
            d = int(code[pos])
            if not 1 <= d <= 4:
                raise ValueError(f"分割地域メッシュの数字が不正です: {code!r}")
            i += ((d - 1) // 2) * size
            j += ((d - 1) % 2) * size
    return i, j, CELL_UNITS[len(code)]


def mesh_bounds(code: str) -> Bounds:
    i, j, size = code_to_index(code)
    return Bounds(
        south=i / LAT_UNITS_PER_DEG,
        west=LON_ORIGIN_DEG + j / LON_UNITS_PER_DEG,
        north=(i + size) / LAT_UNITS_PER_DEG,
        east=LON_ORIGIN_DEG + (j + size) / LON_UNITS_PER_DEG,
    )


def mesh_center(code: str) -> tuple[float, float]:
    """セルの中心の (緯度, 経度)。"""
    i, j, size = code_to_index(code)
    return (
        (i + size / 2) / LAT_UNITS_PER_DEG,
        LON_ORIGIN_DEG + (j + size / 2) / LON_UNITS_PER_DEG,
    )


def parent_code(code: str, digits: int) -> str:
    """上位のメッシュコード(先頭の桁を切り出す)。"""
    code_to_index(code)  # 形の確認
    if digits not in CELL_UNITS or digits > len(code):
        raise ValueError(f"上位のメッシュの桁数が不正です: {digits}({code!r})")
    return code[:digits]


def cell_center_lat(i: int) -> float:
    """8分の1地域メッシュの行番号 i のセルの中心の緯度。"""
    return (i + 0.5) / LAT_UNITS_PER_DEG


def cell_center_lon(j: int) -> float:
    """8分の1地域メッシュの列番号 j のセルの中心の経度。"""
    return LON_ORIGIN_DEG + (j + 0.5) / LON_UNITS_PER_DEG
