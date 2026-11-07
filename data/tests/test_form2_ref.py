"""形2の参照実装(data/tools/form2_ref.py)の確認。

参照実装は import せず、利用者の手元と同じ `python -I` の別プロセスで動かす。
- 手で作った小さな GTFS(ZIP は一時フォルダに作る)で、規則どおりに便が入れ替わることを確かめる。
- 道北バスの GTFS(9/17 版)が data/raw/gtfs/ にあれば、5 つの場面の出力を正解データ(SHA-256)と照らす。
  ZIP が無い、または別の版なら飛ばす。
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

DATA_DIR = Path(__file__).resolve().parents[1]
TOOL = DATA_DIR / "tools" / "form2_ref.py"
POLICIES = DATA_DIR / "tools" / "policies"
DOHOKU_ZIP = DATA_DIR / "raw" / "gtfs" / "dohoku_bus_減便前.zip"
# 9/17 作成の版(feed_version 202609171038)。正解データはこの版から作った
DOHOKU_ZIP_SHA256 = "d81998880e2141d0f405c65fd2b2e5e2c9516842b94d61dd59f1cc54cf451abb"
GENERATED_AT = "202611041200"
OUTPUT_FILES = ["trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "feed_info.txt"]

# 正解データ(場面ごとの出力 5 表の SHA-256 と、平日の便数)。
# 道北バス(北海道オープンデータプラットフォーム、CC BY 4.0)の 9/17 版を加工して作った。
GOLDEN = {
    "main": {
        "weekday": 382,
        "sha256": {
            "trips.txt": "ce5d460a766a8a2d5c1e644b5b91104ee79d7327ad955c5a0d8c23fe4df95369",
            "stop_times.txt": "ef6e0dd2fbded3b981c57793b75b536385681442db320d28d35c321ba627a378",
            "calendar.txt": "4e1b57ad128edcd7c78f229ea4f6ea0976b5744632bae534046f898551101f90",
            "calendar_dates.txt": "56d5b677d6a98d2575891c82d5de71bcf480123c197b6a7a0335cd78cfe3cfe0",
            "feed_info.txt": "63db1a10cdf687daed5245899708b0171f5bce6c8fa50f5bc5500fe3c407dace",
        },
    },
    # main に除外系統の 4 便を足し戻しに足したもの。出力は main と同じになる
    "addBack24": {
        "weekday": 382,
        "sha256": {
            "trips.txt": "ce5d460a766a8a2d5c1e644b5b91104ee79d7327ad955c5a0d8c23fe4df95369",
            "stop_times.txt": "ef6e0dd2fbded3b981c57793b75b536385681442db320d28d35c321ba627a378",
            "calendar.txt": "4e1b57ad128edcd7c78f229ea4f6ea0976b5744632bae534046f898551101f90",
            "calendar_dates.txt": "56d5b677d6a98d2575891c82d5de71bcf480123c197b6a7a0335cd78cfe3cfe0",
            "feed_info.txt": "63db1a10cdf687daed5245899708b0171f5bce6c8fa50f5bc5500fe3c407dace",
        },
    },
    "replaceOnly": {
        "weekday": 361,
        "sha256": {
            "trips.txt": "8aa9c6c3baafc8436a267c2a26ab9a7a8eeba01955b45e7452c2d79bf2ee3d20",
            "stop_times.txt": "e1a0d696825a4448928a26c5d028a2d291b23f6a8d43cb7550927f1b6065e462",
            "calendar.txt": "4e1b57ad128edcd7c78f229ea4f6ea0976b5744632bae534046f898551101f90",
            "calendar_dates.txt": "56d5b677d6a98d2575891c82d5de71bcf480123c197b6a7a0335cd78cfe3cfe0",
            "feed_info.txt": "63db1a10cdf687daed5245899708b0171f5bce6c8fa50f5bc5500fe3c407dace",
        },
    },
    # 期間 20261027〜20261110(有効期間 15 日)。calendar_dates は期間内の 3 行だけ
    "periodEnd": {
        "weekday": 382,
        "sha256": {
            "trips.txt": "ce5d460a766a8a2d5c1e644b5b91104ee79d7327ad955c5a0d8c23fe4df95369",
            "stop_times.txt": "ef6e0dd2fbded3b981c57793b75b536385681442db320d28d35c321ba627a378",
            "calendar.txt": "5012ad81e5932840447f252dddfe0df87eb83aae0b6fba5b2f5ac7c844ec2cbf",
            "calendar_dates.txt": "7e4af715bff71dc82afb97a63eee103120f8d7a4b828f817e749b06a03714c5b",
            "feed_info.txt": "84ee79e3ffca3ec9a6bdb1d59ca3fd03e99a68cbc9eae057392115d5daa84cbf",
        },
    },
    # 足し戻しに重なり・既にある便・除外系統・無い便・土曜便・重複を混ぜたもの
    "edgeCases": {
        "weekday": 364,
        "sha256": {
            "trips.txt": "7f14b82becb5513867103a1aa2b7fcc77c1b6fac4c663f296e74a0dc3925083c",
            "stop_times.txt": "6fc938305ac176b7cd6f9edc29e33fb38d6945d948fe7a36b03be70c11df7fd6",
            "calendar.txt": "4e1b57ad128edcd7c78f229ea4f6ea0976b5744632bae534046f898551101f90",
            "calendar_dates.txt": "56d5b677d6a98d2575891c82d5de71bcf480123c197b6a7a0335cd78cfe3cfe0",
            "feed_info.txt": "63db1a10cdf687daed5245899708b0171f5bce6c8fa50f5bc5500fe3c407dace",
        },
    },
}


def run_tool(gtfs: Path, policy: Path, out: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    """参照実装を別プロセスで動かす(`python -I`。標準ライブラリだけで動く)。"""
    return subprocess.run(
        [sys.executable, "-I", str(TOOL), "--gtfs", str(gtfs), "--policy", str(policy),
         "--out", str(out), "--generated-at", GENERATED_AT, *extra],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------- 手で作った小さな GTFS


def csv_text(header: str, rows: list[str]) -> bytes:
    """道北バスと同じ、BOM なし・CRLF・最終行も CRLF の CSV。"""
    return ("\r\n".join([header, *rows]) + "\r\n").encode("utf-8")


def make_small_zip(path: Path) -> Path:
    """平日(01)・土曜(03)・日祝(06)の service を持つ小さな GTFS。

    路線 R1 の平日 4 便、土曜 2 便、路線 R2 の平日 1 便(除外する系統)。
    土曜の 0004_01_01_03_1000 は平日の 0004_01_01_01_1000 と署名(路線と停留所ごとの時刻)が同じ。
    """
    stop_times = []

    def trip(trip_id: str, dep1: str, dep2: str) -> None:
        stop_times.append(f"{trip_id},{dep1},{dep1},S1,1")
        stop_times.append(f"{trip_id},{dep2},{dep2},S2,2")

    trips_rows = [
        "R1,01,0001_01_01_01_0700,A行き",
        "R1,01,0002_01_01_01_0800,A行き",
        "R2,01,0003_01_01_01_0900,B行き",
        "R1,01,0004_01_01_01_1000,A行き",
        "R1,03,0004_01_01_03_1000,A行き",
        "R1,03,0005_01_01_03_1100,A行き",
    ]
    trip("0001_01_01_01_0700", "07:00:00", "07:10:00")
    trip("0002_01_01_01_0800", "08:00:00", "08:10:00")
    trip("0003_01_01_01_0900", "09:00:00", "09:10:00")
    trip("0004_01_01_01_1000", "10:00:00", "10:10:00")
    trip("0004_01_01_03_1000", "10:00:00", "10:10:00")
    trip("0005_01_01_03_1100", "11:00:00", "11:10:00")

    files = {
        "trips.txt": csv_text("route_id,service_id,trip_id,trip_headsign", sorted(trips_rows, key=lambda r: (r.split(",")[1], r.split(",")[2]))),
        "stop_times.txt": csv_text("trip_id,arrival_time,departure_time,stop_id,stop_sequence", stop_times),
        "calendar.txt": csv_text(
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
            [
                "01,1,1,1,1,1,0,0,20261001,20261130",
                "03,0,0,0,0,0,1,0,20261001,20261130",
                "06,0,0,0,0,0,0,1,20261001,20261130",
            ],
        ),
        "calendar_dates.txt": csv_text(
            "service_id,date,exception_type",
            ["01,20261103,2", "06,20261103,1"],
        ),
        "feed_info.txt": csv_text(
            "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version",
            ["テストバス,https://example.com/,ja,20261001,20261130,202609171038"],
        ),
    }
    with zipfile.ZipFile(path, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return path


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    import csv

    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def write_policy(path: Path, **overrides: object) -> Path:
    policy: dict[str, object] = {
        "weekdayService": "01",
        "replacementService": "03",
        "period": {"start": "20261101", "end": None},
        "excludedRoutes": ["R2"],
        "addBackTripIds": ["0002_01_01_01_0800"],
    }
    policy.update(overrides)
    path.write_text(json.dumps(policy, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture
def small_zip(tmp_path: Path) -> Path:
    return make_small_zip(tmp_path / "small.zip")


def test_小さなGTFSで平日の便が入れ替わる(small_zip: Path, tmp_path: Path):
    out = tmp_path / "out"
    res = run_tool(small_zip, write_policy(tmp_path / "policy.json"), out)
    assert res.returncode == 0, res.stderr

    trips = read_csv_rows(out / "trips.txt")
    weekday = sorted(t["trip_id"] for t in trips if t["service_id"] == "01")
    # 土曜の 2 便を写した 2 便(service の部分を 01 に)、除外系統の 1 便、足し戻した 1 便。
    # 0001 は消え、0004 は署名の同じ土曜の写しに置き換わる
    assert weekday == [
        "0002_01_01_01_0800",
        "0003_01_01_01_0900",
        "0004_01_01_01_1000",
        "0005_01_01_01_1100",
    ]
    # 土曜・日祝の便は変えない
    assert sorted(t["trip_id"] for t in trips if t["service_id"] == "03") == [
        "0004_01_01_03_1000",
        "0005_01_01_03_1100",
    ]

    summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    assert summary["tripIds"]["removed"] == ["0001_01_01_01_0700", "0004_01_01_01_1000"]
    assert summary["tripIds"]["kept"] == ["0003_01_01_01_0900"]
    assert summary["tripIds"]["addedBack"] == ["0002_01_01_01_0800"]
    assert summary["output"]["weekday"]["composition"] == {
        "fromReplacement": 2,
        "keptExcludedRoutes": 1,
        "addedBack": 1,
    }
    assert summary["addBack"]["accepted"] == ["0002_01_01_01_0800"]
    assert summary["warnings"] == []


def test_stop_timesは写し元の行のままtrip_idだけ変わる(small_zip: Path, tmp_path: Path):
    out = tmp_path / "out"
    assert run_tool(small_zip, write_policy(tmp_path / "policy.json"), out).returncode == 0
    rows = read_csv_rows(out / "stop_times.txt")
    derived = [r for r in rows if r["trip_id"] == "0005_01_01_01_1100"]
    assert [(r["stop_id"], r["arrival_time"], r["departure_time"], r["stop_sequence"]) for r in derived] == [
        ("S1", "11:00:00", "11:00:00", "1"),
        ("S2", "11:10:00", "11:10:00", "2"),
    ]
    # 消えた便の stop_times も残らない
    assert not [r for r in rows if r["trip_id"] == "0001_01_01_01_0700"]


def test_有効期間と書き方は入力に合わせる(small_zip: Path, tmp_path: Path):
    out = tmp_path / "out"
    assert run_tool(small_zip, write_policy(tmp_path / "policy.json"), out).returncode == 0
    # 開始日が 11/1 になり、calendar の端と feed_info がそろう。feed_version は作成日時
    calendar = {r["service_id"]: (r["start_date"], r["end_date"]) for r in read_csv_rows(out / "calendar.txt")}
    assert calendar == {"01": ("20261101", "20261130"), "03": ("20261101", "20261130"), "06": ("20261101", "20261130")}
    info = read_csv_rows(out / "feed_info.txt")[0]
    assert (info["feed_start_date"], info["feed_end_date"], info["feed_version"]) == ("20261101", "20261130", GENERATED_AT)
    # CRLF・BOM なしのまま
    data = (out / "trips.txt").read_bytes()
    assert not data.startswith(b"\xef\xbb\xbf")
    assert data.endswith(b"\r\n") and b"\n" not in data.replace(b"\r\n", b"")


def test_同じ入力と同じ作成日時から同じバイト列が出る(small_zip: Path, tmp_path: Path):
    policy = write_policy(tmp_path / "policy.json")
    a, b = tmp_path / "a", tmp_path / "b"
    assert run_tool(small_zip, policy, a).returncode == 0
    assert run_tool(small_zip, policy, b).returncode == 0
    for name in [*OUTPUT_FILES, "summary.json"]:
        assert (a / name).read_bytes() == (b / name).read_bytes(), name


def test_足し戻しの分類(small_zip: Path, tmp_path: Path):
    policy = write_policy(
        tmp_path / "policy.json",
        addBackTripIds=[
            "0002_01_01_01_0800",  # 受け付ける
            "0002_01_01_01_0800",  # 重複
            "0003_01_01_01_0900",  # 除外系統
            "0004_01_01_01_1000",  # 土曜の写しと署名が同じ
            "0004_01_01_03_1000",  # 平日の便ではない
            "9999_01_01_01_0000",  # 無い
        ],
    )
    out = tmp_path / "out"
    assert run_tool(small_zip, policy, out).returncode == 0
    ab = json.loads((out / "summary.json").read_text(encoding="utf-8"))["addBack"]
    assert ab["requested"] == 6
    assert ab["accepted"] == ["0002_01_01_01_0800"]
    assert ab["duplicate"] == ["0002_01_01_01_0800"]
    assert ab["ignoredExcludedRoute"] == ["0003_01_01_01_0900"]
    assert [x["tripId"] for x in ab["ignoredAlreadyPresent"]] == ["0004_01_01_01_1000"]
    assert ab["notWeekday"] == ["0004_01_01_03_1000"]
    assert ab["notFound"] == ["9999_01_01_01_0000"]


def test_入力を読み直して書くとバイト単位で一致する(small_zip: Path, tmp_path: Path):
    res = run_tool(small_zip, write_policy(tmp_path / "policy.json"), tmp_path / "out", "--self-test")
    assert res.returncode == 0, res.stderr


def test_作成日時が無ければ使い方を出して止まる(small_zip: Path, tmp_path: Path):
    res = subprocess.run(
        [sys.executable, "-I", str(TOOL), "--gtfs", str(small_zip), "--policy", str(write_policy(tmp_path / "p.json")),
         "--out", str(tmp_path / "out")],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert res.returncode != 0
    assert "--generated-at" in res.stderr


def test_方針のJSONがリポジトリに揃っている():
    assert sorted(p.stem for p in POLICIES.glob("*.json")) == sorted(GOLDEN)
    for p in POLICIES.glob("*.json"):
        policy = json.loads(p.read_text(encoding="utf-8"))
        assert policy["weekdayService"] == "01" and policy["replacementService"] == "03"


# ---------------------------------------------------------------- 道北バスの GTFS(実データ)


@pytest.fixture(scope="module")
def dohoku_zip() -> Path:
    if not DOHOKU_ZIP.is_file():
        pytest.skip(f"道北バスの GTFS がありません: {DOHOKU_ZIP}")
    if sha256(DOHOKU_ZIP) != DOHOKU_ZIP_SHA256:
        pytest.skip("道北バスの GTFS が 9/17 版(正解データを作った版)ではありません")
    return DOHOKU_ZIP


@pytest.mark.parametrize("scene", sorted(GOLDEN))
def test_道北バスの出力が正解データとバイト単位で一致する(scene: str, dohoku_zip: Path, tmp_path: Path):
    out = tmp_path / scene
    res = run_tool(dohoku_zip, POLICIES / f"{scene}.json", out)
    assert res.returncode == 0, res.stderr
    assert f"weekday trips {GOLDEN[scene]['weekday']} " in res.stdout
    for name, expected in GOLDEN[scene]["sha256"].items():
        assert sha256(out / name) == expected, f"{scene}/{name}"
    # summary.json の files も同じ値を持つ
    summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    assert {n: v["sha256"] for n, v in summary["files"].items()} == GOLDEN[scene]["sha256"]
    assert summary["warnings"] == []


def test_道北バスで入力の表を読み直して書くと一致する(dohoku_zip: Path, tmp_path: Path):
    res = run_tool(dohoku_zip, POLICIES / "main.json", tmp_path / "out", "--self-test")
    assert res.returncode == 0, res.stderr


def test_mainは平日382便で足し戻しは20便(dohoku_zip: Path, tmp_path: Path):
    out = tmp_path / "out"
    assert run_tool(dohoku_zip, POLICIES / "main.json", out).returncode == 0
    summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    assert summary["output"]["weekday"]["tripCount"] == 382
    assert summary["output"]["weekday"]["composition"] == {"fromReplacement": 354, "keptExcludedRoutes": 8, "addedBack": 20}
    assert (summary["output"]["feedStartDate"], summary["output"]["feedEndDate"], summary["output"]["validityDays"]) == (
        "20261101",
        "20261130",
        30,
    )
    assert summary["output"]["feedVersion"] == GENERATED_AT
