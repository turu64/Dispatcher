import type { DepartureCounts, TimeBand } from '../departures'
import type { GtfsFeed } from '../load'
import type { ReachResult } from '../../reach/reach'
import { createTripBriefer, notice47BandOf, type TripBrief } from './diff'
import type { Form2Plan } from './ops'

/**
 * 足し戻しの手がかり(docs/interfaces-1104.md §8)。コードが出し、画面の並べ替え・絞り込みと、Claude の提案(11/5)の材料にする。
 * 11/4 は、基準と編集後の便の表だけで決まる手がかり(weekdayOnlyRoute〜evening)を出す。到達圏を使う
 * onlyServiceAtStop・restoresLostCells は 11/5(ctx を受け取る形だけ置き、今は判定しない)。
 * 時間帯はすべて開始を含み終わりを含まない。
 */

export type RestoreHint =
  /** その系統に、基準の写す元の service の便が1本も無い(平日だけの系統) */
  | 'weekdayOnlyRoute'
  /** その系統が編集後に全曜日で便がなくなる(§6 の vanishes)。足し戻せば系統が残る */
  | 'routeWouldVanish'
  /** 基準の平日で、その系統の始発の便 */
  | 'firstTripOfRoute'
  /** 基準の平日で、その系統の終発の便(足し戻さないと終発が早まる) */
  | 'lastTripOfRoute'
  /** その系統のその公示第47号の時間帯で、この便を足し戻さないと編集後の便が 0 */
  | 'onlyTripInBand'
  /** 始発が [6:00, 9:00)(通勤・通学) */
  | 'morning'
  /** 始発が [15:00, 19:00)(帰宅) */
  | 'evening'
  /** その便の乗れる停留所のどれかで、比較の日付・その時間帯に、編集後の出発が 0 になる(11/5) */
  | 'onlyServiceAtStop'
  /** その便の乗れる停留所が、その時間帯に「減便で外れた」セルを、区分のバス停の距離の中に含む(11/5) */
  | 'restoresLostCells'

export interface RestoreHintDetail {
  hints: RestoreHint[]
  /** restoresLostCells のとき、戻るセル数と推計人口(11/5)。ほかは null */
  lostCells: { cells: number; population: number } | null
}

/** 到達圏を使う手がかり(11/5)のときだけ渡す */
export interface RestoreHintContext {
  before: DepartureCounts
  after: DepartureCounts
  bands: TimeBand[]
  beforeResult: ReachResult
  afterResult: ReachResult
}

/** 画面に出す手がかりの名前(並びは RestoreHint の順) */
export const RESTORE_HINT_LABELS: Record<RestoreHint, string> = {
  weekdayOnlyRoute: '平日だけの系統',
  routeWouldVanish: '系統が全曜日でなくなる',
  firstTripOfRoute: '系統の始発',
  lastTripOfRoute: '系統の終発',
  onlyTripInBand: '時間帯で唯一の便',
  morning: '朝(6〜9時)',
  evening: '夕方(15〜19時)',
  onlyServiceAtStop: '停留所で唯一の便',
  restoresLostCells: '外れた場所が戻る',
}

const HINT_ORDER: RestoreHint[] = [
  'weekdayOnlyRoute',
  'routeWouldVanish',
  'firstTripOfRoute',
  'lastTripOfRoute',
  'onlyTripInBand',
  'morning',
  'evening',
  'onlyServiceAtStop',
  'restoresLostCells',
]

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** 系統(route_id)ごとの、ある service の便の始発時刻(秒)の一覧 */
function firstSecondsByRoute(trips: readonly TripBrief[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const t of trips) {
    if (t.firstSeconds === null) continue
    const list = out.get(t.routeId)
    if (list) list.push(t.firstSeconds)
    else out.set(t.routeId, [t.firstSeconds])
  }
  return out
}

/**
 * 手がかりを判定する関数を作る。基準と編集後の索引は1回だけ作り、候補の便ごとに使い回す。
 * baseWeekday は基準の平日便、editedWeekday は編集後の平日便。手がかりに使うのは系統と始発の時刻だけなので、
 * diffWeekdayTrips の結果から作れる(基準の平日 = removed + same、編集後の平日 = same + added。same は署名が同じなので
 * 系統と時刻は基準の便と等しい)。
 */
export function createRestoreHinter(
  base: GtfsFeed,
  edited: GtfsFeed,
  plan: Form2Plan,
  baseWeekday: readonly TripBrief[],
  editedWeekday: readonly TripBrief[],
): (trip: TripBrief, ctx?: RestoreHintContext) => RestoreHintDetail {
  const replacement = plan.replacementService.trim()
  const replacementRoutes = new Set<string>()
  for (const t of base.tables.get('trips')?.rows ?? []) {
    if (trimmed(t.service_id) === replacement) replacementRoutes.add(trimmed(t.route_id))
  }
  const editedRoutes = new Set<string>()
  for (const t of edited.tables.get('trips')?.rows ?? []) editedRoutes.add(trimmed(t.route_id))

  const baseTimes = firstSecondsByRoute(baseWeekday)
  // 編集後の平日便の、系統 × 公示第47号の時間帯の便数
  const editedBands = new Map<string, number>()
  for (const t of editedWeekday) {
    const band = notice47BandOf(t.firstSeconds)
    if (band === null) continue
    const key = `${t.routeId}\t${band}`
    editedBands.set(key, (editedBands.get(key) ?? 0) + 1)
  }

  return (trip) => {
    const hints = new Set<RestoreHint>()
    if (!replacementRoutes.has(trip.routeId)) hints.add('weekdayOnlyRoute')
    if (!editedRoutes.has(trip.routeId)) hints.add('routeWouldVanish')
    const times = baseTimes.get(trip.routeId)
    if (trip.firstSeconds !== null && times && times.length > 0) {
      if (trip.firstSeconds === Math.min(...times)) hints.add('firstTripOfRoute')
      if (trip.firstSeconds === Math.max(...times)) hints.add('lastTripOfRoute')
    }
    const band = notice47BandOf(trip.firstSeconds)
    if (band !== null && (editedBands.get(`${trip.routeId}\t${band}`) ?? 0) === 0) hints.add('onlyTripInBand')
    if (trip.firstSeconds !== null) {
      const h = trip.firstSeconds / 3600
      if (h >= 6 && h < 9) hints.add('morning')
      if (h >= 15 && h < 19) hints.add('evening')
    }
    return { hints: HINT_ORDER.filter((h) => hints.has(h)), lostCells: null }
  }
}

/**
 * 1つの便の手がかり。多くの便を調べるときは createRestoreHinter で索引を1回だけ作る
 * (画面は diffWeekdayTrips の結果から、基準の平日 = removed + same、編集後の平日 = same + added を渡す)。
 */
export function restoreHints(
  base: GtfsFeed,
  edited: GtfsFeed,
  plan: Form2Plan,
  trip: TripBrief,
  ctx?: RestoreHintContext,
): RestoreHintDetail {
  const wk = plan.weekdayService.trim()
  const weekdayOf = (feed: GtfsFeed, side: 'base' | 'edited') => {
    const brief = createTripBriefer(feed, side)
    return (feed.tables.get('trips')?.rows ?? []).filter((t) => trimmed(t.service_id) === wk).map(brief)
  }
  return createRestoreHinter(base, edited, plan, weekdayOf(base, 'base'), weekdayOf(edited, 'edited'))(trip, ctx)
}

/** 候補の並びの既定:手がかりの多い順、同じなら始発時刻の順(時刻の無い便は後ろ)、同じなら trip_id の順 */
export function compareByHints(
  a: { trip: TripBrief; detail: RestoreHintDetail },
  b: { trip: TripBrief; detail: RestoreHintDetail },
): number {
  if (a.detail.hints.length !== b.detail.hints.length) return b.detail.hints.length - a.detail.hints.length
  const ta = a.trip.firstSeconds
  const tb = b.trip.firstSeconds
  if (ta !== tb) {
    if (ta === null) return 1
    if (tb === null) return -1
    return ta - tb
  }
  return a.trip.tripId < b.trip.tripId ? -1 : a.trip.tripId > b.trip.tripId ? 1 : 0
}
