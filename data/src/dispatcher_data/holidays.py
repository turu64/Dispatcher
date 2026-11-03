"""内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を JSON にする。

元データは data/raw/holidays/syukujitsu.csv(入手元は data/raw/README.md)。
加工結果は data/out/ref/holidays.json に書き出し、サーバーが GET /api/holidays で配る。
形は docs/interfaces-1104.md の §2 のとおり。

    cd data && uv run dispatcher-holidays
    uv run dispatcher-holidays --raw /path/to/raw --out /tmp/ref

参照データの作成(dispatcher-data)とは別のコマンド。祝日の CSV が無くても参照データは作れる。
"""

from __future__ import annotations

import argparse
import csv
import datetime
import io
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

CSV_NAME = "syukujitsu.csv"
CSV_DIR = "holidays"
OUTPUT_NAME = "holidays.json"
UTF8_BOM = b"\xef\xbb\xbf"

SOURCE = "内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成"
URL = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv"
EXPECTED_HEADER = ["国民の祝日・休日月日", "国民の祝日・休日名称"]


class HolidayError(Exception):
    """祝日の CSV を読めない。メッセージは日本語で、行番号(1 始まり、見出しが 1 行目)を含む。"""


@dataclass
class HolidayTable:
    """日付の昇順に並べた祝日。日付は 'YYYYMMDD'。"""

    holidays: list[tuple[str, str]] = field(default_factory=list)

    @property
    def first(self) -> str:
        return self.holidays[0][0]

    @property
    def last(self) -> str:
        return self.holidays[-1][0]

    @property
    def covered_until(self) -> str:
        """この日までは祝日を判定できるとみなす日。最後の祝日の年の 12月31日。

        内閣府は翌年の祝日を 1 年分まとめて載せるので、最後の年は年末まで載っているとみなす
        (docs/interfaces-1104.md の 12.1-20)。
        """
        return self.last[:4] + "1231"


def parse_date(text: str, line_no: int) -> str:
    """'Y/M/D'(ゼロを詰めない)を 'YYYYMMDD' にする。実在しない日付は止める。"""
    parts = text.strip().split("/")
    if len(parts) != 3 or not all(p.isascii() and p.isdigit() for p in parts):
        raise HolidayError(f"{line_no} 行目:日付を読めません({text!r})。Y/M/D の形で書いてください。")
    year, month, day = (int(p) for p in parts)
    try:
        date = datetime.date(year, month, day)
    except ValueError:
        raise HolidayError(f"{line_no} 行目:実在しない日付です({text!r})。") from None
    return f"{date.year:04d}{date.month:02d}{date.day:02d}"


def parse_holiday_csv(raw: bytes) -> HolidayTable:
    """cp932 の CSV を読む。形が違えば HolidayError で止める。"""
    # 先頭に UTF-8 の BOM(EF BB BF)があれば取る。内閣府の CSV には付いていない
    raw = raw.removeprefix(UTF8_BOM)
    try:
        text = raw.decode("cp932")
    except UnicodeDecodeError as e:
        raise HolidayError(f"Shift_JIS(cp932)として読めません:{e}") from e

    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader, None)
    if header is None or [c.strip() for c in header] != EXPECTED_HEADER:
        found = ",".join(header) if header else "(空のファイル)"
        raise HolidayError(
            f"1 行目の見出しが違います(形が変わった可能性があります)。期待:{','.join(EXPECTED_HEADER)} 実際:{found}"
        )

    seen: dict[str, int] = {}
    holidays: list[tuple[str, str]] = []
    for row in reader:
        line_no = reader.line_num
        if not row or all(not c.strip() for c in row):
            continue
        if len(row) != 2:
            raise HolidayError(f"{line_no} 行目:列の数が 2 ではありません({','.join(row)!r})。")
        date = parse_date(row[0], line_no)
        name = row[1].strip()
        if not name:
            raise HolidayError(f"{line_no} 行目:名称が空です({','.join(row)!r})。")
        if date in seen:
            raise HolidayError(f"{line_no} 行目:{seen[date]} 行目と同じ日付です({row[0].strip()})。")
        seen[date] = line_no
        holidays.append((date, name))
    if not holidays:
        raise HolidayError("祝日が 1 行もありません。")
    holidays.sort()
    return HolidayTable(holidays)


def to_json_text(table: HolidayTable) -> str:
    """UTF-8、空白なしの JSON。キーの順は docs/interfaces-1104.md の §2 のとおり。"""
    body = {
        "source": SOURCE,
        "url": URL,
        "first": table.first,
        "last": table.last,
        "coveredUntil": table.covered_until,
        "holidays": [[d, n] for d, n in table.holidays],
    }
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def run(raw: Path, out: Path) -> tuple[HolidayTable, Path]:
    """raw/holidays/syukujitsu.csv を読み、out/holidays.json を書く。"""
    src = raw / CSV_DIR / CSV_NAME
    if not src.is_file():
        raise HolidayError(
            f"祝日の CSV が見つかりません:{src}\n"
            f"{URL} をダウンロードして置いてください(data/raw/README.md)。"
        )
    table = parse_holiday_csv(src.read_bytes())
    out.mkdir(parents=True, exist_ok=True)
    dest = out / OUTPUT_NAME
    dest.write_text(to_json_text(table), encoding="utf-8")
    return table, dest


def _data_dir() -> Path:
    """data/ の場所(dispatcher_data/__init__.py と同じ)。"""
    here = Path(__file__).resolve().parents[2]
    return here if (here / "pyproject.toml").exists() else Path.cwd()


def main(argv: list[str] | None = None) -> int:
    data_dir = _data_dir()
    parser = argparse.ArgumentParser(
        prog="dispatcher-holidays",
        description="内閣府の祝日一覧(syukujitsu.csv)を JSON にする",
    )
    parser.add_argument("--raw", type=Path, default=data_dir / "raw", help="元データの置き場所(既定 data/raw)")
    parser.add_argument("--out", type=Path, default=data_dir / "out" / "ref", help="書き出す場所(既定 data/out/ref)")
    args = parser.parse_args(argv)

    try:
        table, dest = run(args.raw, args.out)
    except HolidayError as e:
        print(str(e), file=sys.stderr)
        return 1

    size = dest.stat().st_size
    print(
        f"祝日 {len(table.holidays)} 件({table.first}〜{table.last}、判定できるのは {table.covered_until} まで)"
        f" → {dest}({size:,} バイト)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
