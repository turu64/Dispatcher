import { servicesFor } from '../calendar'
import { departureCountsByBand, makeBands } from '../departures'
import type { GtfsFeed } from '../load'
import { toStops } from '../parse'
import { buildReachStops, originStops } from '../../reach/input'
import { cellsWithinRadius, meshCenter, meshCode, parentCode, type LatLon } from '../../reach/mesh'
import { computeReach, type ReachParams, type RefData } from '../../reach/reach'
import { feedOf, rowsOf } from './form2.fixture'
import { applyForm2 } from './form2'
import type { Form2Plan } from './ops'
import type { RestoreHintContext } from './restore'

/**
 * 足し戻しの手がかり(到達圏を使う2つ。docs/interfaces-1105.md §7)のテストで使う、手で作る小さなフィードと到達圏。
 * テストのファイルではない(restore.test.ts と store/restoreHintContext.test.ts から読み込む)。
 *
 * 停留所は 8分の1地域メッシュのセルの中心に置く(緯度 43.75度・経度 142.40度のセルから、行(北へ)と列(東へ)の数で表す)。
 * セルの1辺は南北 約 115.8m、東西 約 125.9m。
 * - P (0,0)、Q (3,0):Q は P の北 約 347m。2つの徒歩圏は (1,0) と (2,0) の2セルだけ重なる
 * - 駅 S (-3,0):P の南 約 347m。P の徒歩圏のうち (-1,0) と (-2,0) の2セルは駅の徒歩圏にも入る
 * - D (0,20)、E (0,40)、F (0,60)、G (0,80)、Z (0,100):東へ 約 2.5km ずつ離す(徒歩圏は重ならない)
 *
 * 到達圏の条件は、手で数えられるように距離を短くする:中山間・地方はバス停・駅とも 3分(240m)。
 * 推計人口は、どの 250m セルも 40 人(8分の1地域メッシュのセルは 10 人。人口密度は 約 690人/km² で、すべて中山間・地方)。
 * 停留所から 240m 以内に中心があるセルは 11(同じ列の上下 2つずつ、左右 1つずつ、斜め 4つ)。
 *
 * service:WK(月〜金)、SA(土)。calendar はすべて 20261001〜20261130。20261103 は WK が運休(calendar_dates)。
 * 平日を土曜ダイヤにすると、平日の便はすべて消え、SA の2便の写しになる。
 * - A_0700_WK:P 07:00 → Z(終点)
 * - B_0855_WK:P 08:55 → Q 09:05 → Z。6〜9時の P と、9〜12時の Q の2つで外れたセルを戻す
 * - C_0720_WK:F 07:20 → D 07:30(降車だけ。pickup_type=1)→ E 07:40(最後の行。pickup_type は 0)
 * - D_0745_WK:D 07:45 → Z、E_0750_WK:E 07:50 → Z
 * - F_0715_SA:F 07:15 → Z、G_1000_SA:G 10:00 → Z(写すと、編集後の平日に F の 6〜9時、G の 9〜12時の出発が残る)
 * Z はどの便でも最後の停留所なので、起点にならない。
 */

/** 緯度 43.75度の 8分の1地域メッシュの行(緯度 × 960) */
const ROW0 = 42000
/** 経度 142.40度の 8分の1地域メッシュの列((経度 − 100) × 640) */
const COL0 = 27136

/** 基準のセルから dr 行北・dc 列東のセルのコード */
export function cellAt(dr: number, dc: number): string {
  return meshCode((ROW0 + dr + 0.5) / 960, 100 + (COL0 + dc + 0.5) / 640, 11)
}

/** 基準のセルから dr 行北・dc 列東のセルの中心 */
export function centerAt(dr: number, dc: number): LatLon {
  return meshCenter(cellAt(dr, dc))
}

export const STOP_CELLS: Record<string, [number, number]> = {
  P: [0, 0],
  Q: [3, 0],
  D: [0, 20],
  E: [0, 40],
  F: [0, 60],
  G: [0, 80],
  Z: [0, 100],
}
export const STATION_CELL: [number, number] = [-3, 0]

export const REACH_PARAMS: ReachParams = {
  densityThreshold: 1000,
  speedMPerMin: 80,
  walkMinutes: {
    urban: { bus: 1, rail: 2 },
    suburban: { bus: 2, rail: 3 },
    rural: { bus: 3, rail: 3 },
  },
}

/** 比較の日付(水曜日) */
export const DATE = '20261104'

export function reachBaseFeed(): GtfsFeed {
  const stops = Object.entries(STOP_CELLS)
    .map(([id, [dr, dc]]) => {
      const c = centerAt(dr, dc)
      return `${id},停留所${id},${c.lat},${c.lon}`
    })
    .join('\n')
  return feedOf({
    agency: rowsOf(`
agency_id,agency_name,agency_url,agency_timezone,agency_lang
1,テストバス,https://example.jp/,Asia/Tokyo,ja`),
    routes: rowsOf(`
route_id,agency_id,route_short_name,route_long_name,route_type
R1,1,1,駅前線,3
R2,1,2,病院線,3`),
    stops: rowsOf(`stop_id,stop_name,stop_lat,stop_lon\n${stops}`),
    calendar: rowsOf(`
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
SA,0,0,0,0,0,1,0,20261001,20261130
WK,1,1,1,1,1,0,0,20261001,20261130`),
    calendar_dates: rowsOf(`
service_id,date,exception_type
WK,20261103,2`),
    trips: rowsOf(`
route_id,service_id,trip_id
R2,SA,F_0715_SA
R1,SA,G_1000_SA
R1,WK,A_0700_WK
R1,WK,B_0855_WK
R2,WK,C_0720_WK
R2,WK,D_0745_WK
R2,WK,E_0750_WK`),
    stop_times: rowsOf(`
trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type
F_0715_SA,07:15:00,07:15:00,F,1,0,1
F_0715_SA,08:00:00,08:00:00,Z,2,1,0
G_1000_SA,10:00:00,10:00:00,G,1,0,1
G_1000_SA,10:30:00,10:30:00,Z,2,1,0
A_0700_WK,07:00:00,07:00:00,P,1,0,1
A_0700_WK,07:30:00,07:30:00,Z,2,1,0
B_0855_WK,08:55:00,08:55:00,P,1,0,1
B_0855_WK,09:05:00,09:05:00,Q,2,0,0
B_0855_WK,09:40:00,09:40:00,Z,3,1,0
C_0720_WK,07:20:00,07:20:00,F,1,0,1
C_0720_WK,07:30:00,07:30:00,D,2,1,0
C_0720_WK,07:40:00,07:40:00,E,3,0,0
D_0745_WK,07:45:00,07:45:00,D,1,0,1
D_0745_WK,08:30:00,08:30:00,Z,2,1,0
E_0750_WK,07:50:00,07:50:00,E,1,0,1
E_0750_WK,08:30:00,08:30:00,Z,2,1,0`),
    feed_info: rowsOf(`
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version
テストバス,https://example.jp/,ja,20261001,20261130,202609171038`),
  })
}

/** 平日を土曜ダイヤに、20261101 から当面の間。除外・足し戻しなし */
export function reachPlan(): Form2Plan {
  return {
    kind: 'weekdayToSaturday',
    weekdayService: 'WK',
    replacementService: 'SA',
    period: { start: '20261101', end: null },
    excludedRoutes: [],
    addBackTripIds: [],
  }
}

/** 参照データ:停留所と駅のまわりの 250m セルをすべて 40 人にし、駅を1つ置く。DID は無い */
export function reachRef(): RefData {
  const points = [...Object.values(STOP_CELLS), STATION_CELL].map(([dr, dc]) => centerAt(dr, dc))
  const pop250 = new Map<string, number>()
  for (const cell of cellsWithinRadius(points, 600)) pop250.set(parentCode(cell, 10), 40)
  return { pop250, did125: new Set(), stations: [centerAt(...STATION_CELL)] }
}

/** 基準・編集後・到達圏の比較の ctx(画面の到達圏の store と同じ手順で、Web Worker を使わずに計算する) */
export function reachSetup() {
  const base = reachBaseFeed()
  const plan = reachPlan()
  const outcome = applyForm2(base, plan, { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  const edited = outcome.result.feed
  const ref = reachRef()
  const origins = originStops(base, toStops(base).stops)
  const bands = makeBands(3)
  const before = departureCountsByBand(base, servicesFor(base, DATE), bands)
  const after = departureCountsByBand(edited, servicesFor(edited, DATE), bands)
  const resultOf = (counts: Map<string, number[]>) =>
    computeReach({
      stops: buildReachStops(origins.stops, counts, bands.length),
      ref,
      fallbackClass: 'suburban',
      params: REACH_PARAMS,
      bandCount: bands.length,
    })
  const ctx: RestoreHintContext = {
    before,
    after,
    bands,
    beforeResult: resultOf(before.counts),
    afterResult: resultOf(after.counts),
    date: DATE,
    params: REACH_PARAMS,
    stops: origins.stops,
  }
  return { base, plan, edited, ref, origins, ctx }
}
