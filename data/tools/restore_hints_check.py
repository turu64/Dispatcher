#!/usr/bin/env python3
"""足し戻しの手がかり(restoresLostCells・onlyServiceAtStop)を、web のコードを見ずに取り決めから計算する。

取り決め:docs/interfaces-1105.md §7、1104 §7(起点・乗れる行・比較)、1103 の追記2・3(セル・区分・距離)、CLAUDE.md の到達圏の計算条件。
標準ライブラリだけを使う。python3 -I で動かす。

web/src/gtfs/edit/restore.verify.test.ts の照合の相手(PYTHON の値)を出す。web のコードは import しない・写さない。

使い方(リポジトリの最上位から。手順は data/tools/README.md の「足し戻しの手がかりの照合」):
    python3 -I data/tools/restore_hints_check.py BASE.zip EDITED_DIR REF_DIR OUT.json

EDITED_DIR は data/tools/form2_ref.py を policies/main.json と --generated-at 202611041200 で動かした出力
(trips・stop_times・calendar・calendar_dates。stops は基準のまま)。REF_DIR は data/out/ref(参照データの 1次メッシュごとの JSON)。

乗れる行の時刻は、docs/interfaces-1105.md §7 のとおり出発の時刻だけを使い、出発が空の行は数えない
(到達圏の出発の数と同じ。道北バスの 9/17 版には出発が空の行が無い)。
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import sys
import zipfile

DATE = "20261104"
BANDS = [(6, 9), (9, 12), (12, 15), (15, 18), (18, 21), (21, 24)]
WALK = {"urban": (5, 10), "suburban": (10, 15), "rural": (15, 20)}  # (バス停, 駅) の分
SPEED = 80.0
THRESHOLD = 1000.0
WEEKDAY_SERVICE = "01"
MESH1 = ["6541", "6542", "6543", "6641", "6642", "6643"]

TIME_RE = re.compile(r"^(\d{1,3}):([0-5]\d):([0-5]\d)$")
INT_RE = re.compile(r"^[0-9]+$")


def read_csv_text(text: str) -> list[dict[str, str]]:
    if text.startswith("﻿"):
        text = text[1:]
    return list(csv.DictReader(io.StringIO(text)))


def s(v: str | None) -> str:
    return "" if v is None else v.strip()


def parse_time(v: str | None) -> int | None:
    m = TIME_RE.match(s(v))
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))


def seq_of(row: dict[str, str]) -> int | None:
    v = s(row.get("stop_sequence"))
    return int(v) if INT_RE.match(v) else None


# ---------------------------------------------------------------- 運行日


def active_services(calendar: list[dict], calendar_dates: list[dict], date: str) -> set[str]:
    d = dt.date(int(date[:4]), int(date[4:6]), int(date[6:]))
    col = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][d.weekday()]
    on = set()
    for r in calendar:
        if s(r.get(col)) == "1" and s(r.get("start_date")) <= date <= s(r.get("end_date")):
            on.add(s(r.get("service_id")))
    add, rem = set(), set()
    for r in calendar_dates:
        if s(r.get("date")) != date:
            continue
        if s(r.get("exception_type")) == "1":
            add.add(s(r.get("service_id")))
        elif s(r.get("exception_type")) == "2":
            rem.add(s(r.get("service_id")))
    return (on | add) - rem


def yesterday(date: str) -> str:
    d = dt.date(int(date[:4]), int(date[4:6]), int(date[6:])) - dt.timedelta(days=1)
    return d.strftime("%Y%m%d")


def group_rows(stop_times: list[dict]) -> dict[str, list[dict]]:
    g: dict[str, list[dict]] = {}
    for r in stop_times:
        g.setdefault(s(r.get("trip_id")), []).append(r)
    return g


def last_seq(rows: list[dict]) -> int | None:
    seqs = [q for q in (seq_of(r) for r in rows) if q is not None]
    return max(seqs) if seqs else None


def band_index(t: int) -> int:
    for b, (lo, hi) in enumerate(BANDS):
        if lo * 3600 <= t < hi * 3600:
            return b
    return -1


def departures(trips: list[dict], groups: dict[str, list[dict]], cal, cal_dates, date: str) -> dict[str, list[int]]:
    """停留所ごとの時間帯別の出発の数(当日の便は t、前日の便は t − 24時間。乗れない行・最後の行・出発が空の行は数えない)"""
    today = active_services(cal, cal_dates, date)
    prev = active_services(cal, cal_dates, yesterday(date))
    counts: dict[str, list[int]] = {}
    for t in trips:
        sid = s(t.get("service_id"))
        offsets = []
        if sid in today:
            offsets.append(0)
        if sid in prev:
            offsets.append(-86400)
        if not offsets:
            continue
        rows = groups.get(s(t.get("trip_id")), [])
        last = last_seq(rows)
        for r in rows:
            if s(r.get("pickup_type")) == "1":
                continue
            q = seq_of(r)
            if q is not None and q == last:
                continue
            if s(r.get("departure_time")) == "":
                continue
            sec = parse_time(r.get("departure_time"))
            if sec is None:
                continue
            for off in offsets:
                b = band_index(sec + off)
                if b >= 0:
                    counts.setdefault(s(r.get("stop_id")), [0] * len(BANDS))[b] += 1
    return counts


# ---------------------------------------------------------------- 地域メッシュ(JIS X 0410)

# 8分の1地域メッシュの1辺:緯度 3.75秒、経度 5.625秒
DLAT = 3.75 / 3600
DLON = 5.625 / 3600


def code11(lat: float, lon: float) -> str:
    """緯度経度を含む 8分の1地域メッシュのコード(1次 → 2次 → 3次 → 2分の1 → 4分の1 → 8分の1 の順に割っていく)"""
    p = math.floor(lat * 1.5)
    a = lat * 60 - p * 40  # 1次の中の分(0〜40)
    q = math.floor(a / 5)
    b = (a - q * 5) * 60  # 2次の中の秒(0〜300)
    r = math.floor(b / 30)
    c = b - r * 30  # 3次の中の秒(0〜30)
    u = math.floor(lon) - 100
    f = (lon - math.floor(lon)) * 60  # 1次の中の分(0〜60)
    v = math.floor(f / 7.5)
    g = (f - v * 7.5) * 60  # 2次の中の秒(0〜450)
    w = math.floor(g / 45)
    h = g - w * 45  # 3次の中の秒(0〜45)
    digits = ""
    ch, cw = 30.0, 45.0
    for _ in range(3):
        ch /= 2
        cw /= 2
        north = c >= ch
        east = h >= cw
        digits += str(1 + (2 if north else 0) + (1 if east else 0))
        if north:
            c -= ch
        if east:
            h -= cw
    return f"{p:02d}{u:02d}{q}{v}{r}{w}{digits}"


def south_west_of_code10(code: str) -> tuple[float, float]:
    """4分の1地域メッシュ(10 桁)の南西の端"""
    p, u = int(code[0:2]), int(code[2:4])
    q, v = int(code[4]), int(code[5])
    r, w = int(code[6]), int(code[7])
    lat = p / 1.5 + q * 5 / 60 + r * 30 / 3600
    lon = 100 + u + v * 7.5 / 60 + w * 45 / 3600
    size_lat, size_lon = 15 / 3600, 22.5 / 3600
    for ch in code[8:10]:
        k = int(ch) - 1
        if k >= 2:
            lat += size_lat
        if k % 2 == 1:
            lon += size_lon
        size_lat /= 2
        size_lon /= 2
    return lat, lon


# GRS80
A = 6378137.0
F = 1 / 298.257222101
E2 = F * (2 - F)


def mn(lat_rad: float) -> tuple[float, float]:
    w = math.sqrt(1 - E2 * math.sin(lat_rad) ** 2)
    return A * (1 - E2) / w**3, A / w


def dist(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """ヒュベニの式(2点の平均緯度の M・N)"""
    m, n = mn(math.radians((lat1 + lat2) / 2))
    dy = m * math.radians(lat2 - lat1)
    dx = n * math.cos(math.radians((lat1 + lat2) / 2)) * math.radians(lon2 - lon1)
    return math.sqrt(dy * dy + dx * dx)


def area_km2_code10(code: str) -> float:
    """4分の1地域メッシュの面積。∫ M(φ) N(φ) cosφ dφ × Δλ を Simpson 法(64 区間)で"""
    south, _ = south_west_of_code10(code)
    p1, p2 = math.radians(south), math.radians(south + 7.5 / 3600)
    k = 64
    hstep = (p2 - p1) / k
    total = 0.0
    for i in range(k + 1):
        phi = p1 + i * hstep
        m, n = mn(phi)
        val = m * n * math.cos(phi)
        wgt = 1 if i in (0, k) else (4 if i % 2 == 1 else 2)
        total += wgt * val
    integral = total * hstep / 3
    return integral * math.radians(11.25 / 3600) / 1e6


# ---------------------------------------------------------------- main


def main() -> None:
    base_zip, edited_dir, ref_dir, out_path = sys.argv[1:5]
    with zipfile.ZipFile(base_zip) as zf:
        base = {n[:-4]: read_csv_text(zf.read(n).decode("utf-8")) for n in zf.namelist() if n.endswith(".txt")}
    edited = dict(base)
    for n in ["trips", "stop_times", "calendar", "calendar_dates"]:
        with open(os.path.join(edited_dir, f"{n}.txt"), encoding="utf-8", newline="") as fh:
            edited[n] = read_csv_text(fh.read())

    pop250: dict[str, float] = {}
    did125: set[str] = set()
    stations: list[tuple[float, float]] = []
    for m in MESH1:
        with open(os.path.join(ref_dir, f"{m}.json"), encoding="utf-8") as fh:
            j = json.load(fh)
        pop250.update(j["pop250"])
        did125.update(j["did125"])
        stations.extend((st["lat"], st["lon"]) for st in j["stations"])

    base_groups = group_rows(base["stop_times"])
    edited_groups = group_rows(edited["stop_times"])

    # 起点:location_type が 0 か空で、基準の全便のどれかに乗れる行(pickup_type が 1 でなく、その便の最後でない行)がある停留所
    boarding_ids: set[str] = set()
    for tid, rows in base_groups.items():
        last = last_seq(rows)
        for r in rows:
            if s(r.get("pickup_type")) == "1":
                continue
            q = seq_of(r)
            if q is not None and q == last:
                continue
            boarding_ids.add(s(r.get("stop_id")))
    origins: dict[str, tuple[float, float]] = {}
    for r in base["stops"]:
        lt = s(r.get("location_type"))
        if lt not in ("", "0"):
            continue
        sid = s(r.get("stop_id"))
        if sid not in boarding_ids:
            continue
        origins[sid] = (float(s(r["stop_lat"])), float(s(r["stop_lon"])))
    print("origins", len(origins))

    dep_before = departures(base["trips"], base_groups, base["calendar"], base["calendar_dates"], DATE)
    dep_after = departures(edited["trips"], edited_groups, edited["calendar"], edited["calendar_dates"], DATE)
    print("band totals before", [sum(v[b] for v in dep_before.values()) for b in range(6)])
    print("band totals after ", [sum(v[b] for v in dep_after.values()) for b in range(6)])

    # 調べるセル:起点から 1,200m(3区分のバス停の距離の最大)以内に中心があり、親の 250m セルの人口が 1 以上
    max_bus = max(v[0] for v in WALK.values()) * SPEED
    cand: set[tuple[int, int]] = set()
    for lat, lon in origins.values():
        r0 = math.floor(lat / DLAT)
        c0 = math.floor((lon - 100) / DLON)
        for dr in range(-12, 13):
            for dc in range(-12, 13):
                rr, cc = r0 + dr, c0 + dc
                clat, clon = (rr + 0.5) * DLAT, 100 + (cc + 0.5) * DLON
                if dist(clat, clon, lat, lon) <= max_bus:
                    cand.add((rr, cc))
    cells = []  # (code, lat, lon, class, pop/4)
    area_cache: dict[str, float] = {}
    for rr, cc in sorted(cand):
        clat, clon = (rr + 0.5) * DLAT, 100 + (cc + 0.5) * DLON
        code = code11(clat, clon)
        parent = code[:10]
        pop = pop250.get(parent, 0)
        if not pop >= 1:
            continue
        if code in did125:
            cls = "urban"
        else:
            if parent not in area_cache:
                area_cache[parent] = area_km2_code10(parent)
            cls = "suburban" if pop / area_cache[parent] >= THRESHOLD else "rural"
        cells.append((code, clat, clon, cls, pop / 4))
    print("cells", len(cells))

    # 起点を 0.02度の格子に分けて、近いものだけ距離を測る
    grid: dict[tuple[int, int], list[str]] = {}
    for sid, (lat, lon) in origins.items():
        grid.setdefault((math.floor(lat / 0.02), math.floor(lon / 0.02)), []).append(sid)

    def origins_near(lat: float, lon: float, radius: float) -> list[str]:
        gy, gx = math.floor(lat / 0.02), math.floor(lon / 0.02)
        out = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for sid in grid.get((gy + dy, gx + dx), []):
                    olat, olon = origins[sid]
                    if dist(lat, lon, olat, olon) <= radius:
                        out.append(sid)
        return out

    lost = [set() for _ in BANDS]  # セルの番号
    coverable_count = 0
    for i, (code, clat, clon, cls, _) in enumerate(cells):
        bus, rail = WALK[cls][0] * SPEED, WALK[cls][1] * SPEED
        if any(dist(clat, clon, slat, slon) <= rail for slat, slon in stations):
            coverable_count += 1
            continue  # 駅で全時間帯に到達できる(前後とも)ので、外れない
        near = origins_near(clat, clon, bus)
        if not near:
            continue
        coverable_count += 1
        for b in range(len(BANDS)):
            was = any(dep_before.get(sid, [0] * 6)[b] > 0 for sid in near)
            now = any(dep_after.get(sid, [0] * 6)[b] > 0 for sid in near)
            if was and not now:
                lost[b].add(i)
    print("coverable", coverable_count)
    print("lost per band", [len(x) for x in lost])
    print("lost pop per band", [sum(cells[i][4] for i in x) for x in lost])

    # 候補:基準の平日便のうち、編集後の平日便に同じ署名の便が無いもの
    def signature(route_id: str, rows: list[dict]) -> str:
        readable = sorted((r for r in rows if seq_of(r) is not None), key=seq_of)
        rest = [r for r in rows if seq_of(r) is None]
        parts = [f"{s(r.get('stop_id'))},{s(r.get('arrival_time'))},{s(r.get('departure_time'))}" for r in readable + rest]
        return f"{route_id}\t{';'.join(parts)}"

    edited_sigs = set()
    for t in edited["trips"]:
        if s(t.get("service_id")) == WEEKDAY_SERVICE:
            edited_sigs.add(signature(s(t.get("route_id")), edited_groups.get(s(t.get("trip_id")), [])))
    base_active = active_services(base["calendar"], base["calendar_dates"], DATE)
    candidates = []
    for t in base["trips"]:
        if s(t.get("service_id")) != WEEKDAY_SERVICE:
            continue
        tid = s(t.get("trip_id"))
        if signature(s(t.get("route_id")), base_groups.get(tid, [])) in edited_sigs:
            continue
        candidates.append(tid)
    print("candidates", len(candidates), "weekday active on date", WEEKDAY_SERVICE in base_active)

    cache: dict[tuple[str, int], set[int]] = {}

    def restored_by(sid: str, b: int) -> set[int]:
        key = (sid, b)
        if key not in cache:
            lat, lon = origins[sid]
            got = set()
            for i in lost[b]:
                _, clat, clon, cls, _ = cells[i]
                if dist(clat, clon, lat, lon) <= WALK[cls][0] * SPEED:
                    got.add(i)
            cache[key] = got
        return cache[key]

    result = {}
    for tid in sorted(candidates):
        rows = base_groups.get(tid, [])
        last = last_seq(rows)
        only = False
        got: set[int] = set()
        for r in rows:
            if s(r.get("pickup_type")) == "1":
                continue
            q = seq_of(r)
            if q is not None and q == last:
                continue
            sid = s(r.get("stop_id"))
            dep = s(r.get("departure_time"))
            sec = parse_time(dep)
            if sec is None:
                continue
            b = band_index(sec)
            if b < 0:
                continue
            if dep_after.get(sid, [0] * 6)[b] == 0:
                only = True
            if sid in origins:
                got |= restored_by(sid, b)
        pop4 = sum(cells[i][4] for i in got) * 4
        assert pop4 == int(pop4)
        result[tid] = {"cells": len(got), "pop4": int(pop4), "only": only}

    lines = [f"{tid}:{v['cells']}:{v['pop4']}:{1 if v['only'] else 0}" for tid, v in sorted(result.items())]
    digest = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
    with_cells = sorted((tid for tid, v in result.items() if v["cells"] > 0))
    print("with restoresLostCells", len(with_cells), "with onlyServiceAtStop", sum(1 for v in result.values() if v["only"]))
    print("sha", digest)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"sha": digest, "result": result, "lost": [len(x) for x in lost]}, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
