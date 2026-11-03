# 元データの置き場所

ここには元データを置きます。中身はコミットしません(`.gitignore` で除外しています)。
GTFS は利用フォームの記入が先なので、利用者が手で入手して置きます。
e-Stat の人口メッシュ、国土数値情報、内閣府の祝日一覧は、公式の配布元からダウンロードしてよいことになっています(2026-11-03 に利用者が許可)。
加工スクリプト(`uv run dispatcher-data`、`uv run dispatcher-holidays`)自体はダウンロードしません。

| 置く場所 | データ | 入手先 | 利用条件 |
| --- | --- | --- | --- |
| `gtfs/` | 道北バスなど北海道の事業者の GTFS(ZIP)。道北バスは `dohoku_bus_減便前.zip`(9/17 作成の版。画面の「サンプルを読み込む」で使う)と `dohoku_bus_減便後.zip`(10/29 作成の版。比較用)の名前で置く。どちらもテストで使う | 北海道オープンデータプラットフォーム(ckan.hoda.jp、データセット「gtfs-data」)。**利用前にフォームへの記入が必要** | CC BY 4.0 |
| `mesh/` | 令和2年国勢調査 地域メッシュ統計「人口及び世帯」の 4分の1地域メッシュ(約 250m、統計表 T001142)。1次メッシュごとの `tblT001142Q{1次メッシュ}.zip` と、展開した `tblT001142Q{1次メッシュ}.txt` | e-Stat「地図で見る統計(統計GIS)」のデータダウンロード | 政府標準利用規約(CC BY 4.0 互換) |
| `did/` | 人口集中地区(A16、2020年、北海道)。`A16-20_01_GML.zip` と、展開した `A16-20_01_GML/A16-20_01_DID.geojson` ほか | 国土数値情報 | 配布ページの記載は「1995年(平成7年)以降:商用可」 |
| `rail/` | 鉄道(N02、2025年度版、全国)。`N02-25_GML.zip` と、展開した `N02-25_GML/UTF-8/N02-25_Station.geojson` ほか | 国土数値情報 | 2020年以降はオープンデータ(CC BY 4.0) |
| `school/` | 学校(P29、2023年度、北海道)。`P29-23_01_GML.zip` と、展開した `P29-23_01_GML/P29-23_01.geojson` ほか | 国土数値情報 | CC BY 4.0(配布ページの使用許諾条件は「オープンデータ(CC_BY_4.0)」) |
| `medical/` | 医療機関(P04、2020年度、北海道)。`P04-20_01_GML.zip` と、展開した `P04-20_01_GML/P04-20_01.geojson` ほか | 国土数値情報 | CC BY 4.0(同上) |
| `busstop/` | バス停留所(P11、2022年度、北海道)。`P11-22_01_GML.zip` と、展開した `P11-22_01_GML/P11-22_01.xml`(GML のみ。GeoJSON は無い) | 国土数値情報 | CC BY 4.0(2022年度は「オープンデータ(CC_BY_4.0)」。2010年度は非商用なので使わない) |
| `admin/` | 国土数値情報用の行政区域コード(`AdminiBoundary_CD.xlsx`、令和6年1月1日現在)。`data/src/dispatcher_data/hokkaido_municipalities.csv`(コミットする)の元 | 国土数値情報 | 国土数値情報の利用約款 |
| `holidays/` | 国民の祝日の一覧(`syukujitsu.csv`。1955年から翌年末までの祝日、Shift_JIS)。`uv run dispatcher-holidays` で `data/out/ref/holidays.json` にする | 内閣府「国民の祝日について」(https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html) | 内閣府ホームページ利用規約(令和7年3月25日現在)が、個別の記載が無いコンテンツに公共データ利用規約(第1.0版)を適用する。CC BY 4.0 互換で、出典の記載と、加工したときは加工した旨の記載が必要。政府標準利用規約(第2.0版)ではない(確かめた記録は下) |

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

2026-11-03 07:40(日本時間)に curl でダウンロードした(祝日の一覧)。新しい空のフォルダ `holidays/` に入れ、中身は信用しないデータとして扱う(Python で読むときは `-I`)。

| 置いた場所 | 入手元の URL | 大きさ | SHA-256 |
| --- | --- | --- | --- |
| `holidays/syukujitsu.csv` | https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv | 21,538 バイト(サーバーの `Last-Modified` は 2026-02-02 09:30 日本時間) | `cec37a743c96995cdb9cb52b685c9003634682a9b0e1a640a6b9b96881fe964a` |

中身は、見出し `国民の祝日・休日月日,国民の祝日・休日名称` の次から 1,067 行(1955/1/1 元日〜2027/11/23 勤労感謝の日)。文字コードは Shift_JIS(cp932)、改行は CRLF、BOM なし、日付は `2027/1/1` のようにゼロを詰めない。
振替休日と国民の休日の名称は「休日」(2027/3/22 など)。内閣府のページに「令和10年(2028年)の国民の祝日は、前年(令和9年(2027年))の2月に掲載します」とあり、最後の年は年末まで載っているとみなす(`coveredUntil`)。

2026-11-03 16:26(日本時間)に curl でダウンロードした(施設: P29・P04・P11)。それぞれ新しい空のフォルダ(`school/`・`medical/`・`busstop/`)に入れ、中身は信用しないデータとして扱う(Python で読むときは `-I`。展開したファイルは読むだけで、実行していない)。

| 置いた場所 | 入手元の URL | 大きさ | SHA-256 |
| --- | --- | --- | --- |
| `school/P29-23_01_GML.zip` | https://nlftp.mlit.go.jp/ksj/gml/data/P29/P29-23/P29-23_01_GML.zip | 459,964 バイト | `3682bf0d6790372a3140a2c65b638a4ae21cda94b0662ea14e5f8bdaf3d76987` |
| `medical/P04-20_01_GML.zip` | https://nlftp.mlit.go.jp/ksj/gml/data/P04/P04-20/P04-20_01_GML.zip | 1,051,601 バイト | `a0237460b5c03b6367aa1abd3acebbc72ed83e1ea02263bbc86c667279aa8b94` |
| `busstop/P11-22_01_GML.zip` | https://nlftp.mlit.go.jp/ksj/gml/data/P11/P11-22/P11-22_01_GML.zip | 458,101 バイト | `89cab36a4e34fd2aafb1bb9021c032a36b49c7281e44561edd4226bc3f616dbf` |

2026-11-03 16:34(日本時間)に、市区町村名を引くための行政区域コードの一覧も取得した(`admin/` に入れた)。

| 置いた場所 | 入手元の URL | 大きさ | SHA-256 |
| --- | --- | --- | --- |
| `admin/AdminiBoundary_CD.xlsx` | https://nlftp.mlit.go.jp/ksj/gml/codelist/AdminiBoundary_CD.xlsx | 245,492 バイト | `a2e7d3d88315682946f641dcd442b726169b4ca50188b4b5f2dbfd08463de3ff` |

中身と注意:

- 展開は `unzip -o school/P29-23_01_GML.zip -d school/`、`unzip -o medical/P04-20_01_GML.zip -d medical/`、`unzip -o busstop/P11-22_01_GML.zip -d busstop/`。P04 の ZIP は区切りがバックスラッシュ(`P04-20_01_GML\P04-20_01.geojson`)で、unzip は警告を出すがフォルダ `P04-20_01_GML/` に正しく展開される
- GeoJSON(P29・P04)と GML(P11)は UTF-8、座標は JGD2011(EPSG:6668)。P29・P04 は `[経度, 緯度]`、P11 の `gml:pos` は「緯度 経度」の順。各フォルダの `KS-META-….xml`(メタデータ)は Shift_JIS
- 北海道の件数:学校 2,824 行(キャンパスが複数ある学校コードが 7 つ。北海道大学は 15 キャンパス)、医療機関 6,903 行(病院 550、診療所 3,464、歯科診療所 2,889。病床数 20 床以上がちょうど病院)、バス停留所 14,474 か所(事業者名 67)
- P29 の属性:`P29_001` 行政区域コード、`P29_002` 学校コード、`P29_003` 学校分類(16001 小学校、16002 中学校、16003 中等教育学校、16004 高等学校、16005 高等専門学校、16006 短期大学、16007 大学、16011 幼稚園、16012 特別支援学校、16013 幼保連携型認定こども園、16014 義務教育学校、16015 各種学校、16016 専修学校)、`P29_004` 名称、`P29_005` 所在地、`P29_006` 管理者、`P29_007` 休校区分(2 が休校中。配布の定義に無い 9 が 7 行ある。廃校になった学校に付いていて、加工では休校中と同じにせず入れ、`open_status` を「不明」にしている)、`P29_008` キャンパスコード、`P29_009` 学校名備考
- P04 の属性:`P04_001` 医療機関分類(1 病院、2 診療所、3 歯科診療所)、`P04_002` 施設名称、`P04_003` 所在地(市区町村の行政区域コードは無い)、`P04_008` 病床数、`P04_009` 救急告示病院(1 が指定あり)、`P04_010` 災害拠点病院(1 基幹、2 地域)
- P11 の GML:`ksj:BusStop` の `ksj:bsn` が停留所名、`ksj:boc` が事業者名(コミュニティバスは自治体名)、`ksj:loc` が `gml:Point` への参照
- 加工は `cd data && uv run dispatcher-data`(参照データと一緒に `data/out/ref/facilities/{1次メッシュ}.json` ができる)か、施設だけなら `uv run python -m dispatcher_data.facilities`。加工の決め事は `data/src/dispatcher_data/facilities.py` の先頭に書いてある
- `data/src/dispatcher_data/hokkaido_municipalities.csv`(コミットする。195 行)は `admin/AdminiBoundary_CD.xlsx` の「01」で始まる行から、北海道全体の行(01000)、改正で欠番になった行、読み仮名を除いて作った。xlsx の取り直しで更新するときも同じ条件で作る

確かめた配布ページと定義:

- e-Stat の統計表 T001142(令和2年国勢調査 地域メッシュ統計、250m メッシュ、人口及び世帯)の定義書:https://www.e-stat.go.jp/help/data-definition-information/downloaddata/T001142.pdf
- 国土数値情報 人口集中地区データ(2020年版。2024年6月更新):https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A16-2020.html
- 国土数値情報 鉄道データ(2025年度版、2025年12月31日時点。2026年4月更新):https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html
- 内閣府「国民の祝日について」(祝日一覧の配布ページ。2026-11-03 に確認):https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
  - 利用条件の記載は無い(CSV へのリンクと「令和10年の国民の祝日は、前年の2月に掲載します」だけ)。ページの下のリンクにも利用規約は無い
  - サイト全体の規約:内閣府ホームページ利用規約(令和7年3月25日現在)https://www.cao.go.jp/notice/rule.html 。コンテンツの著作権は特記されていない限り内閣府に帰属し、権利表記の記載がない限り公共データ利用規約(第1.0版)(デジタル庁)が適用される。祝日一覧の配布ページは、適用外とされた個別の規約の一覧(政府広報オンライン、世論調査、地方創生ウェブサイトなど)に入っていない
  - 公共データ利用規約(第1.0版)(令和6年7月5日制定。政府標準利用規約の後継):https://www.digital.go.jp/resources/open_data/public_data_license_v1.0 。クリエイティブ・コモンズ表示 4.0 国際ライセンス(CC BY)と互換性がある。出典の記載が必要で、編集・加工して使うときは、加工したことと、その主体を記載する(例:「○○」(D庁)(URL)を加工して作成)。数値データ・簡単な表は著作権の保護の対象ではなく、規約の適用が無い
  - CLAUDE.md の「データと出典」の表の e-Stat は政府標準利用規約だが、内閣府の祝日一覧は政府標準利用規約(第2.0版)ではなく公共データ利用規約(第1.0版)が適用される。画面と README の祝日の行は「公共データ利用規約(第1.0版)」と表示する

祝日の一覧だけを取り直すときは、`curl -o data/raw/holidays/syukujitsu.csv https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv` で取り直し(内閣府は 2 月に翌年分を足す)、`cd data && uv run dispatcher-holidays` で JSON にし直す。
ほかのデータをもう一度入手するときは、上の URL から同じ名前で保存し、同じ場所に展開する(`unzip -o mesh/tblT001142Q6542.zip -d mesh/`、`unzip -o did/A16-20_01_GML.zip -d did/A16-20_01_GML`、`unzip -o rail/N02-25_GML.zip -d rail/`、`unzip -o school/P29-23_01_GML.zip -d school/`、`unzip -o medical/P04-20_01_GML.zip -d medical/`、`unzip -o busstop/P11-22_01_GML.zip -d busstop/`)。
