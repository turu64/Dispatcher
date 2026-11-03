#!/usr/bin/env python3
"""形2(便の入れ替え)の参照実装。標準ライブラリだけを使う。

TypeScript の実装と照らすための、独立に書いた実装。ほかのスクリプトを import しない。

使い方:
    python3 -I form2_ref.py --gtfs IN.zip --policy POLICY.json --out OUTDIR \
        --generated-at YYYYMMDDhhmm [--self-test]

方針の JSON:
    {"weekdayService": "01", "replacementService": "03",
     "period": {"start": "YYYYMMDD", "end": "YYYYMMDD" | null},
     "excludedRoutes": ["0051", ...], "addBackTripIds": ["...", ...]}

出力(OUTDIR):
    trips.txt, stop_times.txt, calendar.txt, calendar_dates.txt, feed_info.txt, summary.json
規則、署名、summary.json の項目と並びは、同じフォルダの README.md を参照。
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import zipfile

SCHEMA = "dispatcher-form2-summary/1"
# 道北バスの trip_id:{運用 4桁}_{運用内の順番 2桁}_{01 固定 2桁}_{service_id 2桁}_{始発の発時刻 HHMM}
TRIP_ID_RE = re.compile(r"^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{4})$")
FEED_VERSION_RE = re.compile(r"^\d{12}$")
DATE_RE = re.compile(r"^\d{8}$")
NOTICE47_BANDS = ["06-09", "10-14", "15-19", "20-05"]
REACH_BANDS = [(6, 9), (9, 12), (12, 15), (15, 18), (18, 21), (21, 24)]
OUTPUT_TABLES = ["trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "feed_info.txt"]


# ---------------------------------------------------------------- CSV の読み書き


class Table:
    """CSV 1 表。見出しの並び、BOM、改行コードを入力のまま保つ。"""

    def __init__(self, name: str, header: list[str], rows: list[dict[str, str]], bom: bool, newline: str):
        self.name = name
        self.header = header
        self.rows = rows
        self.bom = bom
        self.newline = newline


def read_table(zf: zipfile.ZipFile, name: str) -> Table | None:
    if name not in zf.namelist():
        return None
    raw = zf.read(name)
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    newline = "\r\n" if "\r\n" in text else "\n"
    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader)
    rows = []
    for rec in reader:
        if not rec or (len(rec) == 1 and rec[0] == ""):
            continue
        rec = rec + [""] * (len(header) - len(rec))
        rows.append(dict(zip(header, rec)))
    return Table(name, header, rows, bom, newline)


def serialize_table(t: Table) -> bytes:
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator=t.newline, quoting=csv.QUOTE_MINIMAL)
    w.writerow(t.header)
    for r in t.rows:
        w.writerow([r.get(h, "") for h in t.header])
    data = buf.getvalue().encode("utf-8")
    return (b"\xef\xbb\xbf" + data) if t.bom else data


# ---------------------------------------------------------------- 時刻と署名


def time_to_sec(s: str) -> int | None:
    s = s.strip()
    if not s:
        return None
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


def hour_key(s: str) -> str:
    return "%02d" % int(s.strip().split(":")[0])


def group_stop_times(st: Table) -> dict[str, list[dict[str, str]]]:
    by: dict[str, list[dict[str, str]]] = {}
    for r in st.rows:
        by.setdefault(r["trip_id"], []).append(r)
    return by


def ordered(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(rows, key=lambda r: int(r["stop_sequence"]))


def signature_line(route_id: str, rows: list[dict[str, str]]) -> str:
    """署名:route_id、タブ、停留所ごとの「stop_id,到着,出発」をセミコロンでつないだもの。"""
    return route_id + "\t" + ";".join(
        "%s,%s,%s" % (r["stop_id"], r["arrival_time"], r["departure_time"]) for r in ordered(rows)
    )


def digest(lines: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(lines)).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- 集計


def service_metrics(trips: list[dict[str, str]], by: dict[str, list[dict[str, str]]]) -> dict:
    """1 つの service の便の集計。項目の並びは README.md のとおり。"""
    by_route: dict[str, int] = {}
    by_first_hour: dict[str, int] = {}
    notice47 = {k: 0 for k in NOTICE47_BANDS}
    dep_by_hour: dict[str, int] = {}
    band_stops: dict[str, set[str]] = {"%02d-%02d" % b: set() for b in REACH_BANDS}
    untimed = 0
    lines = []
    for t in trips:
        rows = ordered(by.get(t["trip_id"], []))
        by_route[t["route_id"]] = by_route.get(t["route_id"], 0) + 1
        lines.append(signature_line(t["route_id"], rows))
        if rows:
            first = rows[0]["departure_time"] or rows[0]["arrival_time"]
            hk = hour_key(first)
            by_first_hour[hk] = by_first_hour.get(hk, 0) + 1
            h = int(hk)
            if 6 <= h <= 9:
                notice47["06-09"] += 1
            elif 10 <= h <= 14:
                notice47["10-14"] += 1
            elif 15 <= h <= 19:
                notice47["15-19"] += 1
            else:
                notice47["20-05"] += 1
        for r in rows:
            if (r.get("pickup_type") or "0") == "1":
                continue
            sec = time_to_sec(r["departure_time"])
            if sec is None:
                untimed += 1
                continue
            hk = "%02d" % (sec // 3600)
            dep_by_hour[hk] = dep_by_hour.get(hk, 0) + 1
            for a, b in REACH_BANDS:
                if a * 3600 <= sec < b * 3600:
                    band_stops["%02d-%02d" % (a, b)].add(r["stop_id"])
    return {
        "tripCount": len(trips),
        "stopTimeCount": sum(len(by.get(t["trip_id"], [])) for t in trips),
        "tripCountByRoute": dict(sorted(by_route.items())),
        "tripsByFirstDepartureHour": dict(sorted(by_first_hour.items())),
        "tripsByNotice47Band": notice47,
        "departuresByHour": dict(sorted(dep_by_hour.items())),
        "untimedDepartureRows": untimed,
        "stopsWithDeparturesBy3hBand": {k: len(v) for k, v in band_stops.items()},
        "signatureDigest": digest(lines),
    }


# ---------------------------------------------------------------- 本体


def detect_trip_order(rows: list[dict[str, str]]) -> str:
    keys_st = [(r["service_id"], r["trip_id"]) for r in rows]
    if keys_st == sorted(keys_st):
        return "service_id,trip_id"
    keys_t = [r["trip_id"] for r in rows]
    if keys_t == sorted(keys_t):
        return "trip_id"
    return "input"


def detect_stop_times_order(st: Table, trips: Table) -> str:
    seen: list[str] = []
    for r in st.rows:
        if not seen or seen[-1] != r["trip_id"]:
            seen.append(r["trip_id"])
    if len(seen) == len(set(seen)) and seen == [t["trip_id"] for t in trips.rows if t["trip_id"] in set(seen)]:
        return "trips"
    return "input"


def derive_trip_id(src_id: str, weekday: str, replacement: str) -> str:
    """規則:入れ替え元(土曜など)の trip_id の service の部分を平日の service_id に置き換える。"""
    m = TRIP_ID_RE.match(src_id)
    if m and m.group(4) == replacement:
        g = list(m.groups())
        g[3] = weekday
        return "_".join(g)
    # 道北バスの形でない trip_id の仮の規則
    return "%s_%s" % (src_id, weekday)


def new_feed_version(old: str, generated_at: str) -> str:
    if FEED_VERSION_RE.match(old or ""):
        return generated_at
    if not old:
        return generated_at
    return "%s_dispatcher_%s" % (old, generated_at)


def days_between(a: str, b: str) -> int:
    da = dt.date(int(a[:4]), int(a[4:6]), int(a[6:]))
    db = dt.date(int(b[:4]), int(b[4:6]), int(b[6:]))
    return (db - da).days + 1


def run(gtfs_path: str, policy: dict, out_dir: str, generated_at: str, self_test: bool = False) -> dict:
    if not re.match(r"^\d{12}$", generated_at):
        raise SystemExit("--generated-at は YYYYMMDDhhmm")
    zf = zipfile.ZipFile(gtfs_path)
    trips = read_table(zf, "trips.txt")
    st = read_table(zf, "stop_times.txt")
    cal = read_table(zf, "calendar.txt")
    cd = read_table(zf, "calendar_dates.txt")
    fi = read_table(zf, "feed_info.txt")
    routes = read_table(zf, "routes.txt")
    if trips is None or st is None:
        raise SystemExit("trips.txt と stop_times.txt が必要")

    if self_test:
        for name in zf.namelist():
            if not name.endswith(".txt"):
                continue
            t = read_table(zf, name)
            if serialize_table(t) != zf.read(name):
                raise SystemExit("self-test: %s を読み直して書くと入力と一致しない" % name)

    weekday = policy["weekdayService"]
    repl = policy["replacementService"]
    period = policy.get("period") or {}
    p_start = period.get("start")
    p_end = period.get("end")
    excluded = list(policy.get("excludedRoutes") or [])
    excluded_set = set(excluded)
    add_req = list(policy.get("addBackTripIds") or [])
    warnings: list[str] = []
    if not (p_start and DATE_RE.match(p_start)):
        raise SystemExit("period.start は YYYYMMDD")
    if p_end is not None and not DATE_RE.match(p_end):
        raise SystemExit("period.end は YYYYMMDD か null")

    by = group_stop_times(st)
    tmap = {t["trip_id"]: t for t in trips.rows}
    sig = {t["trip_id"]: signature_line(t["route_id"], by.get(t["trip_id"], [])) for t in trips.rows}
    route_ids = {r["route_id"] for r in routes.rows} if routes else set()

    services_in_trips = {t["service_id"] for t in trips.rows}
    for s, label in ((weekday, "weekdayService"), (repl, "replacementService")):
        if s not in services_in_trips:
            warnings.append("%s %s の便がない" % (label, s))
    for r in excluded:
        if routes and r not in route_ids:
            warnings.append("excludedRoutes %s は routes.txt にない" % r)

    w_trips = [t for t in trips.rows if t["service_id"] == weekday]
    s_trips = [t for t in trips.rows if t["service_id"] == repl]

    kept = [t for t in w_trips if t["route_id"] in excluded_set]
    sources = [t for t in s_trips if t["route_id"] not in excluded_set]
    source_sigs: dict[str, str] = {}
    for t in sources:
        source_sigs.setdefault(sig[t["trip_id"]], t["trip_id"])

    # 足し戻し
    ab = {
        "requested": len(add_req),
        "accepted": [],
        "ignoredExcludedRoute": [],
        "ignoredAlreadyPresent": [],
        "notWeekday": [],
        "notFound": [],
        "duplicate": [],
    }
    seen_req: set[str] = set()
    accepted_sigs: dict[str, str] = {}
    for tid in add_req:
        if tid in seen_req:
            ab["duplicate"].append(tid)
            continue
        seen_req.add(tid)
        t = tmap.get(tid)
        if t is None:
            ab["notFound"].append(tid)
        elif t["service_id"] != weekday:
            ab["notWeekday"].append(tid)
        elif t["route_id"] in excluded_set:
            ab["ignoredExcludedRoute"].append(tid)
        elif sig[tid] in source_sigs:
            ab["ignoredAlreadyPresent"].append({"tripId": tid, "sameAs": source_sigs[sig[tid]]})
        elif sig[tid] in accepted_sigs:
            ab["ignoredAlreadyPresent"].append({"tripId": tid, "sameAs": accepted_sigs[sig[tid]]})
        else:
            ab["accepted"].append(tid)
            accepted_sigs[sig[tid]] = tid
    for k in ("accepted", "ignoredExcludedRoute", "notWeekday", "notFound", "duplicate"):
        ab[k] = sorted(ab[k])
    ab["ignoredAlreadyPresent"].sort(key=lambda x: x["tripId"])
    accepted_set = set(ab["accepted"])
    added = [t for t in w_trips if t["trip_id"] in accepted_set]

    # trip_id の割り当て。元の平日便(除外系統の便、足し戻した便)と他の service の便の id を先に押さえる
    retained_ids = {t["trip_id"] for t in trips.rows if t["service_id"] != weekday}
    retained_ids |= {t["trip_id"] for t in kept}
    retained_ids |= accepted_set
    used = set(retained_ids)
    derived_rows = []
    derived_map = []
    collisions = []
    for t in sorted(sources, key=lambda x: x["trip_id"]):
        cand = derive_trip_id(t["trip_id"], weekday, repl)
        new_id = cand
        n = 2
        while new_id in used:
            new_id = "%s_%d" % (cand, n)
            n += 1
        if new_id != cand:
            other = tmap.get(cand)
            collisions.append({
                "from": t["trip_id"],
                "candidate": cand,
                "assigned": new_id,
                "collidedWithService": other["service_id"] if other else None,
            })
        used.add(new_id)
        row = dict(t)
        row["trip_id"] = new_id
        row["service_id"] = weekday
        derived_rows.append((row, t["trip_id"]))
        derived_map.append({"from": t["trip_id"], "to": new_id})

    removed = sorted(t["trip_id"] for t in w_trips if t["route_id"] not in excluded_set and t["trip_id"] not in accepted_set)

    # trips の行
    order_mode = detect_trip_order(trips.rows)
    keep_ids = {t["trip_id"] for t in kept} | accepted_set
    out_trip_rows = [t for t in trips.rows if t["service_id"] != weekday or t["trip_id"] in keep_ids]
    src_of: dict[str, str] = {}
    for row, src in derived_rows:
        src_of[row["trip_id"]] = src
    if order_mode == "service_id,trip_id":
        out_trip_rows = sorted(out_trip_rows + [r for r, _ in derived_rows], key=lambda r: (r["service_id"], r["trip_id"]))
    elif order_mode == "trip_id":
        out_trip_rows = sorted(out_trip_rows + [r for r, _ in derived_rows], key=lambda r: r["trip_id"])
    else:
        out_trip_rows = out_trip_rows + [r for r, _ in derived_rows]
    out_trips = Table("trips.txt", trips.header, out_trip_rows, trips.bom, trips.newline)

    # stop_times の行
    st_mode = detect_stop_times_order(st, trips)
    out_ids = [r["trip_id"] for r in out_trip_rows]
    out_id_set = set(out_ids)

    def rows_for(tid: str) -> list[dict[str, str]]:
        if tid in src_of:
            res = []
            for r in by.get(src_of[tid], []):
                c = dict(r)
                c["trip_id"] = tid
                res.append(c)
            return res
        return by.get(tid, [])

    if st_mode == "trips":
        out_st_rows = [r for tid in out_ids for r in rows_for(tid)]
    else:
        out_st_rows = [r for r in st.rows if r["trip_id"] in out_id_set and r["trip_id"] not in src_of]
        for row, _ in derived_rows:
            out_st_rows.extend(rows_for(row["trip_id"]))
    out_st = Table("stop_times.txt", st.header, out_st_rows, st.bom, st.newline)

    # 有効期間
    in_feed_start = fi.rows[0].get("feed_start_date") if fi and fi.rows else None
    in_feed_end = fi.rows[0].get("feed_end_date") if fi and fi.rows else None
    cal_starts = [r["start_date"] for r in cal.rows] if cal else []
    cal_ends = [r["end_date"] for r in cal.rows] if cal else []
    cd_dates = [r["date"] for r in cd.rows] if cd else []
    if not in_feed_start:
        in_feed_start = min(cal_starts + cd_dates)
    if not in_feed_end:
        in_feed_end = max(cal_ends + cd_dates)
    new_start = max(in_feed_start, p_start)
    new_end = in_feed_end if p_end is None else min(in_feed_end, p_end)
    if p_start < in_feed_start:
        warnings.append("period.start %s が入力の開始日 %s より前なので %s にした" % (p_start, in_feed_start, new_start))
    if p_end is not None and p_end > in_feed_end:
        warnings.append("period.end %s が入力の末日 %s より後なので %s にした" % (p_end, in_feed_end, new_end))
    if new_start > new_end:
        raise SystemExit("新しい有効期間が空になる")
    validity_days = days_between(new_start, new_end)
    if validity_days <= 7:
        warnings.append("有効期間が %d 日で、7 日以下になる" % validity_days)

    out_cal_rows = []
    cal_summary = []
    if cal:
        for r in cal.rows:
            c = dict(r)
            c["start_date"] = max(r["start_date"], new_start)
            c["end_date"] = min(r["end_date"], new_end)
            if c["start_date"] > c["end_date"]:
                warnings.append("calendar の service_id %s は新しい有効期間に入らないので外した" % r["service_id"])
                continue
            out_cal_rows.append(c)
            cal_summary.append({"service_id": c["service_id"], "start_date": c["start_date"], "end_date": c["end_date"]})
    out_cal = Table("calendar.txt", cal.header, out_cal_rows, cal.bom, cal.newline) if cal else None

    out_cd_rows, dropped_cd = [], []
    if cd:
        for r in cd.rows:
            if new_start <= r["date"] <= new_end:
                out_cd_rows.append(r)
            else:
                dropped_cd.append({"service_id": r["service_id"], "date": r["date"], "exception_type": r["exception_type"]})
    out_cd = Table("calendar_dates.txt", cd.header, out_cd_rows, cd.bom, cd.newline) if cd else None

    old_fv = fi.rows[0].get("feed_version", "") if fi and fi.rows else ""
    new_fv = new_feed_version(old_fv, generated_at)
    if FEED_VERSION_RE.match(old_fv or "") and new_fv <= old_fv:
        warnings.append("新しい feed_version %s が入力の %s 以下" % (new_fv, old_fv))
    out_fi = None
    if fi:
        fr = [dict(r) for r in fi.rows]
        if fr:
            if "feed_start_date" in fi.header:
                fr[0]["feed_start_date"] = new_start
            if "feed_end_date" in fi.header:
                fr[0]["feed_end_date"] = new_end
            if "feed_version" in fi.header:
                fr[0]["feed_version"] = new_fv
        out_fi = Table("feed_info.txt", fi.header, fr, fi.bom, fi.newline)
    else:
        warnings.append("feed_info.txt がないので書かない")

    # 書き出し
    os.makedirs(out_dir, exist_ok=True)
    files = {}
    for t in (out_trips, out_st, out_cal, out_cd, out_fi):
        if t is None:
            continue
        data = serialize_table(t)
        with open(os.path.join(out_dir, t.name), "wb") as f:
            f.write(data)
        files[t.name] = {"rows": len(t.rows), "sha256": hashlib.sha256(data).hexdigest()}

    # 集計
    in_counts: dict[str, int] = {}
    for t in trips.rows:
        in_counts[t["service_id"]] = in_counts.get(t["service_id"], 0) + 1
    out_counts: dict[str, int] = {}
    for t in out_trip_rows:
        out_counts[t["service_id"]] = out_counts.get(t["service_id"], 0) + 1
    out_by = group_stop_times(out_st)
    out_w = [t for t in out_trip_rows if t["service_id"] == weekday]

    in_weekday = service_metrics(w_trips, by)
    out_weekday = service_metrics(out_w, out_by)
    in_sigs: dict[str, int] = {}
    for t in w_trips:
        in_sigs[sig[t["trip_id"]]] = in_sigs.get(sig[t["trip_id"]], 0) + 1
    out_sigs: dict[str, int] = {}
    for t in out_w:
        k = signature_line(t["route_id"], out_by.get(t["trip_id"], []))
        out_sigs[k] = out_sigs.get(k, 0) + 1
    same = sum(min(n, out_sigs.get(k, 0)) for k, n in in_sigs.items())
    out_weekday = {
        "tripCount": out_weekday.pop("tripCount"),
        "composition": {
            "fromReplacement": len(derived_rows),
            "keptExcludedRoutes": len(kept),
            "addedBack": len(added),
        },
        "versusInput": {
            "sameSignature": same,
            "removed": len(w_trips) - same,
            "added": len(out_w) - same,
        },
        **out_weekday,
    }

    summary = {
        "schema": SCHEMA,
        "generatedAt": generated_at,
        "input": {
            "feedVersion": old_fv,
            "feedStartDate": in_feed_start,
            "feedEndDate": in_feed_end,
            "tripCountByService": dict(sorted(in_counts.items())),
            "weekday": in_weekday,
        },
        "policy": {
            "weekdayService": weekday,
            "replacementService": repl,
            "period": {"start": p_start, "end": p_end},
            "excludedRoutes": excluded,
            "addBackTripIds": add_req,
        },
        "output": {
            "feedVersion": new_fv,
            "feedStartDate": new_start,
            "feedEndDate": new_end,
            "validityDays": validity_days,
            "tripCountByService": dict(sorted(out_counts.items())),
            "weekday": out_weekday,
            "calendar": cal_summary,
            "calendarDates": {"kept": len(out_cd_rows), "dropped": dropped_cd},
        },
        "tripIds": {
            "rule": "replace-service-part",
            "derived": derived_map,
            "kept": sorted(t["trip_id"] for t in kept),
            "addedBack": sorted(t["trip_id"] for t in added),
            "removed": removed,
            "collisions": collisions,
        },
        "addBack": ab,
        "rowOrder": {"trips": order_mode, "stop_times": st_mode},
        "files": files,
        "warnings": warnings,
    }
    with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="形2(便の入れ替え)の参照実装")
    ap.add_argument("--gtfs", required=True)
    ap.add_argument("--policy", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--generated-at", required=True, help="YYYYMMDDhhmm(日本時間)。feed_version に使う")
    ap.add_argument("--self-test", action="store_true", help="入力の各表を読み直して書き、バイト単位で一致するか確かめる")
    a = ap.parse_args(argv)
    with open(a.policy, encoding="utf-8") as f:
        policy = json.load(f)
    s = run(a.gtfs, policy, a.out, a.generated_at, a.self_test)
    w = s["output"]["weekday"]
    print("weekday trips %d (from replacement %d, kept %d, added back %d), warnings %d" % (
        w["tripCount"], w["composition"]["fromReplacement"], w["composition"]["keptExcludedRoutes"],
        w["composition"]["addedBack"], len(s["warnings"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
