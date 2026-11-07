"""e-Stat の地域メッシュ統計(令和2年国勢調査、人口及び世帯)の読み込み。

統計データの txt は Shift_JIS(cp932)の CSV で、見出しが2行ある。
1行目は項目コード(KEY_CODE、HTKSYORI、HTKSAKI、GASSAN、T001142001 …)、2行目は項目名(「 人口(総数)」など)。

秘匿処理(定義書 T001142.pdf「結果の秘匿について」):
- HTKSYORI は 0 = 秘匿対象外、1 = 合算先、2 = 秘匿対象。HTKSAKI は秘匿対象の合算先のコード、GASSAN は合算先が受け入れた秘匿対象のコード
- ただし「男女別人口(総数)」は秘匿しない項目なので、秘匿対象(HTKSYORI=2)の行にもそのセル自身の人口総数が入っている。
  合算先に足し上げられているのは年齢別などの秘匿される項目だけ
- そのため人口総数は、各行の値をそのまま使う。秘匿対象の行を合算先に足したり、合算先から引いたりしない
- 人口総数が数値でない行(「*」「-」や空)は、そのセルを入れずに数を数える(令和2年の北海道 6541〜6643 では 0 件)
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from pathlib import Path

from .mesh import code_to_index

ENCODING = "cp932"
KEY_COLUMN = "KEY_CODE"
TOTAL_LABEL = "人口(総数)"
# 人口総数の項目コード(例:T001142001)。2行目の項目名で見つからないときに使う
_TOTAL_CODE = re.compile(r"^T\d{6}001$")
# 全角のかっこ(U+FF08、U+FF09)を半角にそろえてから比べる
_FULLWIDTH_PARENS = str.maketrans({"\uff08": "(", "\uff09": ")"})


@dataclass
class PopulationTable:
    """4分の1地域メッシュ(10 桁)ごとの人口総数。"""

    pop: dict[str, int] = field(default_factory=dict)  # 1 人以上のセルだけ
    rows: int = 0  # データの行数(見出しを除く)
    zero: int = 0  # 人口 0 で入れなかったセル
    non_numeric: int = 0  # 人口総数が数値でなく入れなかったセル
    bad_key: int = 0  # KEY_CODE が 10 桁の数字でなく飛ばした行
    hidden: int = 0  # 秘匿対象(HTKSYORI=2)の行。人口総数はそのまま使っている
    total_column: str = ""


def _is_mesh_code(code: str) -> bool:
    """地域メッシュのコードとして読めるか(2次は 0〜7、分割は 1〜4、ASCII の数字だけ)。"""
    try:
        code_to_index(code)
    except ValueError:
        return False
    return True


def _normalize_label(s: str) -> str:
    return s.strip().strip("　").translate(_FULLWIDTH_PARENS)


def find_total_column(header1: list[str], header2: list[str]) -> int:
    """人口総数の列の位置。2行目の項目名「人口(総数)」を優先し、無ければ項目コード T******001 を使う。"""
    for idx, label in enumerate(header2):
        if _normalize_label(label) == TOTAL_LABEL:
            return idx
    for idx, code in enumerate(header1):
        if _TOTAL_CODE.match(code.strip()):
            return idx
    raise ValueError("人口総数の列(項目名「人口(総数)」または項目コード T******001)が見つかりません")


def parse_population(text: str) -> PopulationTable:
    """統計データの txt(文字コードを戻した文字列)を読む。"""
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        header1 = next(reader)
        header2 = next(reader)
    except StopIteration:
        raise ValueError("見出しの2行がありません") from None
    header1 = [h.strip() for h in header1]
    if KEY_COLUMN not in header1:
        raise ValueError(f"1行目に {KEY_COLUMN} の列がありません")
    key_idx = header1.index(KEY_COLUMN)
    total_idx = find_total_column(header1, header2)
    hide_idx = header1.index("HTKSYORI") if "HTKSYORI" in header1 else None

    table = PopulationTable(total_column=header1[total_idx])
    for row in reader:
        if not row or all(not c.strip() for c in row):
            continue
        table.rows += 1
        key = row[key_idx].strip() if key_idx < len(row) else ""
        if len(key) != 10 or not _is_mesh_code(key):
            table.bad_key += 1
            continue
        if hide_idx is not None and hide_idx < len(row) and row[hide_idx].strip() == "2":
            table.hidden += 1
        value = row[total_idx].strip() if total_idx < len(row) else ""
        # isdigit() は全角数字・上付き数字なども真になる(int() で落ちるものもある)ため、ASCII に限る
        if not (value.isascii() and value.isdigit()):
            table.non_numeric += 1
            continue
        n = int(value)
        if n == 0:
            table.zero += 1
            continue
        if key in table.pop:
            raise ValueError(f"同じメッシュコードの行が2つあります: {key}")
        table.pop[key] = n
    return table


def read_population(path: Path) -> PopulationTable:
    """統計データの txt(cp932)を読む。"""
    data = Path(path).read_bytes()
    try:
        text = data.decode(ENCODING)
    except UnicodeDecodeError as e:
        raise ValueError(f"{path} を {ENCODING} として読めません: {e}") from e
    return parse_population(text)
