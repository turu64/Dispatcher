"""北海道の参照データ(人口メッシュ、DID、鉄道駅)を加工するスクリプト。

元データは data/raw/ に置く(入手元は data/raw/README.md)。
加工結果は data/out/ref/{1次メッシュ}.json に書き出し、サーバーが /api/ref/{mesh1} で配る。

    cd data && uv run dispatcher-data                       # data/raw にある1次メッシュすべて
    uv run dispatcher-data --mesh1 6542 6642                # 1次メッシュを指定
    uv run dispatcher-data --raw /path/to/raw --out /tmp/ref
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _data_dir() -> Path:
    """data/ の場所。パッケージは data/src/dispatcher_data/ にある(uv は編集可能な形で入れる)。"""
    here = Path(__file__).resolve().parents[2]
    return here if (here / "pyproject.toml").exists() else Path.cwd()


def main(argv: list[str] | None = None) -> int:
    from .build import MissingSourceError, run

    data_dir = _data_dir()
    parser = argparse.ArgumentParser(
        prog="dispatcher-data",
        description="参照データ(人口 250m メッシュ、DID の 125m セル、鉄道駅)を1次メッシュごとの JSON にする",
    )
    parser.add_argument("--raw", type=Path, default=data_dir / "raw", help="元データの置き場所(既定 data/raw)")
    parser.add_argument("--out", type=Path, default=data_dir / "out" / "ref", help="書き出す場所(既定 data/out/ref)")
    parser.add_argument("--mesh1", nargs="+", help="1次メッシュ(4桁)。省略すると人口データのある1次メッシュすべて")
    args = parser.parse_args(argv)

    if args.mesh1:
        # isdigit() は全角数字なども真になるため、ASCII に限る
        bad = [m for m in args.mesh1 if len(m) != 4 or not (m.isascii() and m.isdigit())]
        if bad:
            parser.error(f"1次メッシュは数字4桁で指定してください: {' '.join(bad)}")

    try:
        report = run(args.raw, args.out, args.mesh1)
    except MissingSourceError as e:
        print(str(e), file=sys.stderr)
        return 1

    print(f"人口メッシュ:{report.population_rows} 行(人口総数が数値でない行 {report.non_numeric}、コードが不正な行 {report.bad_key})")
    print(f"廃止された駅:N02 の線 {report.closed_removed} 本を除きました(closed_stations.csv)")
    if report.closed_unmatched:
        print(f"  どの線にも一致しなかった行(新しい版の N02 で既に消えているか、書き間違い):{'、'.join(report.closed_unmatched)}")
    for mesh1, path, size, c in report.files:
        print(
            f"{mesh1}: 人口セル {c['pop250']}(計 {c['人口']} 人)、DID セル {c['did125']}、駅 {c['stations']} → {path}({size:,} バイト)"
        )
    if report.no_population:
        print(
            f"人口の元データが無い1次メッシュ:{'、'.join(report.no_population)}"
            "(pop250 を空にして書きました。web はこの範囲のセルを人口 0 として調べません。"
            "停留所があるなら、e-Stat の人口を data/raw/mesh/ に置いて作り直してください)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
