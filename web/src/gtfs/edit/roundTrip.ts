import { activeServiceIds, isValidGtfsDate } from '../calendar'
import { parseGtfsTime } from '../departures'
import type { GtfsFeed, GtfsRow } from '../load'
import { formatClock } from './diff'
import { compareStrings, sortByStopSequence, stopTimesByTrip } from './signature'

/**
 * 往復(登校・出勤と帰宅)の確かめ(指摘 18.2、docs/tasks-1105.md の A04)。比較する日付の、減便前と減便後の便を
 * 系統の方向ごとに数え、方向がなくなる・帰りの便が欠ける・終発が早まる・始発が遅くなるを問題として返す純粋な計算。
 *
 * - 方向は、便の始発と終着の停留所名の組。名前は NFKC にして空白を除いて照らす(道北バスは direction_id も parent_station も
 *   空で、向かい合う停留所の stop_id が違うため。名前が空なら stop_id を使う)。始発と終着は stop_times を stop_sequence の順に
 *   並べた最初と最後の行(最後の停留所も含める)
 * - 逆向き(始発と終着を入れ替えた組)は、同じ系統 → ほかの系統の順に探す。ほかの系統で見つかれば、その組を持つ系統すべてを
 *   合わせて逆向きとする。系統のどの方向にも逆向きが無い系統(片道や、端の停留所名が行きと帰りで違う循環)は noReverse として
 *   数だけ返し、方向の一覧と問題には入れない
 * - 始発と終着が同じ名前の方向(旭川駅前 → 旭川駅前 のような循環)は、それ自身を逆向きとする(朝の便と帰りの便が同じ方向にある)。
 *   reverse.loop が true になる
 * - 系統の分け方(逆向きが同じ系統にある・ほかの系統にある・無い)と逆向きの照らし合わせは、減便前の方向だけで決める
 *   (減便の方針によって系統の数が変わらないように)。減便後にだけある方向も、分けた系統の中なら一覧に入れる。
 *   減便前にその日の便が無い系統は数だけ返す(afterOnly)
 * - 便の時刻は始発の停留所の出発(空なら到着)。始発・終発と、朝・帰りの窓はこの時刻で決める。時刻が読めない便は
 *   便数には入れ、始発・終発・窓には入れない。24時を超える時刻はそのまま扱う
 * - その日(date)に走る service の便だけを数える。前日の便の 24時を超える分は入れない
 *
 * 問題は4種類(窓は開始を含み終わりを含まない。ずれは options.shiftMin 分以上):
 * - directionVanishes:減便前 1 便以上、減便後 0 便
 * - noReturn:減便後に、行きの方向に朝の窓の便があり、逆向きに帰りの窓の便が 0。逆向きに減便前は帰りの窓の便が 1 以上
 *   あったときだけ。directionVanishes と同時に出ることがある(重ねて数える)
 * - lastEarlier:減便前・減便後とも便があり、終発が shiftMin 分以上早まる
 * - firstLater:減便前・減便後とも便があり、始発が shiftMin 分以上遅くなる
 */

/** 時間帯の窓(0:00 からの分。開始を含み終わりを含まない) */
export interface RoundTripWindow {
  startMin: number
  endMin: number
}

export interface RoundTripOptions {
  /**
   * 平日の service_id(形2の入れ替え元。減便後のフィードでは form2.ts の activeWeekdayServicesOf(result))。
   * 渡したときは、比較する日付に減便前でこのどれも走らなければ、理由つきの空の結果を返す。
   * 渡さないときは、減便前でその日に走る service が1つも無いときだけ空の結果にする
   */
  weekdayServices?: Iterable<string>
  /** 行き(登校・出勤)の窓。既定は 6:00〜9:00(判断材料の morning と同じ) */
  morning?: RoundTripWindow
  /** 帰りの窓。既定は 15:00〜21:00(判断材料の evening と同じ。指摘17 の 15〜21時) */
  evening?: RoundTripWindow
  /** 始発が遅くなる・終発が早まるとみなすずれ(分。この値以上)。既定は 30 */
  shiftMin?: number
}

export const ROUND_TRIP_DEFAULTS: { morning: RoundTripWindow; evening: RoundTripWindow; shiftMin: number } = {
  morning: { startMin: 6 * 60, endMin: 9 * 60 },
  evening: { startMin: 15 * 60, endMin: 21 * 60 },
  shiftMin: 30,
}

/** 方向の、ある側(減便前・減便後)のまとめ */
export interface RoundTripSide {
  /** 便の数(時刻が読めない便も含む) */
  trips: number
  /** 始発・終発の出発時刻('HH:MM'。24時を超える値は '25:10' のまま。読める時刻の便が無ければ null) */
  first: string | null
  last: string | null
  /** 朝の窓・帰りの窓に始発の停留所を出る便の数 */
  morning: number
  evening: number
}

/** 逆向きの見つけ方 */
export interface RoundTripReverse {
  /** sameRoute:同じ系統に逆向きがある。otherRoute:ほかの系統にだけある */
  scope: 'sameRoute' | 'otherRoute'
  /** 逆向きの方向を持つ系統(route_id の順) */
  routeIds: string[]
  /** 始発と終着が同じ名前の方向(循環)で、それ自身を逆向きとした */
  loop: boolean
}

export interface RoundTripDirection {
  routeId: string
  /** route_short_name、無ければ route_long_name、無ければ route_id */
  routeName: string
  /** 始発・終着の停留所名(表示用。最初に見つけた便の名前のまま) */
  fromName: string
  toName: string
  before: RoundTripSide
  after: RoundTripSide
  /** この方向の逆向き。系統には逆向きがあるが、この方向には無い(折り返しの短い便など)ときは null */
  reverse: RoundTripReverse | null
}

export type RoundTripProblemKind = 'directionVanishes' | 'noReturn' | 'lastEarlier' | 'firstLater'

export const ROUND_TRIP_PROBLEM_KINDS: readonly RoundTripProblemKind[] = ['directionVanishes', 'noReturn', 'lastEarlier', 'firstLater']

/** 画面と AI の結果に出す問題の名前 */
export const ROUND_TRIP_PROBLEM_LABELS: Record<RoundTripProblemKind, string> = {
  directionVanishes: '方向の便がなくなる',
  noReturn: '帰りの便がない',
  lastEarlier: '終発が早まる',
  firstLater: '始発が遅くなる',
}

export interface RoundTripProblem {
  kind: RoundTripProblemKind
  routeId: string
  routeName: string
  /** 問題の方向(noReturn では行きの方向) */
  fromName: string
  toName: string
  before: RoundTripSide
  after: RoundTripSide
  /** lastEarlier・firstLater のときのずれ(分。どちらも正の値)。ほかは null */
  shiftMin: number | null
  /**
   * noReturn のときの逆向き(帰りの方向)。系統と、帰りの窓の便の数の前後(逆向きの系統すべてを合わせた数)。ほかは null
   */
  returnTrips: { routeIds: string[]; eveningBefore: number; eveningAfter: number } | null
}

export interface RoundTripResult {
  date: string
  /** 空の結果の理由(比較する日付が不正、または平日ダイヤが走らない)。確かめられたときは null */
  emptyReason: { code: 'invalidDate' | 'noWeekdayService'; message: string } | null
  /** 使った窓とずれ */
  windows: { morning: RoundTripWindow; evening: RoundTripWindow; shiftMin: number }
  /** 逆向きのある系統の方向(系統の route_id、始発・終着の名前の順) */
  directions: RoundTripDirection[]
  /** 問題(種類の順、次に系統の route_id、始発・終着の名前の順) */
  problems: RoundTripProblem[]
  /** 種類ごとの問題の数 */
  counts: Record<RoundTripProblemKind, number>
  /** 系統の数(減便前にその日の便がある系統を分けたもの) */
  routes: {
    /** 逆向きがある系統(sameRoute + otherRoute) */
    withReverse: number
    sameRoute: number
    otherRoute: number
    /** どこにも逆向きが無い系統(循環・片道)。方向の一覧と問題には入れない */
    noReverse: number
    /** 減便後にだけその日の便がある系統。方向の一覧と問題には入れない */
    afterOnly: number
  }
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** 停留所名を照らすための形(NFKC にして空白を除く) */
export function normalizeStopName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '')
}

/** 時刻の列の値を秒にする。空なら代わりの列を使う */
function timeOf(row: GtfsRow | undefined, primary: 'arrival_time' | 'departure_time'): number | null {
  if (!row) return null
  const other = primary === 'arrival_time' ? 'departure_time' : 'arrival_time'
  const value = trimmed(row[primary]) !== '' ? row[primary] : row[other]
  return parseGtfsTime(value)
}

/** 方向のキーの区切り(停留所名に出てこない文字) */
const SEP = '\u0000'

interface RawDirection {
  fromKey: string
  toKey: string
  fromName: string
  toName: string
  /** 便ごとの始発の時刻(秒。読めなければ null) */
  seconds: (number | null)[]
}

/** 系統 → 方向のキー → 方向 */
type DirectionsByRoute = Map<string, Map<string, RawDirection>>

function stopNamesOf(feed: GtfsFeed, into: Map<string, string>): void {
  for (const s of feed.tables.get('stops')?.rows ?? []) {
    const id = trimmed(s.stop_id)
    if (id !== '' && !into.has(id)) into.set(id, trimmed(s.stop_name))
  }
}

function routeNamesOf(feed: GtfsFeed, into: Map<string, string>): void {
  for (const r of feed.tables.get('routes')?.rows ?? []) {
    const id = trimmed(r.route_id)
    if (into.has(id)) continue
    into.set(id, trimmed(r.route_short_name) || trimmed(r.route_long_name) || id)
  }
}

/** その日に走る便を、系統と方向ごとに集める */
function collectDirections(feed: GtfsFeed, services: ReadonlySet<string>, stopNames: ReadonlyMap<string, string>): DirectionsByRoute {
  const out: DirectionsByRoute = new Map()
  const trips: GtfsRow[] = []
  const seen = new Set<string>()
  for (const trip of feed.tables.get('trips')?.rows ?? []) {
    const tripId = trimmed(trip.trip_id)
    if (tripId === '' || seen.has(tripId) || !services.has(trimmed(trip.service_id))) continue
    seen.add(tripId)
    trips.push(trip)
  }
  if (trips.length === 0) return out
  const groups = stopTimesByTrip(feed.tables.get('stop_times')?.rows ?? [])

  for (const trip of trips) {
    const ordered = sortByStopSequence(groups.get(trimmed(trip.trip_id)) ?? [])
    if (ordered.length === 0) continue
    const fromId = trimmed(ordered[0].stop_id)
    const toId = trimmed(ordered[ordered.length - 1].stop_id)
    const fromName = stopNames.get(fromId) || fromId
    const toName = stopNames.get(toId) || toId
    const fromKey = normalizeStopName(fromName)
    const toKey = normalizeStopName(toName)
    const routeId = trimmed(trip.route_id)
    let byKey = out.get(routeId)
    if (!byKey) {
      byKey = new Map()
      out.set(routeId, byKey)
    }
    const key = fromKey + SEP + toKey
    let dir = byKey.get(key)
    if (!dir) {
      dir = { fromKey, toKey, fromName, toName, seconds: [] }
      byKey.set(key, dir)
    }
    dir.seconds.push(timeOf(ordered[0], 'departure_time'))
  }
  return out
}

function inWindow(seconds: number, w: RoundTripWindow): boolean {
  return seconds >= w.startMin * 60 && seconds < w.endMin * 60
}

function sideOf(dir: RawDirection | undefined, morning: RoundTripWindow, evening: RoundTripWindow): RoundTripSide {
  const all = dir?.seconds ?? []
  const times = all.filter((s): s is number => s !== null)
  const min = times.length > 0 ? Math.min(...times) : null
  const max = times.length > 0 ? Math.max(...times) : null
  return {
    trips: all.length,
    first: min === null ? null : formatClock(min),
    last: max === null ? null : formatClock(max),
    morning: times.filter((s) => inWindow(s, morning)).length,
    evening: times.filter((s) => inWindow(s, evening)).length,
  }
}

function emptyCounts(): Record<RoundTripProblemKind, number> {
  return { directionVanishes: 0, noReturn: 0, lastEarlier: 0, firstLater: 0 }
}

/** 'HH:MM'(24時を超える値も)を分にする */
function clockMinutes(clock: string): number {
  const [h, m] = clock.split(':')
  return Number(h) * 60 + Number(m)
}

function validWindow(w: RoundTripWindow | undefined, fallback: RoundTripWindow): RoundTripWindow {
  if (!w || !Number.isFinite(w.startMin) || !Number.isFinite(w.endMin) || w.startMin >= w.endMin) return fallback
  return { startMin: w.startMin, endMin: w.endMin }
}

/**
 * 比較する日付(date、'YYYYMMDD')の、減便前(base)と減便後(edited)の往復を確かめる。
 * 不正な日付や、その日に平日ダイヤが走らないときは、例外にせず理由つきの空の結果を返す
 */
export function roundTripCheck(base: GtfsFeed, edited: GtfsFeed, date: string, options: RoundTripOptions = {}): RoundTripResult {
  const windows = {
    morning: validWindow(options.morning, ROUND_TRIP_DEFAULTS.morning),
    evening: validWindow(options.evening, ROUND_TRIP_DEFAULTS.evening),
    shiftMin:
      options.shiftMin !== undefined && Number.isFinite(options.shiftMin) && options.shiftMin > 0
        ? options.shiftMin
        : ROUND_TRIP_DEFAULTS.shiftMin,
  }
  const empty = (code: 'invalidDate' | 'noWeekdayService', message: string): RoundTripResult => ({
    date,
    emptyReason: { code, message },
    windows,
    directions: [],
    problems: [],
    counts: emptyCounts(),
    routes: { withReverse: 0, sameRoute: 0, otherRoute: 0, noReverse: 0, afterOnly: 0 },
  })

  if (!isValidGtfsDate(date)) return empty('invalidDate', `比較する日付(${date})が日付として読めないため、往復を確かめていません。`)
  const baseServices = activeServiceIds(base, date)
  const weekdays = options.weekdayServices === undefined ? null : new Set([...options.weekdayServices].map((s) => s.trim()))
  const weekdayRuns = weekdays === null ? baseServices.size > 0 : [...weekdays].some((s) => baseServices.has(s))
  if (!weekdayRuns) {
    return empty('noWeekdayService', '比較する日付に減便前の平日ダイヤが走らないため、往復を確かめていません。平日の日付を選んでください。')
  }

  const stopNames = new Map<string, string>()
  stopNamesOf(base, stopNames)
  stopNamesOf(edited, stopNames)
  const routeNames = new Map<string, string>()
  routeNamesOf(base, routeNames)
  routeNamesOf(edited, routeNames)
  const before = collectDirections(base, baseServices, stopNames)
  const after = collectDirections(edited, activeServiceIds(edited, date), stopNames)

  // 減便前の方向のキー → その方向を持つ系統
  const routesByKey = new Map<string, Set<string>>()
  for (const [routeId, byKey] of before) {
    for (const key of byKey.keys()) {
      let set = routesByKey.get(key)
      if (!set) {
        set = new Set()
        routesByKey.set(key, set)
      }
      set.add(routeId)
    }
  }

  /** 方向の逆向き(減便前の方向で探す)。循環(始発と終着が同じ名前)は、それ自身が逆向きになる */
  function reverseOf(routeId: string, dir: RawDirection): RoundTripReverse | null {
    const routes = routesByKey.get(dir.toKey + SEP + dir.fromKey)
    if (!routes || routes.size === 0) return null
    const loop = dir.fromKey === dir.toKey
    if (routes.has(routeId)) return { scope: 'sameRoute', routeIds: [routeId], loop }
    return { scope: 'otherRoute', routeIds: [...routes].sort(compareStrings), loop }
  }

  const routeCounts = { withReverse: 0, sameRoute: 0, otherRoute: 0, noReverse: 0, afterOnly: 0 }
  for (const routeId of after.keys()) if (!before.has(routeId)) routeCounts.afterOnly++

  const directions: RoundTripDirection[] = []
  const raws: { routeId: string; key: string; dir: RawDirection }[] = []
  for (const routeId of [...before.keys()].sort(compareStrings)) {
    const baseDirs = before.get(routeId)!
    const reverses = [...baseDirs.values()].map((d) => reverseOf(routeId, d))
    if (reverses.some((r) => r?.scope === 'sameRoute')) routeCounts.sameRoute++
    else if (reverses.some((r) => r?.scope === 'otherRoute')) routeCounts.otherRoute++
    else {
      routeCounts.noReverse++
      continue
    }
    const editedDirs = after.get(routeId) ?? new Map<string, RawDirection>()
    for (const key of new Set([...baseDirs.keys(), ...editedDirs.keys()])) {
      const dir = baseDirs.get(key) ?? editedDirs.get(key)!
      raws.push({ routeId, key, dir })
    }
  }
  routeCounts.withReverse = routeCounts.sameRoute + routeCounts.otherRoute
  raws.sort(
    (a, b) =>
      compareStrings(a.routeId, b.routeId) || compareStrings(a.dir.fromKey, b.dir.fromKey) || compareStrings(a.dir.toKey, b.dir.toKey),
  )

  const { morning, evening, shiftMin } = windows
  const problems: RoundTripProblem[] = []
  for (const { routeId, key, dir } of raws) {
    const b = sideOf(before.get(routeId)?.get(key), morning, evening)
    const a = sideOf(after.get(routeId)?.get(key), morning, evening)
    const reverse = reverseOf(routeId, dir)
    const routeName = routeNames.get(routeId) ?? routeId
    directions.push({ routeId, routeName, fromName: dir.fromName, toName: dir.toName, before: b, after: a, reverse })

    const problem = (kind: RoundTripProblemKind, extra: Partial<Pick<RoundTripProblem, 'shiftMin' | 'returnTrips'>> = {}) =>
      problems.push({
        kind,
        routeId,
        routeName,
        fromName: dir.fromName,
        toName: dir.toName,
        before: b,
        after: a,
        shiftMin: extra.shiftMin ?? null,
        returnTrips: extra.returnTrips ?? null,
      })

    if (b.trips > 0 && a.trips === 0) problem('directionVanishes')
    if (b.trips > 0 && a.trips > 0) {
      if (b.last !== null && a.last !== null) {
        const d = clockMinutes(b.last) - clockMinutes(a.last)
        if (d >= shiftMin) problem('lastEarlier', { shiftMin: d })
      }
      if (b.first !== null && a.first !== null) {
        const d = clockMinutes(a.first) - clockMinutes(b.first)
        if (d >= shiftMin) problem('firstLater', { shiftMin: d })
      }
    }
    if (a.morning > 0 && reverse !== null) {
      const reverseKey = dir.toKey + SEP + dir.fromKey
      let eveningBefore = 0
      let eveningAfter = 0
      for (const r of reverse.routeIds) {
        eveningBefore += sideOf(before.get(r)?.get(reverseKey), morning, evening).evening
        eveningAfter += sideOf(after.get(r)?.get(reverseKey), morning, evening).evening
      }
      if (eveningBefore > 0 && eveningAfter === 0) {
        problem('noReturn', { returnTrips: { routeIds: reverse.routeIds, eveningBefore, eveningAfter } })
      }
    }
  }

  const kindOrder = new Map(ROUND_TRIP_PROBLEM_KINDS.map((k, i) => [k, i]))
  problems.sort(
    (x, y) =>
      kindOrder.get(x.kind)! - kindOrder.get(y.kind)! ||
      compareStrings(x.routeId, y.routeId) ||
      compareStrings(normalizeStopName(x.fromName), normalizeStopName(y.fromName)) ||
      compareStrings(normalizeStopName(x.toName), normalizeStopName(y.toName)),
  )
  const counts = emptyCounts()
  for (const p of problems) counts[p.kind]++

  return { date, emptyReason: null, windows, directions, problems, counts, routes: routeCounts }
}
