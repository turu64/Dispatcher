import json
from pathlib import Path

import pytest

from dispatcher_data import main
from dispatcher_data.build import SOURCES, MissingSourceError, find_sources, run

# docs/interfaces-1103.md の「参照データ」の sources
EXPECTED_SOURCES = [
    "令和2年国勢調査 地域メッシュ統計(e-Stat)を加工して作成",
    "国土数値情報(人口集中地区 A16、鉄道 N02)を加工して作成",
]


def test_1次メッシュごとにJSONを書く(fixture_raw: Path, tmp_path: Path):
    report = run(fixture_raw, tmp_path)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["6542.json", "6642.json"]
    assert [f[0] for f in report.files] == ["6542", "6642"]
    assert report.non_numeric == 3


def test_JSONの形(fixture_raw: Path, tmp_path: Path):
    run(fixture_raw, tmp_path)
    ref = json.loads((tmp_path / "6542.json").read_text(encoding="utf-8"))
    assert list(ref) == ["mesh1", "pop250", "did125", "stations", "sources"]
    assert ref["mesh1"] == "6542"
    assert ref["pop250"] == {"6542000011": 10, "6542000012": 7, "6542000013": 3}
    assert all(len(k) == 10 and k.startswith("6542") for k in ref["pop250"])
    assert all(isinstance(v, int) and v > 0 for v in ref["pop250"].values())
    assert len(ref["did125"]) == 40
    assert all(len(c) == 11 and c.startswith("6542") for c in ref["did125"])
    assert ref["did125"] == sorted(ref["did125"])
    assert ref["sources"] == EXPECTED_SOURCES
    assert SOURCES == EXPECTED_SOURCES
    for s in ref["stations"]:
        assert list(s) == ["name", "line", "operator", "lat", "lon"]
        assert isinstance(s["lat"], float) and isinstance(s["lon"], float)
    names = [(s["name"], s["operator"]) for s in ref["stations"]]
    assert names == [("旭川", "北海道旅客鉄道"), ("旭川", "架空鉄道")]
    jr = ref["stations"][0]
    assert jr["line"] == "宗谷線・函館線・富良野線"
    assert jr["lat"] == pytest.approx(43.76306, abs=1e-5)
    assert jr["lon"] == pytest.approx(142.35802, abs=1e-5)


def test_駅は代表点の1次メッシュに振り分ける(fixture_raw: Path, tmp_path: Path):
    run(fixture_raw, tmp_path)
    ref = json.loads((tmp_path / "6642.json").read_text(encoding="utf-8"))
    assert [s["name"] for s in ref["stations"]] == ["名寄"]
    assert ref["pop250"] == {"6642000011": 4}
    assert len(ref["did125"]) == 4
    # 大久保(東京・秋田)は北海道の1次メッシュに入らない
    all_names = {s["name"] for m in ("6542", "6642") for s in json.loads((tmp_path / f"{m}.json").read_text("utf-8"))["stations"]}
    assert "大久保" not in all_names


def test_1次メッシュを指定する(fixture_raw: Path, tmp_path: Path):
    run(fixture_raw, tmp_path, ["6642"])
    assert [p.name for p in tmp_path.iterdir()] == ["6642.json"]


def test_人口の無い1次メッシュも指定すれば書く(fixture_raw: Path, tmp_path: Path):
    run(fixture_raw, tmp_path, ["6543"])
    ref = json.loads((tmp_path / "6543.json").read_text(encoding="utf-8"))
    assert ref["pop250"] == {}
    assert ref["did125"] == []
    assert ref["stations"] == []


def test_元データが無ければエラー(tmp_path: Path):
    with pytest.raises(MissingSourceError, match="人口メッシュ"):
        find_sources(tmp_path)


def test_コマンド(fixture_raw: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    out = tmp_path / "ref"
    assert main(["--raw", str(fixture_raw), "--out", str(out)]) == 0
    assert (out / "6542.json").exists()
    printed = capsys.readouterr().out
    assert "6542: 人口セル 3(計 20 人)、DID セル 40、駅 2" in printed


def test_コマンド_元データが無いと1を返す(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    assert main(["--raw", str(tmp_path), "--out", str(tmp_path / "ref")]) == 1
    assert "元データがありません" in capsys.readouterr().err


def test_コマンド_1次メッシュの形を確かめる(fixture_raw: Path, tmp_path: Path):
    with pytest.raises(SystemExit):
        main(["--raw", str(fixture_raw), "--out", str(tmp_path), "--mesh1", "65a2"])


def test_廃止駅の線を除いてから駅をまとめる(fixture_raw: Path, tmp_path: Path):
    closed_csv = tmp_path / "closed.csv"
    closed_csv.write_text(
        "駅名,事業者,路線,廃止日,出典URL\n"
        "旭川,北海道旅客鉄道,函館線,2026-04-01,https://example.com/a\n"
        "存在しない,北海道旅客鉄道,函館線,2026-04-01,https://example.com/b\n",
        encoding="utf-8",
    )
    out = tmp_path / "out"
    report = run(fixture_raw, out, closed_csv=closed_csv)
    assert report.closed_removed == 1
    assert report.closed_unmatched == ["函館線 存在しない"]
    ref = json.loads((out / "6542.json").read_text(encoding="utf-8"))
    jr = [s for s in ref["stations"] if s["operator"] == "北海道旅客鉄道"]
    assert [s["line"] for s in jr] == ["宗谷線・富良野線"]


def test_既定の廃止駅の一覧は手作りの元データに一致しない(fixture_raw: Path, tmp_path: Path):
    report = run(fixture_raw, tmp_path)
    assert report.closed_removed == 0
    assert len(report.closed_unmatched) == 7


def test_実行時に廃止駅の件数を表示する(fixture_raw: Path, tmp_path: Path, capsys):
    assert main(["--raw", str(fixture_raw), "--out", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "廃止された駅:N02 の線 0 本を除きました" in out
    assert "留萌線 深川" in out
