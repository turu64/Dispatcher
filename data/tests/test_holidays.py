"""祝日一覧(内閣府の syukujitsu.csv)の変換。

手で作った小さな CSV(cp932。一時フォルダに作る)で規則とエラーを確かめ、
data/raw/holidays/ に実データがあれば件数・最後の祝日・2027 年の平日の祝日 5 日も確かめる(無ければ飛ばす)。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dispatcher_data.holidays import (
    SOURCE,
    URL,
    HolidayError,
    main,
    parse_date,
    parse_holiday_csv,
    run,
    to_json_text,
)

HEADER = "国民の祝日・休日月日,国民の祝日・休日名称"
REAL_CSV = Path(__file__).resolve().parents[1] / "raw" / "holidays" / "syukujitsu.csv"


def csv_bytes(*rows: str, header: str = HEADER, newline: str = "\r\n", bom: bool = False) -> bytes:
    """内閣府の CSV と同じ形(Shift_JIS、CRLF、最終行も CRLF)の小さな CSV。"""
    text = newline.join([header, *rows]) + newline
    data = text.encode("cp932")
    return (b"\xef\xbb\xbf" + data) if bom else data


# ---------------------------------------------------------------- 日付


@pytest.mark.parametrize(
    "text, expected",
    [
        ("1955/1/1", "19550101"),
        ("2027/11/23", "20271123"),
        ("2026/11/3", "20261103"),
        ("2024/2/29", "20240229"),  # うるう年
        (" 2027/3/22 ", "20270322"),
    ],
)
def test_日付はゼロを詰めずに書かれたY_M_DをYYYYMMDDにする(text: str, expected: str):
    assert parse_date(text, 2) == expected


@pytest.mark.parametrize("text", ["", "2027-01-01", "2027/1", "2027/1/1/1", "二〇二七/1/1", "2027/一/1", "2027/1/x", "２０２７/1/1"])
def test_読めない日付は行番号を出して止まる(text: str):
    with pytest.raises(HolidayError, match="7 行目:日付を読めません"):
        parse_date(text, 7)


@pytest.mark.parametrize("text", ["2027/2/30", "2027/2/29", "2027/13/1", "2027/0/1", "2027/1/0", "0/1/1", "10000/1/1"])
def test_実在しない日付は行番号を出して止まる(text: str):
    with pytest.raises(HolidayError, match="7 行目:実在しない日付です"):
        parse_date(text, 7)


# ---------------------------------------------------------------- CSV


def test_日付の昇順に並べて名称の前後の空白を取る():
    table = parse_holiday_csv(csv_bytes("2027/1/11,成人の日", "1955/1/1, 元日 ", "2026/11/3,文化の日"))
    assert table.holidays == [("19550101", "元日"), ("20261103", "文化の日"), ("20270111", "成人の日")]
    assert table.first == "19550101"
    assert table.last == "20270111"


def test_収録の終わりは最後の祝日の年の12月31日とみなす():
    # 最後の祝日が 11/23 でも、判定できる日は 2027-12-31 まで(内閣府は翌年の祝日を 1 年分まとめて載せる)
    table = parse_holiday_csv(csv_bytes("2027/1/1,元日", "2027/11/23,勤労感謝の日"))
    assert table.last == "20271123"
    assert table.covered_until == "20271231"


def test_振替休日と国民の休日の名称は休日のまま():
    table = parse_holiday_csv(csv_bytes("2027/3/21,春分の日", "2027/3/22,休日"))
    assert dict(table.holidays)["20270322"] == "休日"


def test_先頭のBOMがあれば取る():
    table = parse_holiday_csv(csv_bytes("2027/1/1,元日", bom=True))
    assert table.holidays == [("20270101", "元日")]


def test_UTF8で保存し直した版はcp932として読めず止まる():
    raw = (HEADER + "\r\n2027/1/1,元日\r\n").encode("utf-8")
    with pytest.raises(HolidayError):
        parse_holiday_csv(raw)


def test_LFだけの改行も読める():
    table = parse_holiday_csv(csv_bytes("2027/1/1,元日", newline="\n"))
    assert table.holidays == [("20270101", "元日")]


def test_最終行に改行が無くても読める():
    raw = csv_bytes("2027/1/1,元日")[:-2]
    assert parse_holiday_csv(raw).holidays == [("20270101", "元日")]


def test_空行は飛ばす():
    table = parse_holiday_csv(csv_bytes("2027/1/1,元日", "", "2027/1/11,成人の日"))
    assert len(table.holidays) == 2


def test_見出しが違えば止まる():
    with pytest.raises(HolidayError, match="1 行目の見出しが違います"):
        parse_holiday_csv(csv_bytes("2027/1/1,元日", header="日付,名称"))


def test_空のファイルは見出しの不一致として止まる():
    with pytest.raises(HolidayError, match="見出しが違います.*空のファイル"):
        parse_holiday_csv(b"")


def test_見出しだけで祝日が無ければ止まる():
    with pytest.raises(HolidayError, match="祝日が 1 行もありません"):
        parse_holiday_csv(csv_bytes())


def test_Shift_JISで読めなければ止まる():
    with pytest.raises(HolidayError, match="cp932"):
        parse_holiday_csv(b"\x81")


def test_読めない日付は行番号つきで止まる():
    with pytest.raises(HolidayError, match="3 行目:日付を読めません"):
        parse_holiday_csv(csv_bytes("2027/1/1,元日", "令和9年1月11日,成人の日"))


def test_実在しない日付は行番号つきで止まる():
    with pytest.raises(HolidayError, match="3 行目:実在しない日付です"):
        parse_holiday_csv(csv_bytes("2027/1/1,元日", "2027/2/30,建国記念の日"))


def test_同じ日付の2回目は両方の行番号を出して止まる():
    with pytest.raises(HolidayError, match="4 行目:2 行目と同じ日付です"):
        parse_holiday_csv(csv_bytes("2027/1/1,元日", "2027/1/11,成人の日", "2027/1/1,元日"))


def test_ゼロを詰めた日付と詰めない日付の重なりも同じ日付として止まる():
    with pytest.raises(HolidayError, match="3 行目:2 行目と同じ日付です"):
        parse_holiday_csv(csv_bytes("2027/1/1,元日", "2027/01/01,元日"))


def test_列の数が違えば止まる():
    with pytest.raises(HolidayError, match="3 行目:列の数が 2 ではありません"):
        parse_holiday_csv(csv_bytes("2027/1/1,元日", "2027/1/11,成人の日,余り"))
    with pytest.raises(HolidayError, match="2 行目:列の数が 2 ではありません"):
        parse_holiday_csv(csv_bytes("2027/1/1"))


def test_名称が空なら止まる():
    with pytest.raises(HolidayError, match="2 行目:名称が空です"):
        parse_holiday_csv(csv_bytes("2027/1/1, "))


# ---------------------------------------------------------------- JSON


def test_JSONはキーの順が決まっていて空白が無い():
    table = parse_holiday_csv(csv_bytes("1955/1/1,元日", "2027/11/23,勤労感謝の日"))
    text = to_json_text(table)
    assert text == (
        '{"source":"内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成",'
        '"url":"https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv",'
        '"first":"19550101","last":"20271123","coveredUntil":"20271231",'
        '"holidays":[["19550101","元日"],["20271123","勤労感謝の日"]]}'
    )
    assert SOURCE in text and URL in text
    assert list(json.loads(text)) == ["source", "url", "first", "last", "coveredUntil", "holidays"]


def test_runはraw_holidays_からout_holidays_jsonを書く(tmp_path: Path):
    raw = tmp_path / "raw"
    (raw / "holidays").mkdir(parents=True)
    (raw / "holidays" / "syukujitsu.csv").write_bytes(csv_bytes("2027/1/1,元日", "2026/11/3,文化の日"))
    out = tmp_path / "nested" / "ref"
    table, dest = run(raw, out)
    assert dest == out / "holidays.json"
    body = json.loads(dest.read_text(encoding="utf-8"))
    assert body["holidays"] == [["20261103", "文化の日"], ["20270101", "元日"]]
    assert (body["first"], body["last"], body["coveredUntil"]) == ("20261103", "20270101", "20271231")
    assert len(table.holidays) == 2
    # UTF-8、空白なし(区切りの後ろに空白を入れない)
    assert dest.read_text(encoding="utf-8").startswith('{"source":"')
    assert '", "' not in dest.read_text(encoding="utf-8") and '": ' not in dest.read_text(encoding="utf-8")


def test_CSVが無ければ置き方を伝えて1で終わる(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    assert main(["--raw", str(tmp_path), "--out", str(tmp_path / "ref")]) == 1
    err = capsys.readouterr().err
    assert "祝日の CSV が見つかりません" in err
    assert URL in err
    assert not (tmp_path / "ref").exists()


def test_形が違えばメッセージを出して1で終わり出力を書かない(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    (tmp_path / "holidays").mkdir()
    (tmp_path / "holidays" / "syukujitsu.csv").write_bytes(csv_bytes("2027/2/30,建国記念の日"))
    out = tmp_path / "ref"
    assert main(["--raw", str(tmp_path), "--out", str(out)]) == 1
    assert "2 行目:実在しない日付です" in capsys.readouterr().err
    assert not (out / "holidays.json").exists()


def test_正常に終われば件数と範囲を表示する(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    (tmp_path / "holidays").mkdir()
    (tmp_path / "holidays" / "syukujitsu.csv").write_bytes(csv_bytes("1955/1/1,元日", "2027/11/23,勤労感謝の日"))
    assert main(["--raw", str(tmp_path), "--out", str(tmp_path / "ref")]) == 0
    out = capsys.readouterr().out
    assert "祝日 2 件(19550101〜20271123、判定できるのは 20271231 まで)" in out


# ---------------------------------------------------------------- 実データ(無ければ飛ばす)


@pytest.fixture(scope="module")
def real_table():
    if not REAL_CSV.is_file():
        pytest.skip(f"祝日の CSV がありません: {REAL_CSV}")
    return parse_holiday_csv(REAL_CSV.read_bytes())


def test_実データの件数と範囲(real_table):
    # 2026-11-03 に入手した版(2027-11-23 まで、1,067 行)。内閣府が更新すると件数と最後の日が増える
    assert len(real_table.holidays) >= 1067
    assert real_table.first == "19550101"
    assert real_table.last >= "20271123"
    assert real_table.covered_until == real_table.last[:4] + "1231"
    dates = [d for d, _ in real_table.holidays]
    assert dates == sorted(set(dates))


def test_実データの文化の日と2027年の平日の祝日(real_table):
    names = dict(real_table.holidays)
    assert names["20261103"] == "文化の日"
    # 2027 年の平日の祝日 5 日(取り決め §2)。3/22 は春分の日(日曜)の振替で、名称は「休日」
    assert names["20270101"] == "元日"
    assert names["20270111"] == "成人の日"
    assert names["20270211"] == "建国記念の日"
    assert names["20270223"] == "天皇誕生日"
    assert names["20270322"] == "休日"


def test_実データのJSONを書ける(real_table, tmp_path: Path):
    _, dest = run(REAL_CSV.parents[1], tmp_path)
    body = json.loads(dest.read_text(encoding="utf-8"))
    assert len(body["holidays"]) == len(real_table.holidays)
    assert [h[0] for h in body["holidays"]] == sorted(h[0] for h in body["holidays"])
