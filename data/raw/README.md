# 元データの置き場所

ここには元データを置きます。中身はコミットしません(`.gitignore` で除外しています)。
GTFS は利用フォームの記入が先なので、利用者が手で入手して置きます。
e-Stat の人口メッシュと国土数値情報は、公式の配布元からダウンロードしてよいことになっています(2026-11-03 に利用者が許可)。
加工スクリプト(`uv run dispatcher-data`)自体はダウンロードしません。

| 置く場所 | データ | 入手先 | 利用条件 |
| --- | --- | --- | --- |
| `gtfs/` | 道北バスなど北海道の事業者の GTFS(ZIP)。道北バスは `dohoku_bus_減便前.zip`(9/17 作成の版。画面の「サンプルを読み込む」で使う)と `dohoku_bus_減便後.zip`(10/29 作成の版。比較用)の名前で置く。どちらもテストで使う | 北海道オープンデータプラットフォーム(ckan.hoda.jp、データセット「gtfs-data」)。**利用前にフォームへの記入が必要** | CC BY 4.0 |
| `mesh/` | 令和2年国勢調査 地域メッシュ統計「人口及び世帯」の 4分の1地域メッシュ(約 250m、統計表 T001142)。1次メッシュごとの `tblT001142Q{1次メッシュ}.zip` と、展開した `tblT001142Q{1次メッシュ}.txt` | e-Stat「地図で見る統計(統計GIS)」のデータダウンロード | 政府標準利用規約(CC BY 4.0 互換) |
| `did/` | 人口集中地区(A16、2020年、北海道)。`A16-20_01_GML.zip` と、展開した `A16-20_01_GML/A16-20_01_DID.geojson` ほか | 国土数値情報 | 配布ページの記載は「1995年(平成7年)以降:商用可」 |
| `rail/` | 鉄道(N02、2025年度版、全国)。`N02-25_GML.zip` と、展開した `N02-25_GML/UTF-8/N02-25_Station.geojson` ほか | 国土数値情報 | 2020年以降はオープンデータ(CC BY 4.0) |
| `school/` | 学校(P29、2023年度) | 国土数値情報 | CC BY 4.0 |
| `medical/` | 医療機関(P04、2020年度) | 国土数値情報 | CC BY 4.0 |
| `busstop/` | バス停留所(P11、2022年度) | 国土数値情報 | CC BY 4.0 |

## 入手の記録

2026-11-03 00:42(日本時間)に curl でダウンロードし、同じ場所に展開した。展開したファイルは読むだけで、実行していない。

| 置いた場所 | 入手元の URL | 大きさ |
| --- | --- | --- |
| `mesh/tblT001142Q6541.zip` | https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001142&code=6541&downloadType=2 | 96,516 バイト |
| `mesh/tblT001142Q6542.zip` | https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001142&code=6542&downloadType=2 | 222,802 バイト |
| `mesh/tblT001142Q6543.zip` | https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001142&code=6543&downloadType=2 | 76,159 バイト |
| `mesh/tblT001142Q6641.zip` | https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001142&code=6641&downloadType=2 | 15,743 バイト |
| `mesh/tblT001142Q6642.zip` | https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001142&code=6642&downloadType=2 | 61,951 バイト |
| `mesh/tblT001142Q6643.zip` | https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001142&code=6643&downloadType=2 | 50,980 バイト |
| `did/A16-20_01_GML.zip` | https://nlftp.mlit.go.jp/ksj/gml/data/A16/A16-20/A16-20_01_GML.zip | 2,012,126 バイト |
| `rail/N02-25_GML.zip` | https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip | 14,903,774 バイト |
| `mesh/estat_mesh_boundary_1km_6542.zip`(検証用。3次メッシュの境界、世界測地系) | https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=S&code=6542&coordSys=1&format=shape&downloadType=5&datum=2011 | 166,876 バイト |
| `mesh/estat_mesh_boundary_250m_6542.zip`(検証用。4分の1地域メッシュの境界、世界測地系) | https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=Q&code=6542&coordSys=1&format=shape&downloadType=5&datum=2011 | 2,714,404 バイト |

境界データの2つは 2026-11-03 00:47 ごろに web の検証(`web/src/reach/mesh.verify.test.ts`)のために取得したもので、ZIP のまま読む(展開しない)。data の検証(`data/tests/test_refdata_verify.py`)でも使う。加工には使わない。

確かめた配布ページと定義:

- e-Stat の統計表 T001142(令和2年国勢調査 地域メッシュ統計、250m メッシュ、人口及び世帯)の定義書:https://www.e-stat.go.jp/help/data-definition-information/downloaddata/T001142.pdf
- 国土数値情報 人口集中地区データ(2020年版。2024年6月更新):https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A16-2020.html
- 国土数値情報 鉄道データ(2025年度版、2025年12月31日時点。2026年4月更新):https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html

もう一度入手するときは、上の URL から同じ名前で保存し、同じ場所に展開する(`unzip -o mesh/tblT001142Q6542.zip -d mesh/`、`unzip -o did/A16-20_01_GML.zip -d did/A16-20_01_GML`、`unzip -o rail/N02-25_GML.zip -d rail/`)。
