import { parseGtfsTime } from '../departures'
import type { GtfsFeed, GtfsRow } from '../load'
import { formatClock } from './diff'
import { compareStrings, sortByStopSequence, stopTimesByTrip } from './signature'

/**
 * その日の営業運行時間の総量と、減便の前後の削減量(指摘 18.1)。要る運転士の数の推定(duties.ts)が使う、
 * 便を時刻順に並べた区間もここで作る。
 *
 * 数え方は平日に戻した便の集計(diff.ts の restoreTotals)と同じ:各便の(最後の停留所の到着 − 最初の停留所の出発)を足す。
 * 到着・出発が空なら、もう一方の時刻を使う。どちらも読めなければ合計に入れず、数を別にする。
 * 24時を超える時刻('25:10:00')は、その日の 24時より後としてそのまま数える。
 *
 * その日に走る service の集合は、呼ぶ側が日付から求める(lib/serviceDay.ts の describeServiceDay(feed, date).serviceIds)。
 */

/** 便の区間。秒はその日の 0時からの秒(24時を超えうる) */
export interface TripLeg {
  /** 空白を取った trip_id */
  tripId: string
  /** 最初の停留所の出発(空なら到着) */
  dep: number
  /** 最後の停留所の到着(空なら出発) */
  arr: number
  /** 空白を取った stop_id */
  firstStopId: string
  lastStopId: string
}

export interface TripLegs {
  /** 出発の秒の昇順。同じなら trip_id の昇順 */
  legs: TripLeg[]
  /** 最初の出発か最後の到着が読めず、区間にしなかった便の数 */
  unknownTrips: number
}

export interface ServiceHours {
  /** その日に走る便の数(時刻が読めない便も含む) */
  trips: number
  /** 営業運行時間の合計(分) */
  serviceMinutes: number
  /** 時刻が読めず合計に入れなかった便の数 */
  unknownDuration: number
  /** 最初の出発と最後の到着('HH:MM'。24時を超える値は '25:10' のまま。便が無ければ null) */
  firstDeparture: string | null
  lastArrival: string | null
}

export interface ServiceHoursComparison {
  before: ServiceHours
  after: ServiceHours
  /** 前 − 後。減ったら正、増えたら負 */
  reduction: {
    trips: number
    serviceMinutes: number
    /** serviceMinutes の削減量 ÷ 前の serviceMinutes(0〜1。増えたら負)。前が 0 分なら null */
    ratio: number | null
  }
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** 時刻の列の値を秒にする。空なら代わりの列を使う(restoreTotals と同じ) */
function timeOf(row: GtfsRow | undefined, primary: 'arrival_time' | 'departure_time'): number | null {
  if (!row) return null
  const other = primary === 'arrival_time' ? 'departure_time' : 'arrival_time'
  const value = trimmed(row[primary]) !== '' ? row[primary] : row[other]
  return parseGtfsTime(value)
}

interface TripSpan {
  tripId: string
  dep: number | null
  arr: number | null
  firstStopId: string
  lastStopId: string
}

/**
 * その日に走る便を、trips の行の順に区間にする。stop_times の索引はここで1回だけ作る。
 * 同じ trip_id の行が2つ以上あれば、最初の行だけを数える(restoreTotals と同じ)
 */
function tripSpans(feed: GtfsFeed, serviceIds: ReadonlySet<string> | readonly string[]): TripSpan[] {
  const services = new Set([...serviceIds].map((s) => s.trim()))
  const trips = (feed.tables.get('trips')?.rows ?? []).filter((t) => services.has(trimmed(t.service_id)))
  if (trips.length === 0) return []
  const groups = stopTimesByTrip(feed.tables.get('stop_times')?.rows ?? [])
  const seen = new Set<string>()
  const spans: TripSpan[] = []
  for (const trip of trips) {
    const tripId = trimmed(trip.trip_id)
    if (seen.has(tripId)) continue
    seen.add(tripId)
    const ordered = sortByStopSequence(groups.get(tripId) ?? [])
    const first = ordered[0]
    const last = ordered[ordered.length - 1]
    spans.push({
      tripId,
      dep: timeOf(first, 'departure_time'),
      arr: timeOf(last, 'arrival_time'),
      firstStopId: trimmed(first?.stop_id),
      lastStopId: trimmed(last?.stop_id),
    })
  }
  return spans
}

/**
 * その日に走る便を、時刻順の区間にする(要る運転士の数の推定に使う)。
 * 最初の出発か最後の到着が読めない便は区間にせず、unknownTrips に数える
 */
export function tripLegs(feed: GtfsFeed, serviceIds: ReadonlySet<string> | readonly string[]): TripLegs {
  const legs: TripLeg[] = []
  let unknownTrips = 0
  for (const s of tripSpans(feed, serviceIds)) {
    if (s.dep === null || s.arr === null) unknownTrips++
    else legs.push({ tripId: s.tripId, dep: s.dep, arr: s.arr, firstStopId: s.firstStopId, lastStopId: s.lastStopId })
  }
  legs.sort((a, b) => a.dep - b.dep || compareStrings(a.tripId, b.tripId))
  return { legs, unknownTrips }
}

/** その日に走る便の数・営業運行時間の合計・最初の出発と最後の到着 */
export function serviceHours(feed: GtfsFeed, serviceIds: ReadonlySet<string> | readonly string[]): ServiceHours {
  const spans = tripSpans(feed, serviceIds)
  let seconds = 0
  let unknownDuration = 0
  let earliest: number | null = null
  let latest: number | null = null
  for (const { dep, arr } of spans) {
    if (dep !== null && (earliest === null || dep < earliest)) earliest = dep
    if (arr !== null && (latest === null || arr > latest)) latest = arr
    if (dep === null || arr === null) unknownDuration++
    else seconds += arr - dep
  }
  return {
    trips: spans.length,
    serviceMinutes: Math.round(seconds / 60),
    unknownDuration,
    firstDeparture: earliest === null ? null : formatClock(earliest),
    lastArrival: latest === null ? null : formatClock(latest),
  }
}

/** 減便の前後を並べ、削減量(前 − 後)を出す */
export function compareServiceHours(before: ServiceHours, after: ServiceHours): ServiceHoursComparison {
  const minutes = before.serviceMinutes - after.serviceMinutes
  return {
    before,
    after,
    reduction: {
      trips: before.trips - after.trips,
      serviceMinutes: minutes,
      ratio: before.serviceMinutes === 0 ? null : minutes / before.serviceMinutes,
    },
  }
}
