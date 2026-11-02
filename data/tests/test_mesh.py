import pytest

from dispatcher_data.mesh import (
    code_from_index,
    code_to_index,
    lat_index,
    lon_index,
    mesh_bounds,
    mesh_center,
    mesh_code,
    parent_code,
)

# 1次メッシュ 6542 の南西の角(8分の1地域メッシュの行・列番号)
I0, J0 = 65 * 640, 42 * 640


def test_既知の地点の3次メッシュ():
    # 東京駅は 3次メッシュ 53394611
    assert mesh_code(35.681236, 139.767125, 8) == "53394611"
    assert mesh_code(35.681236, 139.767125, 4) == "5339"
    assert mesh_code(35.681236, 139.767125, 6) == "533946"


def test_旭川駅は1次メッシュ6542():
    assert mesh_code(43.7628, 142.3587, 4) == "6542"


def test_桁数ごとのコードは前の桁を引き継ぐ():
    lat, lon = 43.7628, 142.3587
    c11 = mesh_code(lat, lon, 11)
    assert len(c11) == 11
    for d in (4, 6, 8, 9, 10):
        assert c11[:d] == mesh_code(lat, lon, d)
        assert parent_code(c11, d) == c11[:d]


def test_1次メッシュの範囲():
    b = mesh_bounds("6542")
    assert b.south == pytest.approx(65 / 1.5)
    assert b.north == pytest.approx(66 / 1.5)
    assert b.west == 142
    assert b.east == 143


def test_分割地域メッシュの末尾は南西1_南東2_北西3_北東4():
    base = code_from_index(I0, J0, 10)  # 4分の1地域メッシュの南西の角
    assert base == "6542000011"
    assert code_from_index(I0, J0, 11) == "65420000111"
    assert code_from_index(I0, J0 + 1, 11) == "65420000112"
    assert code_from_index(I0 + 1, J0, 11) == "65420000113"
    assert code_from_index(I0 + 1, J0 + 1, 11) == "65420000114"
    # 2分の1地域メッシュの北東
    assert code_from_index(I0 + 4, J0 + 4, 9) == "654200004"


def test_コードと行列番号の往復():
    for i, j in [(I0, J0), (I0 + 639, J0 + 639), (I0 + 123, J0 + 457), (I0 + 7, J0 + 81)]:
        code = code_from_index(i, j, 11)
        assert code_to_index(code) == (i, j, 1)


def test_境界上の点は南西側の端を含むセルに入る():
    i, j = I0 + 3, J0 + 5
    # 割り算で作った境界の値(浮動小数の誤差を含む)
    lat = i / 960
    lon = 100 + j / 640
    assert mesh_code(lat, lon, 11) == code_from_index(i, j, 11)
    # 別の作り方:43.75 は 960 で割り切れる境界。足し算で誤差が乗っても隣にずれない
    lat2 = 43.75 + 3 / 960
    assert lat_index(lat2) == 42003
    assert lon_index(142.0 + 5 / 640) == J0 + 5
    # 北の端は北隣のセル
    assert mesh_code((i + 1) / 960, lon, 11) == code_from_index(i + 1, j, 11)


def test_浮動小数の誤差が乗った値も境界にそろえる():
    # 0.1 + 0.2 のような誤差:境界のわずかに下でも同じセル
    i = 42003
    lat = i / 960 - 1e-14
    assert lat_index(lat) == i
    # 0.1mm より大きく離れていれば南のセル
    assert lat_index(i / 960 - 1e-8) == i - 1


def test_中心と範囲():
    code = code_from_index(I0 + 10, J0 + 20, 11)
    b = mesh_bounds(code)
    lat, lon = mesh_center(code)
    assert b.south < lat < b.north
    assert b.west < lon < b.east
    assert mesh_code(lat, lon, 11) == code
    assert (b.north - b.south) * 3600 == pytest.approx(3.75)
    assert (b.east - b.west) * 3600 == pytest.approx(5.625)


def test_不正なコード():
    with pytest.raises(ValueError):
        code_to_index("654")
    with pytest.raises(ValueError):
        code_to_index("654280")  # 2次メッシュの数字は 0〜7
    with pytest.raises(ValueError):
        code_to_index("654200005")  # 分割の数字は 1〜4
    with pytest.raises(ValueError):
        code_to_index("6542a0")
    with pytest.raises(ValueError):
        mesh_code(43.7, 142.3, 7)
