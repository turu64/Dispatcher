# 11/3 のモジュール間の取り決め

11/3 の実装(`docs/plan-1103.md`)を複数の担当で並行して進めるための、関数の形とデータの形の取り決めです。
変えたいときは勝手に変えず、指示役に理由を返してください。

## 共通

- **GTFS のキーの照合**:読み込んだ値は前後の空白を含めて元のまま持つ。`service_id`・`trip_id`・`stop_id`・`route_id` などを照合するときだけ、前後の空白を取る(`trim()`)。返す集合や Map のキーも空白を取った値にする(11/3 決定)
- **日付**:`'YYYYMMDD'` の文字列。曜日は数字から UTC で計算する。`new Date('2026-11-03')` のような文字列からの生成や、ローカル時刻に依存する計算はしない
- **時刻**:サービス日の 0:00 からの秒数。24時を超える値(`25:10:00` → 90600)を許す。時が1桁(`7:05:00`)も許す
- **時間帯**:6時から24時。3時間ごと(6〜9、9〜12、…、21〜24)と1時間ごと(6〜7、…、23〜24)。開始を含み終了を含まない
- **鉄道駅**:時刻表データが無いため、6〜24時のすべての時間帯で使えるものとみなす(11/3 の計画どおり)
- **文言**:コメント、テスト名、画面の文言、エラーは日本語

## web/src/gtfs/calendar.ts(運行日の判定)

```ts
export function isValidGtfsDate(s: string): boolean
export function addDays(date: string, n: number): string          // 'YYYYMMDD' を n 日ずらす
export function weekdayIndex(date: string): number                // 0=月曜 … 6=日曜(GTFS の列の順)
export function activeServiceIds(feed: GtfsFeed, date: string): Set<string>
export function feedServicePeriod(feed: GtfsFeed): { start: string; end: string } | null
```

- `calendar.txt`:曜日の列が `1` で、`start_date <= date <= end_date` なら運行
- `calendar_dates.txt`:`exception_type=1` は追加、`2` は削除。`calendar.txt` より優先する。`calendar.txt` が無いフィード(`calendar_dates.txt` だけ)も扱う
- `feedServicePeriod`:`calendar` の期間と `calendar_dates` の日付の最小・最大。運行日が1つも無ければ `null`

## web/src/gtfs/departures.ts(時間帯ごとの出発)

```ts
export interface TimeBand { startHour: number; endHour: number; label: string }   // label 例:'6〜9時'
export function makeBands(stepHours: 1 | 3): TimeBand[]
export function parseGtfsTime(s: string | undefined): number | null
export interface DepartureCounts {
  counts: Map<string, number[]>   // キーは空白を取った stop_id。値は時間帯ごとの出発の数
  skippedBlankTime: number        // departure_time が空で数えなかった行の数
  hasFrequencies: boolean         // frequencies.txt があれば true(展開はしない)
}
export function departureCountsByBand(
  feed: GtfsFeed,
  services: { today: Set<string>; yesterday: Set<string> },
  bands: TimeBand[],
): DepartureCounts
```

- 対象日 D の便(`today`)は、出発時刻 t をそのまま時間帯に当てはめる。前日 D−1 の便(`yesterday`)は、`t − 86400` を当てはめる(`30:10` は D の 6:10)
- 数えないもの:`pickup_type=1`(乗車できない)の行、各便の最後の停留所(`stop_sequence` を数値として比べて最大のもの)、`departure_time` が空の行(数は `skippedBlankTime` に入れる。補間はしない)
- `stop_times` の `stop_id` をそのままキーにする(標柱の単位)

## web/src/gtfs/parse.ts と Web Worker

```ts
export interface Stop { id: string; name: string; lat: number; lon: number; locationType: number; parentStation: string }
export function toStops(feed: GtfsFeed): { stops: Stop[]; invalid: number }   // 緯度経度が数値でない・範囲外は除き、数だけ返す
// web/src/gtfs/workerClient.ts
export function loadGtfsInWorker(data: Blob | ArrayBuffer): Promise<GtfsFeed>
```

- `id` は空白を取った値。`locationType` は空なら 0
- Worker の中では `loadGtfsZip` を呼ぶだけにし、計算の本体はテストできる純粋な関数に置く

## web/src/reach/mesh.ts(地域メッシュ)

JIS X 0410 の地域メッシュ。8分の1地域メッシュ(約 125m)は 11 桁、4分の1地域メッシュ(約 250m)は 10 桁。

| 区画(セル) | 桁数 | 大きさ(緯度 × 経度) |
| --- | --- | --- |
| 1次 | 4 | 40分 × 1度 |
| 2次 | 6 | 5分 × 7分30秒 |
| 3次 | 8 | 30秒 × 45秒 |
| 2分の1 | 9 | 15秒 × 22.5秒 |
| 4分の1 | 10 | 7.5秒 × 11.25秒 |
| 8分の1 | 11 | 3.75秒 × 5.625秒 |

分割地域メッシュの末尾の数字は、南西 1・南東 2・北西 3・北東 4。

```ts
export interface LatLon { lat: number; lon: number }
export interface Bounds { south: number; west: number; north: number; east: number }
export function meshCode(lat: number, lon: number, digits: 4 | 6 | 8 | 9 | 10 | 11): string
export function meshBounds(code: string): Bounds
export function meshCenter(code: string): LatLon
export function parentCode(code: string, digits: 4 | 6 | 8 | 9 | 10): string
export function meshCodesInBounds(b: Bounds, digits: 4 | 11): string[]
export function distanceM(a: LatLon, b: LatLon): number
export function cellsWithinRadius(points: LatLon[], radiusM: number): string[]   // 中心が radiusM 以内にある 11 桁のセル
export function cellAreaKm2(code: string): number
```

- 境界上の点は、その区画の南西側の端を含む(北・東の端は隣の区画)。浮動小数の誤差で隣にずれないようにする

## 参照データ(data/ が書き、server/ が配り、web/ が読む)

`data/out/ref/{1次メッシュ4桁}.json`。サーバーは `GET /api/ref/{mesh1}` で返す(`mesh1` は数字4桁のみ、無ければ 404)。

```json
{
  "mesh1": "6542",
  "pop250": { "6542xxxxxx": 123 },
  "did125": ["6542xxxxxxx"],
  "stations": [{ "name": "旭川", "line": "函館線", "operator": "北海道旅客鉄道", "lat": 43.7628, "lon": 142.3587 }],
  "sources": ["令和2年国勢調査 地域メッシュ統計(e-Stat)を加工して作成", "国土数値情報(人口集中地区 A16、鉄道 N02)を加工して作成"]
}
```

- `pop250`:4分の1地域メッシュ(10 桁)ごとの人口(総数)。0 人の区画は入れない
- `did125`:中心が人口集中地区(A16、2020 年)の中にある 8分の1地域メッシュ(11 桁)
- `stations`:鉄道(N02)の駅。駅は線で収録されているので、代表点(線の中点)を取る。同じ駅名・同じ事業者の複数の線は1つにまとめる

## web/src/reach/reach.ts(到達圏)

```ts
export type RegionClass = 'urban' | 'suburban' | 'rural'   // 都市部・郊外・中山間・地方
export interface ReachParams {
  densityThreshold: number                                  // 既定 1000(人/km²)
  walkMinutes: Record<RegionClass, { bus: number; rail: number }>   // 既定 5/10、10/15、15/20
  speedMPerMin: number                                      // 既定 80
}
export interface RefData { pop250: Map<string, number>; did125: Set<string>; stations: LatLon[] }
export interface ReachInput {
  stops: { lat: number; lon: number; bandCounts: number[] }[]
  ref: RefData | null
  fallbackClass: RegionClass          // 参照データが無いときに全セルへ当てる区分(既定 'suburban')
  params: ReachParams
  bandCount: number
}
export interface ReachResult {
  cells: string[]                     // 調べたセル(11 桁)
  classes: RegionClass[]
  reachable: boolean[][]              // [時間帯][セル]
  usedFallback: boolean
}
export function computeReach(input: ReachInput): ReachResult
```

- 調べる区画:停留所・駅から最大の徒歩圏(既定では中山間・地方の駅 20 分 = 1,600m)以内にある区画。参照データがあれば、そのうち親の 250m 区画の人口が 1 人以上のものだけ
- 区分:DID の中は都市部。外なら、親の 250m 区画の人口密度(人口 ÷ 区画の面積)がしきい値以上で郊外、未満で中山間・地方
- 到達できる:その時間帯に出発が1本以上ある停留所が、その区画の区分のバス停の徒歩圏にある。または駅が、区分の駅の徒歩圏にある
- **参照データが無いとき**(`/api/ref/{mesh1}` が 404):すべての区画を `fallbackClass`(画面で選べる、既定は郊外)とし、駅は無いものとして計算する。画面にその旨の注意を出す

## 追記(11/3、フェーズ1の結果を受けて。上の記述より優先する)

### 運行日の判定
- `feedServicePeriod` の端は、運行日を生む `calendar` の行の `start_date`・`end_date` と、`exception_type=1` の日付から取る。削除(`exception_type=2`)の日付と、運行日を1日も生まない行は数えない
- 同じ `service_id`・同じ日付に 1 と 2 の両方があれば、削除を優先する
- 追加:`servicesFor(feed, date): { today: Set<string>; yesterday: Set<string> }`(`today` は `date`、`yesterday` は前日の `activeServiceIds`)。画面は `departureCountsByBand` にこれを渡す

### 時間帯ごとの出発
- `counts` には出発が1本も無い停留所は入らない。使う側は `counts.get(id)` が無ければ、すべての時間帯を 0 とみなす
- 追加:`DepartureCounts.skippedInvalidTime: number`(`departure_time` が空ではないが時刻として読めない行の数)。画面で知らせる
- `stop_sequence` は 0 以上の10進の整数だけを読む(`'0x0A'`・`'1e1'` は読めない値)。読めない行は終点の判定に使わない
- `pickup_type` は前後の空白を取って `'1'` と一致する行だけを乗車不可とする(`calendar` の `exception_type` と同じく文字列で照合する)
- `hasFrequencies` は `frequencies.txt` に行が1件以上あるときだけ true

### 参照データ
- 駅の `line` は、複数の路線にまたがる駅では路線名を「・」でつなぐ(例:「宗谷線・函館線・富良野線」)
- 各駅は、代表点を含む1次メッシュのファイルに1回だけ入れる。web は、停留所の範囲(外接矩形)を最大の徒歩圏(既定 1,600m)だけ広げた範囲に入る1次メッシュのファイルを、すべて読む
- 廃止された駅は `data/src/dispatcher_data/closed_stations.csv`(駅名・事業者・路線・廃止日・出典 URL)で除く。N02-25(2025年12月31日時点)には、2026年4月1日に廃止された留萌線(深川〜石狩沼田)の駅が残っているため
- `pop250` に入らない 250m 区画は人口 0 とみなす(e-Stat で秘匿された値も、人口総数は秘匿されないので 0 にはならない)

### 到達圏
- 地域メッシュの範囲外(緯度 0〜66.67 度、経度 100〜200 度の外)や、(0, 0) の停留所は除く
- `ReachResult` に追加:`excludedStops: number`(除いた停留所の数)、`cellPopulation: number[]`(推計人口。親の 250m 区画の人口 ÷ 4。参照データが無ければ 0)
- 距離は `mesh.ts` の `distanceM`(GRS80、ヒュベニの式)にそろえる。kdbush は平面の距離で探すので、候補を取るだけに使い、最後は `distanceM` で判定する
- 追加:`web/src/reach/worker.ts` と `workerClient.ts` の `computeReachInWorker(input): Promise<ReachResult>`(GTFS の Worker と同じ作り)

## 追記2(11/3、フェーズ2の見直しを受けて。上の記述より優先する)

到達圏の表の割合が減便の影響を表すように、調べる区画と集計の分母を変える。

### 調べる区画
- 起点は、`stop_times` に1回以上出てくる停留所で、`location_type` が 0 か空のものだけ。駅は起点にしない(到達できるかの判定にだけ使う)。一度も使われない停留所と、駅舎・出入口などの行は起点にも地図の点にもしない
- 半径は、参照データがあれば3区分のバス停の距離の最大(既定 15 分 × 80m = 1,200m)。参照データが無ければ `fallbackClass` のバス停の距離(既定の郊外なら 800m)
- 参照データがあれば、親の 250m 区画の人口が 1 以上のものだけ(これまでどおり)

### 徒歩圏に停留所・駅がある区画
- `ReachResult.coverable: boolean[]` を足す。区画の区分のバス停の距離以内に起点の停留所がある(その日の出発の有無は問わない)か、区分の駅の距離以内に駅があれば true
- coverable でない区画は「徒歩圏に停留所・駅がない区画」。表の割合の分母は coverable の区画にし、coverable でない区画の数と推計人口は別の行に出す。地図では塗らず、凡例に件数を出す
- 画面が web 側で起点を選ぶ(`ReachInput.stops` には起点の停留所だけを渡す)。`computeReach` は渡された停留所をすべて起点とみなす

### 参照データの読み込み範囲
- 停留所の外接矩形を「バス停の距離の最大 + 駅の距離の最大」(既定 1,200m + 1,600m = 2,800m)だけ広げた範囲の1次メッシュを読む。区画から駅までの距離を判定できるようにするため

### 地図と入力
- 時間帯ごとの可否は、区画の properties の整数 `m` 1つにまとめる(時間帯 b が到達できれば 2^b のビットを立てる)。塗りの式は `["%", ["floor", ["/", ["get", "m"], 2^b]], 2]` で取り出す
- 分数は 0〜60 の整数。しきい値は 0〜100,000

## 追記3(11/3、フェーズ3の確かめを受けて。11/4 の減便の方針の適用と一緒に入れる。上の記述より優先する)

追記2のまま、読み込んだ GTFS ごとに起点を選ぶと、減便で便が無くなった停留所のまわりの区画が、到達圏から外れる区画から消える。
サンプルの減便後 ZIP を単独で読むと、2026-11-04 の3時間ごとの到達圏から外れる割合は全時間帯で減便前より下がって見える
(6〜9時 14.1% → 12.5%)。減便前の見込みのある区画 17,200 を分母にそろえ、消えた 641 区画を到達圏から外れる側に数えると、全時間帯で上がる(6〜9時 15.8%)。

### 減便前の GTFS
- 起点・調べる区画・徒歩圏に停留所・駅がある区画(coverable)・区分は、**減便前の GTFS**(利用者が読み込んだもの)から一度だけ決める
- 減便の方針の適用・便を平日に戻す操作で作った GTFS の到達圏も、減便前の起点と coverable を使う。時間帯ごとの出発の数だけを、減便後の GTFS から数える
- 前後の比較は、同じ日付の「減便前の GTFS」と「減便後の GTFS」で行う。分母は減便前の coverable
- 外で減便済みの GTFS を単独で読んだときは、そのフィードが減便前の GTFS になる(新旧 GTFS の突合はやらない)
- 出力は形2(便の入れ替え。2026-11-03 に利用者が決定)なので、減便後の GTFS では停留所が `stop_times` から消えうる。減便前の起点を使うのは必須

### 受け入れ条件
- 小さなフィードで、ある便を消すとある停留所が `stop_times` からなくなる場合を作る。減便前の起点を渡したとき、その停留所のまわりの区画が「到達圏から外れる区画」に残り、分母から消えないことをテストで確かめる
- 実データの照合(`reach.verify.test.ts` の PYTHON)は、11/4 の実装と同じ1回で計算し直す

### 候補(11/4 に一緒に決める)
- 乗れる行が一度も無い停留所(すべて終点か `pickup_type` が 1。サンプルでは旭川駅前 0010_10・旭川空港 9000_02 など 10 件)は起点にしない。今はこの停留所しか徒歩圏に無い区画(124)が、いつも到達圏から外れる側に数えられる
