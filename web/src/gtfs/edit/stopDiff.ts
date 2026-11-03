import { activeServiceIds } from '../calendar'
import { parseGtfsTime } from '../departures'
import type { GtfsFeed, GtfsRow } from '../load'
import { NON_NEGATIVE_INTEGER } from '../parse'
import { formatClock } from './diff'
import { compareStrings, sortByStopSequence, stopTimesByTrip } from './signature'

/**
 * 停留所ごとの前後の発車(本数・始発・最終便・最大間隔・新しく生じる/無くなる発車時刻)と、
 * 系統 × 方向ごとの便の並び。停留所の一覧(B)・周知文・変更指示書・足し戻しの一覧が共通で使う純粋な計算。
 *
 * 数える発車は、到達圏の出発の数(departures.ts の departureCountsByBand)と同じ規則にする
 * (停留所の一覧の本数と、地図の出発の数が食い違わないようにするため):
 * - その日(date)に走る service の便だけ。前日の便の 24時を超える発車は入れない。掲示は1日のダイヤを表し、
 *   前日の便を足すと 24時を超える便が2回出るため(比較の初日の前日の扱いは取り決め 1104 §13 の「後で」)
 * - pickup_type が '1'(前後の空白を除いて一致。乗車できない)の行は数えない
 * - 各便の最後の停留所(stop_sequence を0 以上の10進の整数として比べて最大の行)は数えない
 * - departure_time が空の行は数えない(到着の時刻で補わない)。時刻として読めない行も数えない。どちらも数だけ返す
 * - frequencies.txt は展開しない
 *
 * 停留所は stop_id で照合する。基準と編集後のどちらかにその日の発車がある停留所をすべて出すので、
 * 編集後に stop_times から消えた停留所も、基準の側から数える(取り決め 1103 の追記3)。
 * 時刻は 24時を超える値をそのまま扱う('25:10')。
 */

/** 停留所での1回の発車 */
export interface StopDeparture {
  routeId: string
  tripId: string
  /** サービス日の 0:00 からの秒(24時を超える値もそのまま) */
  seconds: number
  /** 'HH:MM'(24時を超える値は '25:10' のまま) */
  time: string
  /** stop_headsign があればそれ、無ければ trip_headsign(どちらも無ければ空) */
  headsign: string
}

/** 系統ごとの発車(時刻の順) */
export interface RouteDepartures {
  routeId: string
  /** route_short_name、無ければ route_long_name、無ければ route_id */
  routeName: string
  departures: StopDeparture[]
}

/** 停留所の、ある側(前・後)の発車のまとめ */
export interface StopSide {
  /** 本数(発車の数) */
  count: number
  /** 始発・最終便の発車時刻('HH:MM'。発車が無ければ null) */
  first: string | null
  last: string | null
  /** 始発から最終便までの、隣り合う発車の間隔の最大(分)。系統をまとめて数える。発車が2本未満なら null */
  maxGapMin: number | null
  /** 系統ごとの発車(route_id の順) */
  byRoute: RouteDepartures[]
}

export interface StopChange {
  stopId: string
  /** 基準の stops.txt の名前、無ければ編集後、無ければ stop_id */
  stopName: string
  before: StopSide
  after: StopSide
  /** 新しく生じる発車時刻(編集後にだけある。系統と秒で照合した多重集合の差。時刻の順) */
  added: StopDeparture[]
  /** 無くなる発車時刻(基準にだけある。時刻の順) */
  removed: StopDeparture[]
  /** 掲示の差し替えが要る(added か removed がある)。本数が同じでも時刻が変わればそうなる */
  needsRepost: boolean
}

export interface StopDiffResult {
  date: string
  /** その日に、基準か編集後のどちらかで発車がある停留所(stop_id の順) */
  stops: StopChange[]
  /** 掲示の差し替えが要る停留所の数 */
  repostCount: number
  /** 新しく生じる発車時刻がある停留所の数(掲示より早い発車は早発になりうる) */
  stopsWithAdded: number
  /** 無くなる発車時刻がある停留所の数 */
  stopsWithRemoved: number
  /** 基準では発車があり、編集後は発車が無くなる停留所の数 */
  stopsLosingAll: number
  /** departure_time が空で数えなかった行の数(その日に走る便の、本来なら数える行だけ) */
  skippedBlankTime: { base: number; edited: number }
  /** departure_time が時刻として読めず数えなかった行の数 */
  skippedInvalidTime: { base: number; edited: number }
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** stop_sequence を、先頭の 0 を除いた10進の文字列にする。0 以上の10進の整数でなければ null(departures.ts と同じ規則) */
function sequenceKey(row: GtfsRow): string | null {
  const s = trimmed(row.stop_sequence)
  if (!NON_NEGATIVE_INTEGER.test(s)) return null
  return s.replace(/^0+(?=\d)/, '')
}

/** 先頭の 0 が無い10進の文字列 a が b より大きいか */
function isLaterSequence(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b
}

function routeNamesOf(feed: GtfsFeed): Map<string, string> {
  const names = new Map<string, string>()
  for (const r of feed.tables.get('routes')?.rows ?? []) {
    const id = trimmed(r.route_id)
    if (names.has(id)) continue
    names.set(id, trimmed(r.route_short_name) || trimmed(r.route_long_name) || id)
  }
  return names
}

function stopNamesOf(feed: GtfsFeed): Map<string, string> {
  const names = new Map<string, string>()
  for (const s of feed.tables.get('stops')?.rows ?? []) {
    const id = trimmed(s.stop_id)
    if (id !== '' && !names.has(id)) names.set(id, trimmed(s.stop_name))
  }
  return names
}

/** 時刻の順、同じなら系統・trip_id の順 */
function compareDepartures(a: StopDeparture, b: StopDeparture): number {
  return a.seconds - b.seconds || compareStrings(a.routeId, b.routeId) || compareStrings(a.tripId, b.tripId)
}

/** 昇順に並んだ秒の、隣り合う値の差の最大(分。四捨五入)。2つ未満なら null */
function maxGapMinutes(sortedSeconds: readonly number[]): number | null {
  if (sortedSeconds.length < 2) return null
  let max = 0
  for (let i = 1; i < sortedSeconds.length; i++) max = Math.max(max, sortedSeconds[i] - sortedSeconds[i - 1])
  return Math.round(max / 60)
}

interface FeedDepartures {
  /** stop_id ごとの発車(順は不定) */
  byStop: Map<string, StopDeparture[]>
  skippedBlankTime: number
  skippedInvalidTime: number
}

/** その日に走る便の、停留所ごとの発車を集める(上の規則) */
function collectDepartures(feed: GtfsFeed, date: string): FeedDepartures {
  const services = activeServiceIds(feed, date)
  const trips = new Map<string, { routeId: string; headsign: string }>()
  for (const trip of feed.tables.get('trips')?.rows ?? []) {
    const tripId = trimmed(trip.trip_id)
    const serviceId = trimmed(trip.service_id)
    if (tripId === '' || !services.has(serviceId) || trips.has(tripId)) continue
    trips.set(tripId, { routeId: trimmed(trip.route_id), headsign: trimmed(trip.trip_headsign) })
  }

  const byStop = new Map<string, StopDeparture[]>()
  let skippedBlankTime = 0
  let skippedInvalidTime = 0
  if (trips.size === 0) return { byStop, skippedBlankTime, skippedInvalidTime }

  const rows = feed.tables.get('stop_times')?.rows ?? []
  const lastSequence = new Map<string, string>()
  for (const row of rows) {
    const tripId = trimmed(row.trip_id)
    if (!trips.has(tripId)) continue
    const seq = sequenceKey(row)
    if (seq === null) continue
    const prev = lastSequence.get(tripId)
    if (prev === undefined || isLaterSequence(seq, prev)) lastSequence.set(tripId, seq)
  }

  for (const row of rows) {
    const tripId = trimmed(row.trip_id)
    const trip = trips.get(tripId)
    if (!trip) continue
    if (trimmed(row.pickup_type) === '1') continue
    const seq = sequenceKey(row)
    if (seq !== null && seq === lastSequence.get(tripId)) continue
    const departure = trimmed(row.departure_time)
    if (departure === '') {
      skippedBlankTime++
      continue
    }
    const seconds = parseGtfsTime(departure)
    if (seconds === null) {
      skippedInvalidTime++
      continue
    }
    const stopId = trimmed(row.stop_id)
    if (stopId === '') continue
    const dep: StopDeparture = {
      routeId: trip.routeId,
      tripId,
      seconds,
      time: formatClock(seconds),
      headsign: trimmed(row.stop_headsign) || trip.headsign,
    }
    const list = byStop.get(stopId)
    if (list) list.push(dep)
    else byStop.set(stopId, [dep])
  }
  return { byStop, skippedBlankTime, skippedInvalidTime }
}

/** 時刻の順に並んだ発車から、片側のまとめを作る */
function sideOf(sorted: readonly StopDeparture[], routeNames: ReadonlyMap<string, string>): StopSide {
  const byRoute = new Map<string, StopDeparture[]>()
  for (const d of sorted) {
    const list = byRoute.get(d.routeId)
    if (list) list.push(d)
    else byRoute.set(d.routeId, [d])
  }
  return {
    count: sorted.length,
    first: sorted.length > 0 ? sorted[0].time : null,
    last: sorted.length > 0 ? sorted[sorted.length - 1].time : null,
    maxGapMin: maxGapMinutes(sorted.map((d) => d.seconds)),
    byRoute: [...byRoute.keys()].sort(compareStrings).map((routeId) => ({
      routeId,
      routeName: routeNames.get(routeId) ?? routeId,
      departures: byRoute.get(routeId) ?? [],
    })),
  }
}

/**
 * 多重集合の差。系統と秒の組で照合し、a にあって b に無い分を返す(同じ組が a に3回・b に1回なら2回分)。
 * 同じ組のうちどれを残すかは、a の並び(時刻・系統・trip_id の順)の後ろの側を返す
 */
function multisetMinus(a: readonly StopDeparture[], b: readonly StopDeparture[]): StopDeparture[] {
  const key = (d: StopDeparture) => `${d.routeId}\u0000${d.seconds}`
  const remaining = new Map<string, number>()
  for (const d of b) remaining.set(key(d), (remaining.get(key(d)) ?? 0) + 1)
  const out: StopDeparture[] = []
  for (const d of a) {
    const k = key(d)
    const n = remaining.get(k) ?? 0
    if (n > 0) remaining.set(k, n - 1)
    else out.push(d)
  }
  return out
}

/**
 * 同じ日付(date、'YYYYMMDD')の基準と編集後の、停留所ごとの発車を比べる。
 * date が不正な日付ならエラーにする(activeServiceIds と同じ)
 */
export function stopDiff(base: GtfsFeed, edited: GtfsFeed, date: string): StopDiffResult {
  const before = collectDepartures(base, date)
  const after = collectDepartures(edited, date)
  // 系統名は編集後の routes で補う(基準を優先)
  const routeNames = new Map([...routeNamesOf(edited), ...routeNamesOf(base)])
  const baseStopNames = stopNamesOf(base)
  const editedStopNames = stopNamesOf(edited)

  const stopIds = [...new Set([...before.byStop.keys(), ...after.byStop.keys()])].sort(compareStrings)
  const stops: StopChange[] = stopIds.map((stopId) => {
    const b = [...(before.byStop.get(stopId) ?? [])].sort(compareDepartures)
    const a = [...(after.byStop.get(stopId) ?? [])].sort(compareDepartures)
    const added = multisetMinus(a, b)
    const removed = multisetMinus(b, a)
    return {
      stopId,
      stopName: baseStopNames.get(stopId) || editedStopNames.get(stopId) || stopId,
      before: sideOf(b, routeNames),
      after: sideOf(a, routeNames),
      added,
      removed,
      needsRepost: added.length > 0 || removed.length > 0,
    }
  })

  return {
    date,
    stops,
    repostCount: stops.filter((s) => s.needsRepost).length,
    stopsWithAdded: stops.filter((s) => s.added.length > 0).length,
    stopsWithRemoved: stops.filter((s) => s.removed.length > 0).length,
    stopsLosingAll: stops.filter((s) => s.before.count > 0 && s.after.count === 0).length,
    skippedBlankTime: { base: before.skippedBlankTime, edited: after.skippedBlankTime },
    skippedInvalidTime: { base: before.skippedInvalidTime, edited: after.skippedInvalidTime },
  }
}

// ---- 系統 × 方向ごとの便の並び ----

/** 方向の中の1便 */
export interface TimelineTrip {
  tripId: string
  headsign: string
  /** 始発の停留所の発車時刻('HH:MM')と秒。出発が空なら到着の時刻、どちらも読めなければ null */
  departure: string | null
  seconds: number | null
  /** 終着の停留所の到着時刻('HH:MM')。到着が空なら出発の時刻 */
  arrival: string | null
}

/** 方向(始発の停留所 → 終着の停留所の組。direction_id は空が多いので使わない) */
export interface RouteDirection {
  firstStopId: string
  firstStopName: string
  lastStopId: string
  lastStopName: string
  /** 始発の時刻の順(時刻の無い便は後ろ。同じ時刻なら trip_id の順) */
  trips: TimelineTrip[]
  /** 始発の時刻が読める便どうしの、隣り合う始発の間隔の最大(分)。始発から最終便までの間だけ。2便未満なら null */
  maxGapMin: number | null
}

/** 時刻の列の値を秒にする。空なら代わりの列を使う(到着・出発のどちらかが空の行のため) */
function timeOf(row: GtfsRow | undefined, primary: 'arrival_time' | 'departure_time'): number | null {
  if (!row) return null
  const other = primary === 'arrival_time' ? 'departure_time' : 'arrival_time'
  const value = trimmed(row[primary]) !== '' ? row[primary] : row[other]
  return parseGtfsTime(value)
}

/**
 * フィードとその日の、系統ごとの方向の並びを返す関数を作る。stop_times の索引は1回だけ作るので、
 * 多くの系統を並べるとき(足し戻しの一覧)はこちらを使う。
 * 方向は、便の stop_times を stop_sequence の順に並べたときの最初と最後の停留所の組(最後の停留所も含める)。
 * その日(date)に走る service の便だけを並べる。date が不正な日付ならエラーにする
 */
export function createRouteDirectionTimeline(feed: GtfsFeed, date: string): (routeId: string) => RouteDirection[] {
  const services = activeServiceIds(feed, date)
  const stopNames = stopNamesOf(feed)
  const groups = stopTimesByTrip(feed.tables.get('stop_times')?.rows ?? [])
  const tripsByRoute = new Map<string, GtfsRow[]>()
  const seen = new Set<string>()
  for (const trip of feed.tables.get('trips')?.rows ?? []) {
    const tripId = trimmed(trip.trip_id)
    if (tripId === '' || seen.has(tripId) || !services.has(trimmed(trip.service_id))) continue
    seen.add(tripId)
    const routeId = trimmed(trip.route_id)
    const list = tripsByRoute.get(routeId)
    if (list) list.push(trip)
    else tripsByRoute.set(routeId, [trip])
  }

  return (routeId) => {
    const directions = new Map<string, RouteDirection>()
    for (const trip of tripsByRoute.get(routeId.trim()) ?? []) {
      const tripId = trimmed(trip.trip_id)
      const ordered = sortByStopSequence(groups.get(tripId) ?? [])
      if (ordered.length === 0) continue
      const firstStopId = trimmed(ordered[0].stop_id)
      const lastStopId = trimmed(ordered[ordered.length - 1].stop_id)
      const key = `${firstStopId}\u0000${lastStopId}`
      let dir = directions.get(key)
      if (!dir) {
        dir = {
          firstStopId,
          firstStopName: stopNames.get(firstStopId) || firstStopId,
          lastStopId,
          lastStopName: stopNames.get(lastStopId) || lastStopId,
          trips: [],
          maxGapMin: null,
        }
        directions.set(key, dir)
      }
      const seconds = timeOf(ordered[0], 'departure_time')
      const arrival = timeOf(ordered[ordered.length - 1], 'arrival_time')
      dir.trips.push({
        tripId,
        headsign: trimmed(trip.trip_headsign),
        departure: seconds === null ? null : formatClock(seconds),
        seconds,
        arrival: arrival === null ? null : formatClock(arrival),
      })
    }

    const list = [...directions.values()]
    for (const dir of list) {
      dir.trips.sort((a, b) => {
        if (a.seconds !== b.seconds) {
          if (a.seconds === null) return 1
          if (b.seconds === null) return -1
          return a.seconds - b.seconds
        }
        return compareStrings(a.tripId, b.tripId)
      })
      dir.maxGapMin = maxGapMinutes(dir.trips.map((t) => t.seconds).filter((s): s is number => s !== null))
    }
    // 方向は、最初の便の始発の時刻の順(時刻の無い方向は後ろ)、同じなら始発・終着の stop_id の順
    const firstSeconds = (d: RouteDirection) => d.trips[0]?.seconds ?? null
    return list.sort((a, b) => {
      const sa = firstSeconds(a)
      const sb = firstSeconds(b)
      if (sa !== sb) {
        if (sa === null) return 1
        if (sb === null) return -1
        return sa - sb
      }
      return compareStrings(a.firstStopId, b.firstStopId) || compareStrings(a.lastStopId, b.lastStopId)
    })
  }
}

/** 1つの系統の、その日の方向ごとの便の並びと最大間隔。多くの系統を並べるときは createRouteDirectionTimeline を使う */
export function routeDirectionTimeline(feed: GtfsFeed, routeId: string, date: string): RouteDirection[] {
  return createRouteDirectionTimeline(feed, date)(routeId)
}
