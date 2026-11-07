import type { GtfsFeed, GtfsRow } from '../load'
import type { Form2Plan } from './ops'

/**
 * 形2のテストで使う、手で作る小さなフィード(取り決め 1104 §11)。テストのファイルではない(ほかのテストからも読み込む)。
 *
 * - service:WK(月〜金)、SA(土)、SU(日)。calendar はすべて 20261001〜20261130。
 *   calendar_dates は 20261012 と 20261103 に WK,2・SA,2・SU,1
 * - trip_id は {系統}_{時刻}_{service_id}(service_id は3つ目の部分)
 * - R1:平日 R1_0700_WK(A→B)・R1_0800_WK(A→B、08:00)、土曜 R1_0700_SA(R1_0700_WK と同じ時刻)・
 *   R1_0805_SA(08:05)・R1_0800_SA(08:00 だが C→B)
 * - R2(除外用):平日 R2_0900_WK、土曜 R2_1000_SA
 * - R3(平日だけ):平日 R3_0730_WK。停留所 S9 を通るのはこの便だけ
 * - 日曜の便 R1_0805_SU、feed_info(feed_version 202609171038、20261001〜20261130)、agency、routes、stops
 * - trips は (service_id, trip_id) の昇順、stop_times は trips の順に便ごとにまとめてある。各便の最後の停留所は pickup_type=1
 */

/** 引用符の無い簡単な CSV を行にする(値の前後の空白は元のまま残す) */
export function rowsOf(csv: string): GtfsRow[] {
  const [header, ...lines] = csv.trim().split('\n')
  const fields = header.split(',')
  return lines.map((line) => {
    const values = line.split(',')
    const row: GtfsRow = {}
    fields.forEach((f, i) => {
      if (i < values.length) row[f] = values[i]
    })
    return row
  })
}

/** 表の名前ごとの行からフィードを作る。列は1行目のキー(行が無ければ fields で渡す) */
export function feedOf(tables: Record<string, GtfsRow[]>, fields: Record<string, string[]> = {}): GtfsFeed {
  return {
    tables: new Map(
      Object.entries(tables).map(([name, rows]) => [
        name,
        { fileName: `${name}.txt`, fields: fields[name] ?? Object.keys(rows[0] ?? {}), rows },
      ]),
    ),
    warnings: [],
  }
}

export const AGENCY = `
agency_id,agency_name,agency_url,agency_timezone,agency_lang
1,テストバス,https://example.jp/,Asia/Tokyo,ja`

export const ROUTES = `
route_id,agency_id,route_short_name,route_long_name,route_type
R1,1,1,駅前線,3
R2,1,2,市役所線,3
R3,1,3,学校線,3`

export const STOPS = `
stop_id,stop_name,stop_lat,stop_lon
A,駅前,43.76,142.36
B,市役所,43.77,142.37
C,病院前,43.78,142.38
S9,学校前,43.79,142.39`

export const CALENDAR = `
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
SA,0,0,0,0,0,1,0,20261001,20261130
SU,0,0,0,0,0,0,1,20261001,20261130
WK,1,1,1,1,1,0,0,20261001,20261130`

export const CALENDAR_DATES = `
service_id,date,exception_type
WK,20261012,2
SA,20261012,2
SU,20261012,1
WK,20261103,2
SA,20261103,2
SU,20261103,1`

export const TRIPS = `
route_id,service_id,trip_id,trip_headsign,block_id
R1,SA,R1_0700_SA,市役所,
R1,SA,R1_0800_SA,市役所,
R1,SA,R1_0805_SA,市役所,
R2,SA,R2_1000_SA,病院前,
R1,SU,R1_0805_SU,市役所,
R1,WK,R1_0700_WK,市役所,
R1,WK,R1_0800_WK,市役所,
R2,WK,R2_0900_WK,病院前,
R3,WK,R3_0730_WK,市役所,`

export const STOP_TIMES = `
trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type
R1_0700_SA,07:00:00,07:00:00,A,1,0,1
R1_0700_SA,07:10:00,07:10:00,B,2,1,0
R1_0800_SA,08:00:00,08:00:00,C,1,0,1
R1_0800_SA,08:10:00,08:10:00,B,2,1,0
R1_0805_SA,08:05:00,08:05:00,A,1,0,1
R1_0805_SA,08:15:00,08:15:00,B,2,1,0
R2_1000_SA,10:00:00,10:00:00,A,1,0,1
R2_1000_SA,10:20:00,10:20:00,C,2,1,0
R1_0805_SU,08:05:00,08:05:00,A,1,0,1
R1_0805_SU,08:15:00,08:15:00,B,2,1,0
R1_0700_WK,07:00:00,07:00:00,A,1,0,1
R1_0700_WK,07:10:00,07:10:00,B,2,1,0
R1_0800_WK,08:00:00,08:00:00,A,1,0,1
R1_0800_WK,08:10:00,08:10:00,B,2,1,0
R2_0900_WK,09:00:00,09:00:00,A,1,0,1
R2_0900_WK,09:20:00,09:20:00,C,2,1,0
R3_0730_WK,07:30:00,07:30:00,A,1,0,1
R3_0730_WK,07:40:00,07:40:00,S9,2,0,0
R3_0730_WK,07:50:00,07:50:00,B,3,1,0`

export const FEED_INFO = `
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version
テストバス,https://example.jp/,ja,20261001,20261130,202609171038`

/** 小さなフィード(呼ぶたびに新しく作る) */
export function smallFeed(): GtfsFeed {
  return feedOf({
    agency: rowsOf(AGENCY),
    routes: rowsOf(ROUTES),
    stops: rowsOf(STOPS),
    calendar: rowsOf(CALENDAR),
    calendar_dates: rowsOf(CALENDAR_DATES),
    trips: rowsOf(TRIPS),
    stop_times: rowsOf(STOP_TIMES),
    feed_info: rowsOf(FEED_INFO),
  })
}

/** 平日を土曜ダイヤに、20261101 から当面の間。除外・足し戻しなし */
export function basePlan(overrides: Partial<Form2Plan> = {}): Form2Plan {
  return {
    kind: 'weekdayToSaturday',
    weekdayService: 'WK',
    replacementService: 'SA',
    period: { start: '20261101', end: null },
    excludedRoutes: [],
    addBackTripIds: [],
    ...overrides,
  }
}

/** 表の行を差し替えた新しいフィード(ほかの表は同じ参照) */
export function withRows(feed: GtfsFeed, name: string, rows: GtfsRow[], fields?: string[]): GtfsFeed {
  const tables = new Map(feed.tables)
  const table = feed.tables.get(name)
  tables.set(name, { fileName: table?.fileName ?? `${name}.txt`, fields: fields ?? table?.fields ?? Object.keys(rows[0] ?? {}), rows })
  return { tables, warnings: feed.warnings }
}

/** 表を除いた新しいフィード */
export function without(feed: GtfsFeed, name: string): GtfsFeed {
  const tables = new Map(feed.tables)
  tables.delete(name)
  return { tables, warnings: feed.warnings }
}

/** 便の trip_id を変えた新しいフィード(trips と stop_times の両方) */
export function renameTrip(feed: GtfsFeed, from: string, to: string): GtfsFeed {
  const rename = (r: GtfsRow) => (r.trip_id === from ? { ...r, trip_id: to } : r)
  const f = withRows(feed, 'trips', feed.tables.get('trips')!.rows.map(rename))
  return withRows(f, 'stop_times', f.tables.get('stop_times')!.rows.map(rename))
}

/** 便の時刻をずらした新しいフィード(stop_times の到着・出発を seconds 秒ずらす) */
export function shiftTrip(feed: GtfsFeed, tripId: string, seconds: number): GtfsFeed {
  const shift = (t: string | undefined) => {
    const [h, m, s] = (t ?? '').split(':').map(Number)
    const v = h * 3600 + m * 60 + s + seconds
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(Math.floor(v / 3600))}:${p(Math.floor((v % 3600) / 60))}:${p(v % 60)}`
  }
  return withRows(
    feed,
    'stop_times',
    feed.tables.get('stop_times')!.rows.map((r) =>
      r.trip_id === tripId ? { ...r, arrival_time: shift(r.arrival_time), departure_time: shift(r.departure_time) } : r,
    ),
  )
}

/** 道北バスの形を確かめる2つ目の小さなフィード。3つ目の部分が固定の 01 で、平日の service_id と同じ */
export function dohokuShapedFeed(): GtfsFeed {
  return feedOf({
    agency: rowsOf(AGENCY),
    routes: rowsOf(`
route_id,agency_id,route_short_name,route_long_name,route_type
0026,1,26,旭川線,3`),
    stops: rowsOf(STOPS),
    calendar: rowsOf(`
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
01,1,1,1,1,1,0,0,20261001,20261130
03,0,0,0,0,0,1,0,20261001,20261130`),
    trips: rowsOf(`
route_id,service_id,trip_id
0026,01,0026_01_01_01_0705
0026,01,0026_02_01_01_0815
0026,03,0026_01_01_03_0705`),
    stop_times: rowsOf(`
trip_id,arrival_time,departure_time,stop_id,stop_sequence
0026_01_01_01_0705,07:05:00,07:05:00,A,1
0026_01_01_01_0705,07:20:00,07:20:00,B,2
0026_02_01_01_0815,08:15:00,08:15:00,A,1
0026_02_01_01_0815,08:30:00,08:30:00,B,2
0026_01_01_03_0705,07:05:00,07:05:00,A,1
0026_01_01_03_0705,07:20:00,07:20:00,B,2`),
    feed_info: rowsOf(FEED_INFO),
  })
}

/**
 * 組が複数ある形2を確かめる小さなフィード(docs/design-service-groups.md §7.6 の受け入れ条件 3)。京都市営バスの形をまねる。
 *
 * - calendar はすべて 20261001〜20261130。土曜に入れ替えるときの組(multiServices):
 *   - 主の組 01001(月〜金)← 03001(土)。trip_id は {系統}_{頭}_{時刻}(と接尾辞)で、部分の数が 3 と 4 で混ざる(規則 2、位置 1)
 *   - 接尾辞の組 01001_A(月〜金。11/2・11/10 は運休の例外)← 03001_A(土)
 *   - 01001_C(calendar_dates だけ。11/2)← 03001_C(calendar_dates だけ。10/31)
 *   - なくす 01005_MSN(月〜金)
 *   - 入れ替えに使う service が2つの組 WB(月〜金)← SB1(土。規則 1、位置 2)・SB2(土。trip_id に '_' が無く、後ろに付ける)
 *   - 残す 01002_RIT(calendar_dates だけ。11/5・11/6)
 *   - 月〜土の MS(組に入れない)
 * - 停留所は A→B の2つ。署名は系統と時刻で決まる:R1_01001_0700 と R1_03001_0700(07:00)、R1_01001_0800_K と
 *   R1_03001_0800_A(08:00)、R1_01001_0900_A と R1_03001_0900(09:00)が同じ署名
 */
export const MULTI_CALENDAR = `
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
01001,1,1,1,1,1,0,0,20261001,20261130
01001_A,1,1,1,1,1,0,0,20261001,20261130
01005_MSN,1,1,1,1,1,0,0,20261001,20261130
03001,0,0,0,0,0,1,0,20261001,20261130
03001_A,0,0,0,0,0,1,0,20261001,20261130
MS,1,1,1,1,1,1,0,20261001,20261130
SB1,0,0,0,0,0,1,0,20261001,20261130
SB2,0,0,0,0,0,1,0,20261001,20261130
WB,1,1,1,1,1,0,0,20261001,20261130`

export const MULTI_CALENDAR_DATES = `
service_id,date,exception_type
01001_A,20261102,2
01001_A,20261110,2
01001_C,20261102,1
03001_C,20261031,1
01002_RIT,20261105,1
01002_RIT,20261106,1`

/** [route_id, service_id, trip_id, 発車の時刻 HH:MM] */
const MULTI_TRIPS: [string, string, string, string][] = [
  ['R1', '01001', 'R1_01001_0700', '07:00'],
  ['R1', '01001', 'R1_01001_0800_K', '08:00'],
  ['R3', '01001', 'R3_01001_0730', '07:30'],
  ['R1', '01001_A', 'R1_01001_0900_A', '09:00'],
  ['R1', '01001_C', 'R1_01001_1000_C', '10:00'],
  ['R4', '01002_RIT', 'R4_01002_1300_RIT', '13:00'],
  ['R1', '01005_MSN', 'R1_01005_1200_MSN', '12:00'],
  ['R1', '03001', 'R1_03001_0700', '07:00'],
  ['R1', '03001', 'R1_03001_0805_K', '08:05'],
  ['R1', '03001', 'R1_03001_0900', '09:00'],
  ['R1', '03001_A', 'R1_03001_0800_A', '08:00'],
  ['R1', '03001_C', 'R1_03001_1005_C', '10:05'],
  ['R1', 'MS', 'R1_MS_1400', '14:00'],
  ['R2', 'SB1', 'R2_1000_SB1', '10:00'],
  ['R2', 'SB2', 'X1100', '11:00'],
  ['R2', 'WB', 'R2_0900_WB', '09:00'],
]

/** 組が複数ある小さなフィード(呼ぶたびに新しく作る)。trips は (service_id, trip_id) の昇順、stop_times は trips の順 */
export function multiFeed(): GtfsFeed {
  const later = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    const t = h * 60 + m + 10
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00`
  }
  return feedOf({
    agency: rowsOf(AGENCY),
    routes: rowsOf(`${ROUTES}
R4,1,4,大学線,3`),
    stops: rowsOf(STOPS),
    calendar: rowsOf(MULTI_CALENDAR),
    calendar_dates: rowsOf(MULTI_CALENDAR_DATES),
    trips: MULTI_TRIPS.map(([route_id, service_id, trip_id]) => ({ route_id, service_id, trip_id, trip_headsign: '市役所', block_id: '' })),
    stop_times: MULTI_TRIPS.flatMap(([, , trip_id, time]) => [
      { trip_id, arrival_time: `${time}:00`, departure_time: `${time}:00`, stop_id: 'A', stop_sequence: '1', pickup_type: '0', drop_off_type: '1' },
      { trip_id, arrival_time: later(time), departure_time: later(time), stop_id: 'B', stop_sequence: '2', pickup_type: '1', drop_off_type: '0' },
    ]),
    feed_info: rowsOf(FEED_INFO),
  })
}

/** multiFeed を土曜ダイヤに入れ替える計画(組は主の組が先頭、あとは平日の service の昇順) */
export function multiPlan(overrides: Partial<Form2Plan> = {}): Form2Plan {
  return {
    kind: 'weekdayToSaturday',
    weekdayService: '01001',
    replacementService: '03001',
    period: { start: '20261103', end: null },
    excludedRoutes: [],
    pairs: [
      { weekday: '01001', replacements: ['03001'] },
      { weekday: '01001_A', replacements: ['03001_A'] },
      { weekday: '01001_C', replacements: ['03001_C'] },
      { weekday: '01005_MSN', replacements: [] },
      { weekday: 'WB', replacements: ['SB1', 'SB2'] },
    ],
    keptWeekdayServices: ['01002_RIT'],
    addBackTripIds: [],
    ...overrides,
  }
}
