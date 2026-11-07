/**
 * service ごとの判断材料(docs/design-service-groups.md §2.1・§2.2)。ブラウザで計算し、Jev に送る State の材料にもする。
 *
 * - 期間は入力の有効期間(feedValidity)。運行日は indexFeedServiceDays・runsOn で数える(calendar_dates の削除を優先)
 * - 日の区分:日曜か祝日一覧にある日 → 日祝、土曜 → 土曜、それ以外 → 平日。祝日一覧が null なら日曜だけを日祝にする
 * - 対象は trips.txt に便が1本以上ある service だけ
 */
import { compareStrings } from '../edit/signature'
import { feedValidity, forEachDay, indexFeedServiceDays, runsOn } from '../edit/services'
import type { HolidayList } from '../holidays'
import type { GtfsFeed, GtfsRow } from '../load'
import { DAY_KEYS, type Basis, type DayCounts, type DayKey, type FeedFeatures, type Level, type ServiceFeatures } from './types'

/** しきい値(§2.2・§6.1)。網羅率は 0〜1 */
export const LEVEL_THRESHOLDS = {
  /** この値以上が regular */
  regular: 0.7,
  /** この値以上が partial */
  partial: 0.15,
  /** しきい値からこの幅の中を「境目に近い」とする */
  near: 0.05,
} as const

/** runningDates を持つ運行日の上限 */
const RUNNING_DATES_MAX = 10
const HEADSIGNS_MAX = 5

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

function rowsOf(feed: GtfsFeed, name: string): GtfsRow[] {
  return feed.tables.get(name)?.rows ?? []
}

/** 'H:MM:SS'(時は 1 桁以上)を秒にする。読めなければ null */
function parseSeconds(v: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(v)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** 秒を 'HH:MM' にする(24 時を超えてもそのまま) */
function formatHhMm(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function splitServiceName(serviceId: string): { head: string; suffix: string } {
  const i = serviceId.indexOf('_')
  return i < 0 ? { head: serviceId, suffix: '' } : { head: serviceId.slice(0, i), suffix: serviceId.slice(i + 1) }
}

/** 運行日 n 日 ÷ 区分の日数 d の水準。比べるのは整数で(n*100 と しきい値*100*d) */
export function levelOf(n: number, d: number): Level {
  if (n <= 0 || d <= 0) return 'none'
  if (n * 100 >= Math.round(LEVEL_THRESHOLDS.regular * 100) * d) return 'regular'
  if (n * 100 >= Math.round(LEVEL_THRESHOLDS.partial * 100) * d) return 'partial'
  return 'rare'
}

/** 水準から basis と runs を決める(§2.2 の 1〜4) */
export function basisOf(levels: Record<DayKey, Level>, runningDays: DayCounts): { basis: Basis; runs: Record<DayKey, boolean> } {
  const pick = (f: (k: DayKey) => boolean) =>
    Object.fromEntries(DAY_KEYS.map((k) => [k, f(k)])) as Record<DayKey, boolean>
  if (DAY_KEYS.some((k) => levels[k] === 'regular')) return { basis: 'regular', runs: pick((k) => levels[k] === 'regular') }
  if (DAY_KEYS.some((k) => levels[k] === 'partial')) return { basis: 'partial', runs: pick((k) => levels[k] === 'partial') }
  if (DAY_KEYS.some((k) => runningDays[k] > 0)) return { basis: 'special', runs: pick((k) => runningDays[k] > 0) }
  return { basis: 'noDays', runs: pick(() => false) }
}

function nearThresholdOf(coverage: DayCounts): DayKey[] {
  const { regular, partial, near } = LEVEL_THRESHOLDS
  // 浮動小数の誤差で境目の 0.05 ちょうどを落とさないよう、わずかに広げる
  const eps = 1e-9
  return DAY_KEYS.filter((k) => {
    const c = coverage[k]
    return c > 0 && (Math.abs(c - regular) <= near + eps || Math.abs(c - partial) <= near + eps)
  })
}

function dayKeyOf(date: string, weekday: number, holidays: HolidayList | null): DayKey {
  if (weekday === 6 || (holidays !== null && holidays.names.has(date))) return 'sundayHoliday'
  if (weekday === 5) return 'saturday'
  return 'weekday'
}

function zeroCounts(): DayCounts {
  return { weekday: 0, saturday: 0, sundayHoliday: 0 }
}

function topByCount<T extends string>(counts: Map<T, number>, limit: number): T[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .slice(0, limit)
    .map(([k]) => k)
}

function agencyOf(feed: GtfsFeed): string | null {
  const names: string[] = []
  for (const row of rowsOf(feed, 'agency')) {
    const name = trimmed(row.agency_name)
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names.length > 0 ? names.join('、') : null
}

function routeNames(feed: GtfsFeed): Map<string, string> {
  const names = new Map<string, string>()
  for (const row of rowsOf(feed, 'routes')) {
    const id = trimmed(row.route_id)
    if (id === '' || names.has(id)) continue
    const short = trimmed(row.route_short_name)
    const long = trimmed(row.route_long_name)
    names.set(id, short !== '' ? short : long !== '' ? long : id)
  }
  return names
}

interface Acc {
  tripCount: number
  routes: Map<string, number>
  headsigns: Map<string, number>
  first: number | null
  last: number | null
}

/**
 * service ごとの判断材料。stop_times は1回だけなめる(京都市営バスの 50 万行でも数十 ms)。
 * 有効期間を決められない GTFS では、運行日はすべて 0(basis は noDays)になる
 */
export function computeServiceFeatures(feed: GtfsFeed, holidays: HolidayList | null): FeedFeatures {
  const accs = new Map<string, Acc>()
  const tripService = new Map<string, Acc>()
  for (const t of rowsOf(feed, 'trips')) {
    const sid = trimmed(t.service_id)
    if (sid === '') continue
    let acc = accs.get(sid)
    if (!acc) accs.set(sid, (acc = { tripCount: 0, routes: new Map(), headsigns: new Map(), first: null, last: null }))
    acc.tripCount++
    const rid = trimmed(t.route_id)
    if (rid !== '') acc.routes.set(rid, (acc.routes.get(rid) ?? 0) + 1)
    const hs = trimmed(t.trip_headsign)
    if (hs !== '') acc.headsigns.set(hs, (acc.headsigns.get(hs) ?? 0) + 1)
    const tid = trimmed(t.trip_id)
    // 同じ trip_id が2回あれば最初の便に数える(検証は別の段で行う)
    if (tid !== '' && !tripService.has(tid)) tripService.set(tid, acc)
  }

  for (const st of rowsOf(feed, 'stop_times')) {
    const acc = tripService.get(trimmed(st.trip_id))
    if (!acc) continue
    const dep = parseSeconds(trimmed(st.departure_time)) ?? parseSeconds(trimmed(st.arrival_time))
    const arr = parseSeconds(trimmed(st.arrival_time)) ?? parseSeconds(trimmed(st.departure_time))
    if (dep !== null && (acc.first === null || dep < acc.first)) acc.first = dep
    if (arr !== null && (acc.last === null || arr > acc.last)) acc.last = arr
  }

  const validity = feedValidity(feed)
  const daysInPeriod = zeroCounts()
  const ids = [...accs.keys()].sort(compareStrings)
  const index = indexFeedServiceDays(feed)
  const counts = new Map<string, DayCounts>(ids.map((id) => [id, zeroCounts()]))
  const dates = new Map<string, string[]>(ids.map((id) => [id, []]))
  if (validity !== null && validity.start <= validity.end) {
    const sds = ids.map((id) => [id, index.get(id)] as const).filter(([, sd]) => sd !== undefined)
    forEachDay(validity.start, validity.end, (date, weekday) => {
      const key = dayKeyOf(date, weekday, holidays)
      daysInPeriod[key]++
      for (const [id, sd] of sds) {
        if (!runsOn(sd, date, weekday)) continue
        counts.get(id)![key]++
        dates.get(id)!.push(date)
      }
    })
  }

  const routeName = routeNames(feed)
  const routeLabel = (id: string) => routeName.get(id) ?? id
  const services: ServiceFeatures[] = ids.map((serviceId) => {
    const acc = accs.get(serviceId)!
    const c = counts.get(serviceId)!
    const total = c.weekday + c.saturday + c.sundayHoliday
    const coverage: DayCounts = {
      weekday: daysInPeriod.weekday > 0 ? c.weekday / daysInPeriod.weekday : 0,
      saturday: daysInPeriod.saturday > 0 ? c.saturday / daysInPeriod.saturday : 0,
      sundayHoliday: daysInPeriod.sundayHoliday > 0 ? c.sundayHoliday / daysInPeriod.sundayHoliday : 0,
    }
    const levels = Object.fromEntries(DAY_KEYS.map((k) => [k, levelOf(c[k], daysInPeriod[k])])) as Record<DayKey, Level>
    const { basis, runs } = basisOf(levels, c)
    const routes = [...acc.routes.entries()]
      .map(([routeId, trips]) => ({ routeId, name: routeLabel(routeId), trips }))
      .sort((a, b) => b.trips - a.trips || compareStrings(a.routeId, b.routeId))
    return {
      serviceId,
      name: splitServiceName(serviceId),
      tripCount: acc.tripCount,
      routeCount: acc.routes.size,
      routes,
      routeIds: [...acc.routes.keys()].sort(compareStrings),
      headsigns: topByCount(acc.headsigns, HEADSIGNS_MAX),
      firstDeparture: acc.first === null ? null : formatHhMm(acc.first),
      lastArrival: acc.last === null ? null : formatHhMm(acc.last),
      runningDays: { ...c, total },
      coverage,
      levels,
      basis,
      runs,
      runningDates: total <= RUNNING_DATES_MAX ? dates.get(serviceId)! : null,
      nearThreshold: nearThresholdOf(coverage),
    }
  })

  return {
    agency: agencyOf(feed),
    validity: validity ?? { start: '', end: '' },
    daysInPeriod,
    holidays: holidays === null ? 'missing' : 'loaded',
    services,
  }
}

/** 系統の重なり:|A ∩ B| ÷ |A|(A の系統が無ければ 0)。判断材料の文と Jev の候補の並びにだけ使う */
export function routeOverlap(a: ServiceFeatures, b: ServiceFeatures): number {
  if (a.routeIds.length === 0) return 0
  const set = new Set(b.routeIds)
  return a.routeIds.filter((r) => set.has(r)).length / a.routeIds.length
}
