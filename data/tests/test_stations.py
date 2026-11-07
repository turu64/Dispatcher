import math
from pathlib import Path

import pytest

from dispatcher_data.stations import (
    CLOSED_STATIONS_CSV,
    StationPart,
    distance_m,
    exclude_closed,
    line_midpoint,
    load_closed_stations,
    load_station_parts,
    merge_stations,
)


def _stations(fixture_raw: Path):
    path = fixture_raw / "rail" / "N02-25_GML" / "UTF-8" / "N02-25_Station.geojson"
    return merge_stations(load_station_parts(path))


def test_2点の線の中点():
    lat, lon = line_midpoint([[[142.35949, 43.76299], [142.35635, 43.76389]]])
    assert lat == pytest.approx((43.76299 + 43.76389) / 2)
    assert lon == pytest.approx((142.35949 + 142.35635) / 2)


def test_折れ線の中点は長さの半分の位置():
    # 北へ 0.001 度、東へ 0.004 度の L 字。経度は緯度に応じて縮めて測る
    coords = [[142.4600, 44.3500], [142.4600, 44.3510], [142.4640, 44.3510]]
    lat0 = sum(c[1] for c in coords) / 3
    kx = math.cos(math.radians(lat0))
    north, east = 0.001, 0.004 * kx
    half = (north + east) / 2
    # 半分の位置は東向きの区間の途中
    expected_lon = 142.4600 + (half - north) / kx
    lat, lon = line_midpoint([coords])
    assert lat == pytest.approx(44.3510)
    assert lon == pytest.approx(expected_lon)


def test_複数の線_MultiLineString_の中点():
    lat, lon = line_midpoint([[[142.0, 43.0], [142.0, 43.001]], [[142.0, 43.002], [142.0, 43.003]]])
    # 長さの合計 0.002 度の半分は、1本目の終わり
    assert lat == pytest.approx(43.001)
    assert lon == pytest.approx(142.0)


def test_同じ駅名_同じ会社の線は1つにまとめる(fixture_raw: Path):
    stations = _stations(fixture_raw)
    jr = [s for s in stations if s.name == "旭川" and s.operator == "北海道旅客鉄道"]
    assert len(jr) == 1
    asahikawa = jr[0]
    assert asahikawa.line == "宗谷線・函館線・富良野線"
    assert len(asahikawa.points) == 3
    # 代表点は各線の中点の平均
    mids = [(43.76344, 142.35792), (43.76344, 142.35792), (43.76229, 142.35822)]
    assert asahikawa.lat == pytest.approx(sum(m[0] for m in mids) / 3)
    assert asahikawa.lon == pytest.approx(sum(m[1] for m in mids) / 3)


def test_会社が違えばまとめない(fixture_raw: Path):
    stations = _stations(fixture_raw)
    names = [(s.name, s.operator) for s in stations]
    assert ("旭川", "架空鉄道") in names
    assert names.count(("旭川", "北海道旅客鉄道")) == 1


def test_同じ名前_同じ会社でも離れた駅はまとめない(fixture_raw: Path):
    stations = _stations(fixture_raw)
    okubo = [s for s in stations if s.name == "大久保"]
    assert len(okubo) == 2
    assert distance_m((okubo[0].lat, okubo[0].lon), (okubo[1].lat, okubo[1].lon)) > 100_000
    assert {s.line for s in okubo} == {"中央線", "奥羽線"}


def test_距離():
    # 緯度 1 度はおよそ 111km
    assert distance_m((43.0, 142.0), (44.0, 142.0)) == pytest.approx(111_195, rel=1e-3)


# ---- 廃止された駅(closed_stations.csv) ----

JR = "北海道旅客鉄道"
CSV_HEADER = "駅名,事業者,路線,廃止日,出典URL\n"


def _write_csv(tmp_path: Path, body: str, header: str = CSV_HEADER) -> Path:
    path = tmp_path / "closed.csv"
    path.write_text(header + body, encoding="utf-8")
    return path


def test_廃止駅の一覧を読む(tmp_path: Path):
    path = _write_csv(tmp_path, " 深川 ,北海道旅客鉄道,留萌線,2026-04-01,https://example.com/a.pdf\n\n二股,北海道旅客鉄道,函館線,2026-03-14,https://example.com/b.pdf\n")
    closed = load_closed_stations(path)
    assert [(c.name, c.operator, c.line, c.closed_on.isoformat(), c.source_urls) for c in closed] == [
        ("深川", JR, "留萌線", "2026-04-01", ("https://example.com/a.pdf",)),
        ("二股", JR, "函館線", "2026-03-14", ("https://example.com/b.pdf",)),
    ]


def test_出典URLは空白で区切って複数書ける(tmp_path: Path):
    path = _write_csv(
        tmp_path,
        "深川,北海道旅客鉄道,留萌線,2026-04-01, https://example.com/a.pdf  https://example.com/b.pdf \n"
        "二股,北海道旅客鉄道,函館線,2026-03-14,https://example.com/c.pdf\n",
    )
    closed = load_closed_stations(path)
    assert closed[0].source_urls == ("https://example.com/a.pdf", "https://example.com/b.pdf")
    assert closed[1].source_urls == ("https://example.com/c.pdf",)


@pytest.mark.parametrize(
    "body, header, message",
    [
        ("深川,北海道旅客鉄道,留萌線,2026-04-01,https://example.com\n", "駅名,事業者,路線,廃止日\n", "見出し"),
        ("深川,北海道旅客鉄道,留萌線,20260401,https://example.com\n", CSV_HEADER, "廃止日が YYYY-MM-DD"),
        ("深川,北海道旅客鉄道,留萌線,2026-02-30,https://example.com\n", CSV_HEADER, "廃止日が YYYY-MM-DD"),
        ("深川,北海道旅客鉄道,留萌線,2026-04-01,\n", CSV_HEADER, "すべてを埋めてください"),
        ("深川,北海道旅客鉄道,留萌線,2026-04-01\n", CSV_HEADER, "すべてを埋めてください"),
        (
            "深川,北海道旅客鉄道,留萌線,2026-04-01,https://a\n深川,北海道旅客鉄道,留萌線,2026-04-01,https://b\n",
            CSV_HEADER,
            "重複",
        ),
    ],
)
def test_廃止駅の一覧の形が違えばエラー(tmp_path: Path, body: str, header: str, message: str):
    with pytest.raises(ValueError, match=message):
        load_closed_stations(_write_csv(tmp_path, body, header))


def _parts() -> list[StationPart]:
    return [
        StationPart("深川", "函館線", JR, 43.7219, 142.0436),
        StationPart("深川", "留萌線", JR, 43.7219, 142.0436),
        StationPart("北一已", "留萌線", JR, 43.7421, 142.0149),
        StationPart("深川", "留萌線", "架空鉄道", 43.7219, 142.0436),
        StationPart("旭川", "函館線", JR, 43.7634, 142.3579),
    ]


def test_事業者_路線_駅名が一致する線だけを除く(tmp_path: Path):
    closed = load_closed_stations(
        _write_csv(tmp_path, "深川,北海道旅客鉄道,留萌線,2026-04-01,https://example.com\n北一已,北海道旅客鉄道,留萌線,2026-04-01,https://example.com\n")
    )
    result = exclude_closed(_parts(), closed)
    assert [(p.name, p.line, p.operator) for p in result.removed] == [("深川", "留萌線", JR), ("北一已", "留萌線", JR)]
    # 函館線の深川、別の事業者の同名の線、別の駅は残る(順序も保つ)
    assert [(p.name, p.line, p.operator) for p in result.kept] == [
        ("深川", "函館線", JR),
        ("深川", "留萌線", "架空鉄道"),
        ("旭川", "函館線", JR),
    ]
    assert result.unmatched == []


def test_一致しなかった行は_unmatched_に返す(tmp_path: Path):
    closed = load_closed_stations(
        _write_csv(tmp_path, "深川,北海道旅客鉄道,留萌線,2026-04-01,https://example.com\n石狩沼田,北海道旅客鉄道,留萌線,2026-04-01,https://example.com\n")
    )
    result = exclude_closed(_parts(), closed)
    assert len(result.removed) == 1
    assert [c.name for c in result.unmatched] == ["石狩沼田"]


def test_深川は留萌線の線を除くと函館線だけの駅になる(tmp_path: Path):
    closed = load_closed_stations(_write_csv(tmp_path, "深川,北海道旅客鉄道,留萌線,2026-04-01,https://example.com\n"))
    stations = merge_stations(exclude_closed(_parts(), closed).kept)
    fukagawa = [s for s in stations if s.name == "深川" and s.operator == JR]
    assert len(fukagawa) == 1
    assert fukagawa[0].line == "函館線"
    # 除く前は2本の線をまとめた駅
    before = [s for s in merge_stations(_parts()) if s.name == "深川" and s.operator == JR]
    assert before[0].line == "函館線・留萌線"


def test_同梱の廃止駅の一覧():
    assert CLOSED_STATIONS_CSV.is_file()
    closed = load_closed_stations()
    by_line = {(c.line, c.closed_on.isoformat()) for c in closed}
    assert by_line == {("留萌線", "2026-04-01"), ("函館線", "2026-03-14")}
    # 留萌線(深川〜石狩沼田)の5駅すべてと、函館線の仁山・二股
    assert sorted(c.name for c in closed if c.line == "留萌線") == sorted(["深川", "北一已", "秩父別", "北秩父別", "石狩沼田"])
    assert sorted(c.name for c in closed if c.line == "函館線") == sorted(["仁山", "二股"])
    assert {c.operator for c in closed} == {JR}
    # 出典は JR北海道の公式の発表
    assert all(u.startswith("https://www.jrhokkaido.co.jp/CM/Info/press/pdf/") for c in closed for u in c.source_urls)
    # 留萌線は、廃止の届出(廃止日・最終運行日)と、駅名の根拠(2026年2月9日の運転時刻の発表)の2つ。函館線は 2025年12月12日のダイヤ改正の発表の1つ
    rumoi = {
        "https://www.jrhokkaido.co.jp/CM/Info/press/pdf/20250328_KO_todokede.pdf",
        "https://www.jrhokkaido.co.jp/CM/Info/press/pdf/20260209_HP_AS_rumoiline.pdf",
    }
    assert all(set(c.source_urls) == rumoi and len(c.source_urls) == 2 for c in closed if c.line == "留萌線")
    assert all(c.source_urls == ("https://www.jrhokkaido.co.jp/CM/Info/press/pdf/20251212_KO_kaisei.pdf",) for c in closed if c.line == "函館線")
