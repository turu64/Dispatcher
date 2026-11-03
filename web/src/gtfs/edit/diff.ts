import { parseGtfsTime } from '../departures'
import type { GtfsFeed, GtfsRow } from '../load'
import { compareStrings, sortByStopSequence, stopTimesByTrip, tripSignature } from './signature'

/**
 * 平日便の前後の差(取り決め 1104 §6)と、足し戻しの集計(§8)。
 * 便どうしは署名(§5.1)で比べ、trip_id では比べない(写した便は、消した基準の便と同じ trip_id を使うことがあるため)。
 */

export interface TripBrief {
  /** どちらのフィードの trip_id か。写した便は、消した基準の便と同じ trip_id を使うことがある(§5.2)ので、id だけで便を指さない */
  feed: 'base' | 'edited'
  tripId: string
  routeId: string
  /** route_short_name、無ければ route_long_name、無ければ route_id */
  routeName: string
  headsign: string
  firstStopName: string
  lastStopName: string
  /** 通る停留所の名前(stop_sequence の順)。停留所名での絞り込みと、Claude が行き先・経由から施設を推定する材料(§8・§10) */
  stopNames: string[]
  /** 'HH:MM'(24時を超える値は '25:10' のまま) */
  firstDeparture: string | null
  lastArrival: string | null
  firstSeconds: number | null
  /** 最後の停留所の到着 − 最初の停留所の出発(どちらかが読めなければ null) */
  durationMin: number | null
  signature: string
}

export interface RouteDiff {
  routeId: string
  routeName: string
  before: number
  after: number
  removed: number
  added: number
  same: number
  excluded: boolean
  /** 平日の始発の出発時刻と、終発の出発時刻('HH:MM'。便が無ければ null) */
  firstDepartureBefore: string | null
  firstDepartureAfter: string | null
  lastDepartureBefore: string | null
  lastDepartureAfter: string | null
  /** 編集後のフィードの、どの service にもこの系統の便が無い(全曜日で便がなくなる) */
  vanishes: boolean
}

/** 公示第47号の時間帯(旭川など:6〜9時台、10〜14時台、15〜19時台、20時台〜翌5時台) */
export interface Notice47BandDiff {
  routeId: string
  routeName: string
  band: string
  before: number
  after: number
}

export interface WeekdayDiff {
  /** 基準の平日便のうち、編集後の平日便に同じ署名の便が無いもの(消える便。feed は 'base') */
  removed: TripBrief[]
  /** 編集後の平日便のうち、基準の平日便に同じ署名の便が無いもの(入る便。feed は 'edited') */
  added: TripBrief[]
  /** 両方にある便(残る便。編集後の側) */
  same: TripBrief[]
  byRoute: RouteDiff[]
  byStartBand: { label: string; before: number; after: number; removed: number; added: number }[]
  /** 系統 × 公示第47号の時間帯の、前後の便数。始発停留所の出発時刻で数える */
  byNotice47Band: Notice47BandDiff[]
  /** 全曜日で便がなくなる系統の数(byRoute の vanishes の数) */
  vanishingRoutes: number
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** 秒を 'HH:MM' にする(24時を超える値はそのまま。'25:10') */
export function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 時刻の列の値を秒にする。空なら代わりの列を使う(到着・出発のどちらかが空の行のため) */
function timeOf(row: GtfsRow | undefined, primary: 'arrival_time' | 'departure_time'): number | null {
  if (!row) return null
  const other = primary === 'arrival_time' ? 'departure_time' : 'arrival_time'
  const value = trimmed(row[primary]) !== '' ? row[primary] : row[other]
  return parseGtfsTime(value)
}

/**
 * フィードの便を TripBrief にする関数を作る。系統名・停留所名・stop_times の索引は1回だけ作って使い回す。
 * 足し戻しの候補や Claude の便の検索(11/5)でも同じ形を使う
 */
export function createTripBriefer(feed: GtfsFeed, side: 'base' | 'edited'): (trip: GtfsRow) => TripBrief {
  const routeNames = new Map<string, string>()
  for (const r of feed.tables.get('routes')?.rows ?? []) {
    const id = trimmed(r.route_id)
    if (routeNames.has(id)) continue
    routeNames.set(id, trimmed(r.route_short_name) || trimmed(r.route_long_name) || id)
  }
  const stopNames = new Map<string, string>()
  for (const s of feed.tables.get('stops')?.rows ?? []) {
    const id = trimmed(s.stop_id)
    if (!stopNames.has(id)) stopNames.set(id, s.stop_name ?? '')
  }
  const groups = stopTimesByTrip(feed.tables.get('stop_times')?.rows ?? [])

  return (trip) => {
    const tripId = trimmed(trip.trip_id)
    const routeId = trimmed(trip.route_id)
    const rows = groups.get(tripId) ?? []
    const ordered = sortByStopSequence(rows)
    const names = ordered.map((r) => stopNames.get(trimmed(r.stop_id)) ?? trimmed(r.stop_id))
    const first = timeOf(ordered[0], 'departure_time')
    const last = timeOf(ordered[ordered.length - 1], 'arrival_time')
    return {
      feed: side,
      tripId,
      routeId,
      routeName: routeNames.get(routeId) ?? routeId,
      headsign: trip.trip_headsign ?? '',
      firstStopName: names[0] ?? '',
      lastStopName: names[names.length - 1] ?? '',
      stopNames: names,
      firstDeparture: first === null ? null : formatClock(first),
      lastArrival: last === null ? null : formatClock(last),
      firstSeconds: first,
      durationMin: first === null || last === null ? null : Math.round((last - first) / 60),
      signature: tripSignature(routeId, rows),
    }
  }
}

/** 始発の時刻順(時刻の無い便は後ろ)、同じなら系統、trip_id の順 */
function compareBriefs(a: TripBrief, b: TripBrief): number {
  if (a.firstSeconds !== b.firstSeconds) {
    if (a.firstSeconds === null) return 1
    if (b.firstSeconds === null) return -1
    return a.firstSeconds - b.firstSeconds
  }
  return compareStrings(a.routeId, b.routeId) || compareStrings(a.tripId, b.tripId)
}

const START_BANDS: { label: string; from: number; to: number }[] = [
  { label: '6時より前', from: -Infinity, to: 6 },
  { label: '6〜9時', from: 6, to: 9 },
  { label: '9〜12時', from: 9, to: 12 },
  { label: '12〜15時', from: 12, to: 15 },
  { label: '15〜18時', from: 15, to: 18 },
  { label: '18〜21時', from: 18, to: 21 },
  { label: '21〜24時', from: 21, to: 24 },
  { label: '24時以降', from: 24, to: Infinity },
]
const NO_TIME = '時刻なし'

function startBandOf(seconds: number | null): string {
  if (seconds === null) return NO_TIME
  const hours = seconds / 3600
  return START_BANDS.find((b) => hours >= b.from && hours < b.to)?.label ?? NO_TIME
}

export const NOTICE47_BANDS = ['6〜9時台', '10〜14時台', '15〜19時台', '20時台〜翌5時台'] as const

/** 公示第47号の時間帯。始発停留所の出発時刻の「時」で分ける(24時以降は 20時台〜翌5時台) */
export function notice47BandOf(seconds: number | null): (typeof NOTICE47_BANDS)[number] | null {
  if (seconds === null) return null
  const h = Math.floor(seconds / 3600)
  if (h >= 6 && h <= 9) return NOTICE47_BANDS[0]
  if (h >= 10 && h <= 14) return NOTICE47_BANDS[1]
  if (h >= 15 && h <= 19) return NOTICE47_BANDS[2]
  return NOTICE47_BANDS[3]
}

function minMaxClock(briefs: readonly TripBrief[]): { first: string | null; last: string | null } {
  const times = briefs.map((b) => b.firstSeconds).filter((t): t is number => t !== null)
  if (times.length === 0) return { first: null, last: null }
  return { first: formatClock(Math.min(...times)), last: formatClock(Math.max(...times)) }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k)
    if (list) list.push(item)
    else map.set(k, [item])
  }
  return map
}

/**
 * 基準と編集後の平日便を、署名の多重集合で突き合わせる。同じ署名が複数あれば trip_id の昇順に先頭から組にし、
 * 余りが消える便・入る便になる。平日の service だけを比べる(vanishes だけは編集後の全便で見る)。
 * excludedRoutes は RouteDiff.excluded に使う(方針で入れ替えから外した系統。フィードからは推定しない)
 */
export function diffWeekdayTrips(
  base: GtfsFeed,
  edited: GtfsFeed,
  weekdayService: string,
  excludedRoutes: readonly string[] = [],
): WeekdayDiff {
  const wk = weekdayService.trim()
  const briefBase = createTripBriefer(base, 'base')
  const briefEdited = createTripBriefer(edited, 'edited')
  const before = (base.tables.get('trips')?.rows ?? []).filter((t) => trimmed(t.service_id) === wk).map(briefBase)
  const editedTrips = edited.tables.get('trips')?.rows ?? []
  const after = editedTrips.filter((t) => trimmed(t.service_id) === wk).map(briefEdited)

  const byTripId = (a: TripBrief, b: TripBrief) => compareStrings(a.tripId, b.tripId)
  const beforeBySig = groupBy(before, (b) => b.signature)
  const afterBySig = groupBy(after, (b) => b.signature)
  const removed: TripBrief[] = []
  const added: TripBrief[] = []
  const same: TripBrief[] = []
  for (const sig of new Set([...beforeBySig.keys(), ...afterBySig.keys()])) {
    const b = [...(beforeBySig.get(sig) ?? [])].sort(byTripId)
    const a = [...(afterBySig.get(sig) ?? [])].sort(byTripId)
    const k = Math.min(a.length, b.length)
    same.push(...a.slice(0, k))
    removed.push(...b.slice(k))
    added.push(...a.slice(k))
  }
  removed.sort(compareBriefs)
  added.sort(compareBriefs)
  same.sort(compareBriefs)

  // 系統ごと
  const excluded = new Set(excludedRoutes.map((r) => r.trim()))
  const editedRoutes = new Set(editedTrips.map((t) => trimmed(t.route_id)))
  const beforeByRoute = groupBy(before, (b) => b.routeId)
  const afterByRoute = groupBy(after, (b) => b.routeId)
  const count = (list: readonly TripBrief[], routeId: string) => list.filter((b) => b.routeId === routeId).length
  const routeIds = [...new Set([...beforeByRoute.keys(), ...afterByRoute.keys()])].sort(compareStrings)
  const byRoute: RouteDiff[] = routeIds.map((routeId) => {
    const b = beforeByRoute.get(routeId) ?? []
    const a = afterByRoute.get(routeId) ?? []
    const mb = minMaxClock(b)
    const ma = minMaxClock(a)
    return {
      routeId,
      routeName: (b[0] ?? a[0]).routeName,
      before: b.length,
      after: a.length,
      removed: count(removed, routeId),
      added: count(added, routeId),
      same: count(same, routeId),
      excluded: excluded.has(routeId),
      firstDepartureBefore: mb.first,
      firstDepartureAfter: ma.first,
      lastDepartureBefore: mb.last,
      lastDepartureAfter: ma.last,
      vanishes: !editedRoutes.has(routeId),
    }
  })

  // 始発の時間帯ごと
  const labels = [...START_BANDS.map((b) => b.label), NO_TIME]
  const tally = (list: readonly TripBrief[]) => {
    const counts = new Map<string, number>()
    for (const b of list) {
      const label = startBandOf(b.firstSeconds)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return counts
  }
  const tBefore = tally(before)
  const tAfter = tally(after)
  const tRemoved = tally(removed)
  const tAdded = tally(added)
  const byStartBand = labels.map((label) => ({
    label,
    before: tBefore.get(label) ?? 0,
    after: tAfter.get(label) ?? 0,
    removed: tRemoved.get(label) ?? 0,
    added: tAdded.get(label) ?? 0,
  }))

  // 系統 × 公示第47号の時間帯
  const byNotice47Band: Notice47BandDiff[] = []
  for (const route of byRoute) {
    const b = beforeByRoute.get(route.routeId) ?? []
    const a = afterByRoute.get(route.routeId) ?? []
    for (const band of NOTICE47_BANDS) {
      byNotice47Band.push({
        routeId: route.routeId,
        routeName: route.routeName,
        band,
        before: b.filter((x) => notice47BandOf(x.firstSeconds) === band).length,
        after: a.filter((x) => notice47BandOf(x.firstSeconds) === band).length,
      })
    }
  }

  return {
    removed,
    added,
    same,
    byRoute,
    byStartBand,
    byNotice47Band,
    vanishingRoutes: byRoute.filter((r) => r.vanishes).length,
  }
}

// ---- §8 足し戻しの集計 ----

export interface RestoreTotals {
  /** 受け付けた便(accepted)の数 */
  trips: number
  /** 営業運行時間の合計。各便の(最後の停留所の到着 − 最初の停留所の出発)の合計。到着・出発が空なら、もう一方の時刻を使う */
  serviceMinutes: number
  /** 時刻が読めず合計に入れなかった便の数 */
  unknownDuration: number
  /** 'HH:MM' */
  earliestStart: string | null
  latestEnd: string | null
}

/** 足し戻した便(基準の trip_id)の営業運行時間などを合計する */
export function restoreTotals(base: GtfsFeed, accepted: readonly string[]): RestoreTotals {
  const ids = new Set(accepted.map((t) => t.trim()))
  const groups = stopTimesByTrip(base.tables.get('stop_times')?.rows ?? [])
  const found = new Set<string>()
  let seconds = 0
  let unknownDuration = 0
  let earliest: number | null = null
  let latest: number | null = null
  for (const trip of base.tables.get('trips')?.rows ?? []) {
    const id = trimmed(trip.trip_id)
    if (!ids.has(id) || found.has(id)) continue
    found.add(id)
    const ordered = sortByStopSequence(groups.get(id) ?? [])
    const first = timeOf(ordered[0], 'departure_time')
    const last = timeOf(ordered[ordered.length - 1], 'arrival_time')
    if (first !== null && (earliest === null || first < earliest)) earliest = first
    if (last !== null && (latest === null || last > latest)) latest = last
    if (first === null || last === null) unknownDuration++
    else seconds += last - first
  }
  return {
    trips: found.size,
    serviceMinutes: Math.round(seconds / 60),
    unknownDuration,
    earliestStart: earliest === null ? null : formatClock(earliest),
    latestEnd: latest === null ? null : formatClock(latest),
  }
}
