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

| 区画 | 桁数 | 大きさ(緯度 × 経度) |
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

- 境界上の点は、そのセルの南西側の端を含む(北・東の端は隣のセル)。浮動小数の誤差で隣にずれないようにする

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

- `pop250`:4分の1地域メッシュ(10 桁)ごとの人口(総数)。0 人のセルは入れない
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

- 調べるセル:停留所・駅から最大の徒歩圏(既定では中山間・地方の駅 20 分 = 1,600m)以内にあるセル。参照データがあれば、そのうち親の 250m セルの人口が 1 人以上のものだけ
- 区分:DID の中は都市部。外なら、親の 250m セルの人口密度(人口 ÷ セルの面積)がしきい値以上で郊外、未満で中山間・地方
- 到達できる:その時間帯に出発が1本以上ある停留所が、そのセルの区分のバス停の徒歩圏にある。または駅が、区分の駅の徒歩圏にある
- **参照データが無いとき**(`/api/ref/{mesh1}` が 404):すべてのセルを `fallbackClass`(画面で選べる、既定は郊外)とし、駅は無いものとして計算する。画面にその旨の注意を出す
