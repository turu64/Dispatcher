# 形2(便の入れ替え)の参照実装(data/tools/)

平日ダイヤを土曜ダイヤに入れ替える編集(`docs/interfaces-1104.md` の §5「形2」)を、Python の標準ライブラリだけで書いた参照実装です。
画面の TypeScript の実装(`web/src/gtfs/edit/form2.ts`)の出力を、バイト単位で照らし合わせる正解データを作るために使います。
画面のコードは、ここの Python を import せず、別に書きます(再利用ではなく、突き合わせの相手として置いています)。

| ファイル | 中身 |
| --- | --- |
| `form2_ref.py` | 形2の参照実装。標準ライブラリだけで動き、ほかのスクリプトを import しない |
| `policies/*.json` | 場面ごとの方針の JSON(5 つ。下の「場面」) |

テストは `data/tests/test_form2_ref.py`(手で作った小さな GTFS と、道北バスの GTFS があれば 5 つの場面の出力の SHA-256)。

## 使い方

入力は GTFS の ZIP(展開しない)と、方針の JSON です。出力は新しいフォルダに書きます(無ければ作ります)。リポジトリの最上位から:

```bash
python3 -I data/tools/form2_ref.py \
  --gtfs data/raw/gtfs/dohoku_bus_減便前.zip \
  --policy data/tools/policies/main.json \
  --out data/out/form2/main \
  --generated-at 202611041200 \
  [--self-test]
```

- `--gtfs`:入力の GTFS(ZIP)。道北バスの 9/17 作成の版(`dohoku_bus_減便前.zip`、利用者が `data/raw/gtfs/` に置く。`data/raw/README.md`)
- `--policy`:方針の JSON(下の「方針の JSON」)
- `--out`:出力のフォルダ。`trips.txt`・`stop_times.txt`・`calendar.txt`・`calendar_dates.txt`・`feed_info.txt` と `summary.json` を書く。`data/out/` はコミットしない
- `--generated-at`:作成日時 `YYYYMMDDhhmm`(日本時間)。**必須**。`feed_version` に使う。壁時計を読まないので、同じ入力・方針・作成日時からは同じバイト列が出る
- `--self-test`:入力の `.txt` をすべて読み直して書き、入力とバイト単位で一致するか確かめる(CSV の読み書きが入力の書き方を保つことの確認。道北バスでは一致する)
- Python 3.9.6 と 3.13 で動き、`main` の出力が下の SHA-256 と同じになることを確かめた(これより古い版は試していない)。標準ライブラリ以外は要らないので、`uv` も要らない

道北バスの GTFS が手元にある利用者向けの手順は、`data/raw/README.md` と、このフォルダの `policies/` を見てください。標準出力に平日の便数(`weekday trips 382 (from replacement 354, kept 8, added back 20), warnings 0`)が出ます。

## データの出典

- 道北バスの GTFS:北海道オープンデータプラットフォーム(CC BY 4.0)。ZIP はリポジトリに入れない(`.gitignore`)
- このフォルダの `policies/*.json` の `addBackTripIds`・`excludedRoutes` と、`data/tests/test_form2_ref.py` の SHA-256 は、道北バスの GTFS(9/17 作成の版)の `trip_id`・`route_id` を含む。道北バスの GTFS を加工して作成した(各場面の出力は、`trips.txt`・`stop_times.txt`・`calendar.txt`・`calendar_dates.txt`・`feed_info.txt` を入れ替え・切り詰めたもの)。加工した主体は Dispatcher の開発者(期間中に作成)

## 方針の JSON

```json
{"weekdayService": "01", "replacementService": "03",
 "period": {"start": "20261101", "end": null},
 "excludedRoutes": ["0051", "0151"],
 "addBackTripIds": ["0002_01_01_01_1610", "..."]}
```

## 場面

どれも入力は 9/17 版(有効期間 20261001〜20261130、平日 447 便、土曜 361 便)。`--generated-at` は `202611041200`。

| 場面 | 方針 | 平日便 | 確かめること |
| --- | --- | --- | --- |
| `main` | 土曜ダイヤに入れ替え、除外 0051・0151、足し戻し 20 便、期間 20261101〜null | 382(354+8+20) | 正解の場面。10/29 版(減便後)の平日便と署名で 374 便が一致し、main だけの便が 8、10/29 版だけの便が 7(15 便とも理由を説明できる) |
| `addBack24` | main の足し戻しに除外系統の 4 便を足した 24 便 | 382 | 4 便が `ignoredExcludedRoute` になり、CSV が main とバイト単位で同じ |
| `replaceOnly` | 除外・足し戻しなし | 361 | 入れ替えだけ |
| `periodEnd` | main で期間 20261027〜20261110 | 382 | 有効期間 15 日、`calendar_dates` は 20261103 の 3 行だけ |
| `edgeCases` | 足し戻しに重なり・既にある便・除外系統・無い便・土曜便・重複を混ぜる | 364 | `0004_01_01_03_0710` の写しが `0004_01_01_01_0710_2` になる、など |

出力の 5 表の SHA-256(`main`。`data/tests/test_form2_ref.py` に 5 場面の分がある):

| ファイル | 行数(見出しを除く) | SHA-256 |
| --- | --- | --- |
| `trips.txt` | 1104 | `ce5d460a766a8a2d5c1e644b5b91104ee79d7327ad955c5a0d8c23fe4df95369` |
| `stop_times.txt` | 45038 | `ef6e0dd2fbded3b981c57793b75b536385681442db320d28d35c321ba627a378` |
| `calendar.txt` | 3 | `4e1b57ad128edcd7c78f229ea4f6ea0976b5744632bae534046f898551101f90` |
| `calendar_dates.txt` | 6 | `56d5b677d6a98d2575891c82d5de71bcf480123c197b6a7a0335cd78cfe3cfe0` |
| `feed_info.txt` | 1 | `63db1a10cdf687daed5245899708b0171f5bce6c8fa50f5bc5500fe3c407dace` |

入力の ZIP の SHA-256(9/17 版)は `d81998880e2141d0f405c65fd2b2e5e2c9516842b94d61dd59f1cc54cf451abb`。別の版が置いてあると、テストは飛ばします。

### main と 10/29 版(減便後)の違い

署名で 374 便が一致し、main だけにある便が 8、10/29 版だけにある便が 7。15 便すべてに理由が付き、説明できない差は 0。

| 側 | 理由 | 系統 | 便数 |
| --- | --- | --- | --- |
| main だけ | 冬季の切り替えで土曜ダイヤから消えた | 0069 上野ファーム線 | 6 |
| main だけ | 同上 | 0086 大雪湖線 | 2 |
| 10/29 版だけ | 冬季の切り替えで土曜ダイヤに入った(0069 の 6 便と同じ運用・順番。うち 3 便は始発が 6 分遅い) | 0068 永山13丁目線 | 6 |
| 10/29 版だけ | 冬季だけの平日便 | 0662 忠和線(大橋)07:30 | 1 |

一致した 374 便では、`trips` の列(`trip_headsign` など)と `stop_times` の列(`stop_sequence`、`pickup_type`、`drop_off_type` など)に違いは無い。`trip_id` が 10/29 版と同じなのは 374 便のうち 240 便。

## 規則

1. 平日の便(`service_id = weekdayService`)のうち、`excludedRoutes` の系統の便はそのまま残す(kept)。
2. 入れ替え元の便(`service_id = replacementService`)のうち、除外系統でない便を写して平日の便にする(derived)。`trips` の列は写し元のまま、`trip_id` と `service_id` だけ変える。`stop_times` は写し元の行をそのまま写し、`trip_id` だけ変える。`stop_sequence` は振り直さない(9/17 版には番号が飛ぶ便が 36 ある)。
3. `addBackTripIds` を上から順に調べ、次のどれかに分ける。受け付けた便は元の行のまま残す。
   - `notFound`:無い `trip_id`
   - `notWeekday`:平日の service でない
   - `ignoredExcludedRoute`:除外系統の便(1 で残っている)
   - `ignoredAlreadyPresent`:署名が derived の便か、先に受け付けた便と同じ(`sameAs` に相手の `trip_id`)
   - `duplicate`:同じ `trip_id` が 2 回目以降
   - `accepted`:足し戻す
4. 上のどれにも入らない平日の便は消す(removed)。
5. `trip_id` の規則(`rule: "replace-service-part"`)
   - derived:写し元の `trip_id` が `^\d{4}_\d{2}_\d{2}_\d{2}_\d{4}$` に合い、4 つ目の部分が `replacementService` なら、そこを `weekdayService` に置き換える(`0026_01_01_03_0705` → `0026_01_01_01_0705`)。合わなければ `{元の id}_{weekdayService}`(仮の規則)。
   - kept と accepted:元の `trip_id` のまま。
   - 重なり:先に、平日以外の便・kept・accepted の id を押さえる。derived の候補がそれと重なったら、候補の後ろに `_2`、`_3` … を付ける(`0004_01_01_01_0710` → `0004_01_01_01_0710_2`)。derived は写し元の `trip_id` の昇順に割り当てる。重なりは `tripIds.collisions` に残す。
6. 有効期間:`新しい開始日 = max(入力の開始日, period.start)`、`新しい末日 = period.end が null なら入力の末日、そうでなければ min(入力の末日, period.end)`。入力の開始日・末日は `feed_info` の `feed_start_date`・`feed_end_date`(無ければ `calendar` と `calendar_dates` の最小・最大)。
   - `calendar`:各行の `start_date`・`end_date` を新しい有効期間に切り詰める。空になる行は外して警告。
   - `calendar_dates`:新しい有効期間の中の行だけ残す。並びは入力のまま。祝日の例外の行は書き換えない。
   - `feed_info`:`feed_start_date`・`feed_end_date` を新しい有効期間に、`feed_version` を下の規則で更新する。
   - 有効期間が 7 日以下なら警告(GTFS-JP)。
7. `feed_version` の規則:入力が 12 桁の数字(道北バスは作成日時 `YYYYMMDDhhmm`)なら、出力の作成日時(日本時間、`--generated-at`)にする。入力が空なら作成日時。それ以外は `{入力}_dispatcher_{作成日時}`。新しい値が入力以下なら警告。
8. 行の並び:入力の `trips` が `(service_id, trip_id)` の昇順なら出力もそうする(道北バスは両版ともこの並び)。`trip_id` の昇順ならそれに従う。どちらでもなければ入力の並びのまま、derived を末尾に足す。`stop_times` は、入力が `trips` と同じ順に便ごとにまとまっていれば出力の `trips` の順に並べ、便の中は入力の行の順。文字列の比較はコードポイント順(ASCII の範囲では JavaScript の既定の `sort` と同じ)。
9. CSV の書き方:見出しの列の並び、BOM の有無、改行コード(道北バスは CRLF、BOM なし、最終行も CRLF)を入力に合わせる。引用符は必要なときだけ(道北バスでは付かない)。
10. 書き出す表は `trips`・`stop_times`・`calendar`・`calendar_dates`・`feed_info` の 5 つ。ほかの表(`agency`・`stops`・`routes`・`fare_attributes`・`fare_rules`・`translations`)は入力のまま使う前提で書き出さない。

## 署名

便を比べる単位。`trip_id` は比べない。

```
route_id + "\t" + ";".join(stop_id + "," + arrival_time + "," + departure_time  for 行 in stop_sequence の数値順)
```

`signatureDigest` は、対象の便の署名を重複も含めてコードポイント順に並べ、`"\n"` でつないだ UTF-8 の SHA-256(末尾に改行を付けない)。

## summary.json

キーはこの順に並ぶ。

```
schema                    "dispatcher-form2-summary/1"
generatedAt               "YYYYMMDDhhmm"
input
  feedVersion
  feedStartDate
  feedEndDate
  tripCountByService      {service_id: 便数}(service_id の昇順)
  weekday                 <便の集計>(入力の平日の便)
policy
  weekdayService
  replacementService
  period                  {start, end}
  excludedRoutes          (渡した順)
  addBackTripIds          (渡した順)
output
  feedVersion
  feedStartDate
  feedEndDate
  validityDays            開始日と末日を含む日数
  tripCountByService
  weekday
    tripCount
    composition           {fromReplacement, keptExcludedRoutes, addedBack}
    versusInput           {sameSignature, removed, added}  入力の平日便と署名で比べた数
    <便の集計>(tripCount を除く)
  calendar                [{service_id, start_date, end_date}](calendar.txt の行の順)
  calendarDates           {kept: 行数, dropped: [{service_id, date, exception_type}](入力の行の順)}
tripIds
  rule                    "replace-service-part"
  derived                 [{from, to}](from の昇順)
  kept                    [trip_id](昇順)
  addedBack               [trip_id](昇順)
  removed                 [trip_id](昇順)
  collisions              [{from, candidate, assigned, collidedWithService}]
addBack
  requested               渡した件数
  accepted                [trip_id](昇順)
  ignoredExcludedRoute    [trip_id](昇順)
  ignoredAlreadyPresent   [{tripId, sameAs}](tripId の昇順)
  notWeekday              [trip_id](昇順)
  notFound                [trip_id](昇順)
  duplicate               [trip_id](昇順)
rowOrder                  {trips: "service_id,trip_id" | "trip_id" | "input", stop_times: "trips" | "input"}
files                     {ファイル名: {rows, sha256}}(trips, stop_times, calendar, calendar_dates, feed_info の順)
warnings                  [文字列]
```

`<便の集計>`(1 つの service の便について):

| キー | 定義 |
| --- | --- |
| `tripCount` | 便数 |
| `stopTimeCount` | `stop_times` の行数 |
| `tripCountByRoute` | `route_id` ごとの便数(`route_id` の昇順) |
| `tripsByFirstDepartureHour` | 最初の停留所(`stop_sequence` 最小)の `departure_time` の「時」(2 桁、24 以上もそのまま)ごとの便数。キーは便のある時だけ、昇順 |
| `tripsByNotice47Band` | 公示第47号の旭川などの時間帯。始発の時 h で `06-09`(6≦h≦9)、`10-14`、`15-19`、`20-05`(それ以外。24 以上も含む)。キーはこの順で 4 つとも出す |
| `departuresByHour` | `pickup_type` が 1 でない `stop_times` の行(空は 0 とみなす)を、`departure_time` の時で数えたもの。キーは行のある時だけ、昇順 |
| `untimedDepartureRows` | 上の行のうち `departure_time` が空の行の数 |
| `stopsWithDeparturesBy3hBand` | 到達圏の時間帯 `06-09`・`09-12`・`12-15`・`15-18`・`18-21`・`21-24`(半開区間 [開始, 終了))に、上の出発が 1 つ以上ある `stop_id` の数 |
| `signatureDigest` | 上の「署名」の SHA-256 |

公示第47号の時間帯の集計は、資料(`docs/research/dia-planning.md`)の 9/17 版 130/160/137/20、10/29 版 112/139/114/16 と一致することを確かめた。
