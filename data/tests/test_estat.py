from pathlib import Path

import pytest

from dispatcher_data.estat import parse_population, read_population


def test_cp932と2行の見出しを読む(fixture_raw: Path):
    path = fixture_raw / "mesh" / "tblT001142Q6542.txt"
    raw = path.read_bytes()
    # 手作りのデータも cp932(「~」は cp932 の全角チルダ)で、UTF-8 では読めない
    with pytest.raises(UnicodeDecodeError):
        raw.decode("utf-8")
    t = read_population(path)
    assert t.total_column == "T001142001"
    assert t.rows == 7


def test_秘匿対象のセルも自身の人口総数をそのまま使う(fixture_raw: Path):
    t = read_population(fixture_raw / "mesh" / "tblT001142Q6542.txt")
    # 合算先(HTKSYORI=1)は 7 のまま。秘匿対象(HTKSYORI=2)の 3 を足さない
    assert t.pop["6542000012"] == 7
    assert t.pop["6542000013"] == 3
    assert t.hidden == 1
    assert sum(t.pop.values()) == 10 + 7 + 3


def test_0人と数値でない値は入れない(fixture_raw: Path):
    t = read_population(fixture_raw / "mesh" / "tblT001142Q6542.txt")
    assert "6542000014" not in t.pop
    assert t.zero == 1
    # 「*」、空、「-」
    for code in ("6542000021", "6542000022", "6542000023"):
        assert code not in t.pop
    assert t.non_numeric == 3
    assert set(t.pop) == {"6542000011", "6542000012", "6542000013"}


def test_項目名で人口総数の列を見つける():
    # 列の順が違っても、2行目の項目名「人口(総数)」で見つける
    text = (
        "KEY_CODE,HTKSYORI,HTKSAKI,GASSAN,X1,X2\r\n"
        ",,,,　世帯総数,　人口（総数）\r\n"
        "6542000011,0,,,5,12\r\n"
    )
    t = parse_population(text)
    assert t.total_column == "X2"
    assert t.pop == {"6542000011": 12}


def test_項目名が無ければ項目コードで見つける():
    text = "KEY_CODE,HTKSYORI,T001142002,T001142001\r\n,,,\r\n6542000011,0,3,8\r\n"
    assert parse_population(text).pop == {"6542000011": 8}


def test_コードが10桁でない行は飛ばす():
    text = "KEY_CODE,HTKSYORI,T001142001\r\n,,\r\n65420000,0,8\r\n6542000011,0,2\r\n"
    t = parse_population(text)
    assert t.bad_key == 1
    assert t.pop == {"6542000011": 2}


def test_人口総数の列が無ければエラー():
    with pytest.raises(ValueError, match="人口総数"):
        parse_population("KEY_CODE,HTKSYORI\r\n,\r\n6542000011,0\r\n")


def test_見出しが足りなければエラー():
    with pytest.raises(ValueError, match="見出し"):
        parse_population("KEY_CODE,T001142001\r\n")
