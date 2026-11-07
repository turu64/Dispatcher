import { isValidGtfsDate } from '../calendar'
import { activeWeekdayServicesOf, type Form2Result } from '../edit/form2'
import { formatDate } from '../edit/ops'
import { compareStrings, sortByStopSequence, stopTimesByTrip, tripSignature } from '../edit/signature'
import type { GtfsFeed, GtfsRow } from '../load'

/**
 * GTFS-JP 第4.0版の規則のうち、フィード全体を見るもの(gtfs-jp-check の Skill の規則1〜6、取り決め 1104 §12.2・§13)。
 * validateEdit(edit.ts)から呼ぶ。どれも純粋な関数。
 *
 * - FEED_ERROR_RULES:error の規則。validateEdit が基準にも当て、入力からある問題を warning(inherited)に分ける
 * - feedIssues:基準と編集後を比べる error(stopIdChanged・routeIdChanged)と、warning・info の規則
 */

/** validateEdit の結果の1件(edit.ts の ValidationIssue と同じ形。循環を避けるためここで定義し、edit.ts が使う) */
export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info'
  code: string
  /** 'trips.txt' など。全体の問題は '' */
  file: string
  /** 日本語 */
  message: string
  count: number
  /** trip_id などを最大 5 件 */
  examples: string[]
  /** error のうち、出力だけを止めるもの(承認と比較はできる)。無ければ false */
  exportOnly?: boolean
  /** 基準(入力)にも同じ問題がある。無ければ false */
  inherited?: boolean
}

/** error の規則。対象(trip_id・service_id など)の集合を返し、基準の対象と比べて入力からある問題を分ける */
export interface StructuralRule {
  code: string
  file: string
  message: (count: number) => string
  /** 問題の対象(trip_id・stop_id・service_id など)。空白を取った値 */
  targets: (feed: GtfsFeed) => Set<string>
  /** 対象が便の trip_id で、写した便は写す元の便の問題を引き継ぐ(入力からある問題を写す元の trip_id で探す) */
  tripTargets?: boolean
}

export const MAX_EXAMPLES = 5

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

function rowsOf(feed: GtfsFeed, name: string): GtfsRow[] {
  return feed.tables.get(name)?.rows ?? []
}

export function examplesOf(targets: Iterable<string>): string[] {
  return [...targets].sort(compareStrings).slice(0, MAX_EXAMPLES)
}

// 基準のフィードは何度も検証に使うので、stop_times の便ごとのまとめを行の配列ごとに覚えておく
const groupCache = new WeakMap<readonly GtfsRow[], Map<string, GtfsRow[]>>()

/** stop_times を便ごとにまとめたもの(行の配列が同じなら使い回す) */
function stopTimeGroups(feed: GtfsFeed): Map<string, GtfsRow[]> {
  const rows = rowsOf(feed, 'stop_times')
  let groups = groupCache.get(rows)
  if (!groups) {
    groups = stopTimesByTrip(rows)
    groupCache.set(rows, groups)
  }
  return groups
}

// ---- 時刻の書き方 ----

/** GTFS の時刻。時は1桁か2桁(24時を超えてよい)、分・秒は 00〜59 */
const GTFS_TIME = /^\d{1,2}:[0-5]\d:[0-5]\d$/
const ONE_DIGIT_HOUR = /^\d:/
const TIME_FIELDS = ['arrival_time', 'departure_time'] as const

/** 時刻の書き方が正しくない(空は通過の停留所で許されるので数えない) */
function isBadTime(raw: string | undefined): boolean {
  const v = trimmed(raw)
  return v !== '' && !GTFS_TIME.test(v)
}

/** 正しい時刻だが、HH:MM:SS とそろっていない(時が1桁、前後の空白) */
function isVariantTime(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const v = raw.trim()
  if (v === '' || !GTFS_TIME.test(v)) return false
  return ONE_DIGIT_HOUR.test(v) || v !== raw
}

/** 正しい時刻を、サービス日の 0:00 からの秒数にする(24時を超えてよい)。空と正しくない時刻は null */
function timeSeconds(raw: string | undefined): number | null {
  const v = trimmed(raw)
  if (!GTFS_TIME.test(v)) return null
  const [h, m, sec] = v.split(':').map(Number)
  return h * 3600 + m * 60 + sec
}

/** 便の最初か最後の停留所で、arrival_time か departure_time が空(GTFS では最初と最後の停留所の時刻は必須) */
function hasBlankEndpoint(sorted: readonly GtfsRow[]): boolean {
  if (sorted.length === 0) return false
  const ends = [sorted[0], sorted[sorted.length - 1]]
  return ends.some((r) => TIME_FIELDS.some((f) => trimmed(r[f]) === ''))
}

/**
 * stop_sequence の順に見て、時刻が戻る便。同じ行で departure_time が arrival_time より早いか、
 * 行の時刻が前の停留所の時刻より早い。空(通過)と正しくない時刻(badTimeFormat で数える)は飛ばす
 */
function hasDecreasingTime(sorted: readonly GtfsRow[]): boolean {
  let prev: number | null = null
  for (const r of sorted) {
    const arrival = timeSeconds(r.arrival_time)
    const departure = timeSeconds(r.departure_time)
    if (arrival !== null && departure !== null && departure < arrival) return true
    const first = arrival ?? departure
    if (first !== null && prev !== null && first < prev) return true
    const last = departure ?? arrival
    if (last !== null) prev = last
  }
  return false
}

// ---- stop_sequence ----

const NON_NEGATIVE_INTEGER = /^\d+$/

/** 便の stop_sequence が、読めない値か、同じ値の行を含む(増えていかない) */
function hasBadSequence(rows: readonly GtfsRow[]): boolean {
  const seen = new Set<string>()
  for (const r of rows) {
    const s = trimmed(r.stop_sequence)
    if (!NON_NEGATIVE_INTEGER.test(s)) return true
    // 先頭の 0 を除いて数として比べる('01' と '1' は同じ値)
    const key = s.replace(/^0+(?=\d)/, '')
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

// ---- calendar の曜日 ----

const WEEKDAY_FIELDS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

// ---- 必須ファイル ----

const REQUIRED_TABLES = ['agency', 'stops', 'routes', 'trips', 'stop_times', 'feed_info'] as const

/** 規則に当たる calendar_dates の行のキー */
function calendarDateKey(r: GtfsRow): string {
  return `${trimmed(r.service_id)} ${trimmed(r.date)}`
}

/**
 * error の規則(基準にも当てる)。
 * - requiredFileMissing:agency・stops・routes・trips・stop_times・feed_info と、calendar か calendar_dates のどちらか
 * - badCalendarDate:calendar_dates の date が正しい日付でない、exception_type が 1・2 以外
 * - badTimeFormat:arrival_time・departure_time が HH:MM:SS(時は1桁も可、24時を超えてよい)でない
 * - stopSequenceNotIncreasing:便の stop_sequence に、0 以上の整数でない値か、同じ値がある
 * - stopTimesEndpointBlank:便の最初か最後の停留所(stop_sequence の順)で、arrival_time か departure_time が空
 * - stopTimesDecreasing:stop_sequence の順に見て、時刻が戻る(空の時刻は飛ばして比べる)
 * - badCalendarWeekday:calendar の monday〜sunday が 0・1 以外
 *
 * stopTimesEndpointBlank・stopTimesDecreasing は、stop_sequence の読めない便(stopSequenceNotIncreasing)では見ない。
 * 並びが決まらず、同じ便を二重に数えるため
 */
export const FEED_ERROR_RULES: StructuralRule[] = [
  {
    code: 'requiredFileMissing',
    file: '',
    message: (n) => `GTFS-JP で必須のファイルがありません(${n} 件)。`,
    targets: (feed) => {
      const out = new Set<string>()
      for (const name of REQUIRED_TABLES) if (!feed.tables.has(name)) out.add(`${name}.txt`)
      if (!feed.tables.has('calendar') && !feed.tables.has('calendar_dates')) out.add('calendar.txt または calendar_dates.txt')
      return out
    },
  },
  {
    code: 'badCalendarDate',
    file: 'calendar_dates.txt',
    message: (n) => `calendar_dates.txt に、date が正しい日付(YYYYMMDD)でないか、exception_type が 1・2 以外の行があります(${n} 件)。`,
    targets: (feed) => {
      const out = new Set<string>()
      for (const r of rowsOf(feed, 'calendar_dates')) {
        const type = trimmed(r.exception_type)
        if (!isValidGtfsDate(trimmed(r.date)) || (type !== '1' && type !== '2')) out.add(calendarDateKey(r))
      }
      return out
    },
  },
  {
    code: 'badTimeFormat',
    file: 'stop_times.txt',
    tripTargets: true,
    message: (n) => `stop_times.txt に、arrival_time・departure_time が HH:MM:SS の形でない便があります(${n} 便)。`,
    targets: (feed) => {
      const out = new Set<string>()
      for (const r of rowsOf(feed, 'stop_times')) {
        if (TIME_FIELDS.some((f) => isBadTime(r[f]))) out.add(trimmed(r.trip_id))
      }
      return out
    },
  },
  {
    code: 'stopSequenceNotIncreasing',
    file: 'stop_times.txt',
    tripTargets: true,
    message: (n) =>
      `stop_times.txt の stop_sequence が便の中で増えていかない便があります(0 以上の整数でない値か、同じ値の行がある。${n} 便)。`,
    targets: (feed) => {
      const out = new Set<string>()
      for (const [tripId, rows] of stopTimeGroups(feed)) if (hasBadSequence(rows)) out.add(tripId)
      return out
    },
  },
  {
    code: 'stopTimesEndpointBlank',
    file: 'stop_times.txt',
    tripTargets: true,
    message: (n) => `stop_times.txt で、最初か最後の停留所の arrival_time・departure_time が空の便があります(最初と最後の停留所の時刻は必須。${n} 便)。`,
    targets: (feed) => {
      const out = new Set<string>()
      for (const [tripId, rows] of stopTimeGroups(feed)) {
        if (!hasBadSequence(rows) && hasBlankEndpoint(sortByStopSequence(rows))) out.add(tripId)
      }
      return out
    },
  },
  {
    code: 'stopTimesDecreasing',
    file: 'stop_times.txt',
    tripTargets: true,
    message: (n) => `stop_times.txt で、stop_sequence の順に時刻が戻る便があります(前の停留所より早い時刻、発車が到着より早いなど。${n} 便)。`,
    targets: (feed) => {
      const out = new Set<string>()
      for (const [tripId, rows] of stopTimeGroups(feed)) {
        if (!hasBadSequence(rows) && hasDecreasingTime(sortByStopSequence(rows))) out.add(tripId)
      }
      return out
    },
  },
  {
    code: 'badCalendarWeekday',
    file: 'calendar.txt',
    message: (n) => `calendar.txt に、monday〜sunday が 0・1 以外の行があります(${n} 件)。`,
    targets: (feed) => {
      const out = new Set<string>()
      for (const r of rowsOf(feed, 'calendar')) {
        if (WEEKDAY_FIELDS.some((f) => trimmed(r[f]) !== '0' && trimmed(r[f]) !== '1')) out.add(trimmed(r.service_id))
      }
      return out
    },
  },
]

// ---- 基準と編集後を比べる規則、warning・info ----

/** 基準の表の id のうち、編集後の表に無いもの */
function missingIds(base: GtfsFeed, edited: GtfsFeed, table: string, field: string): string[] {
  const after = new Set(rowsOf(edited, table).map((r) => trimmed(r[field])))
  const lost = new Set<string>()
  for (const r of rowsOf(base, table)) {
    const id = trimmed(r[field])
    if (!after.has(id)) lost.add(id)
  }
  return [...lost].sort(compareStrings)
}

function idChangedIssues(base: GtfsFeed, edited: GtfsFeed): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const checks = [
    { code: 'stopIdChanged', table: 'stops', field: 'stop_id' },
    { code: 'routeIdChanged', table: 'routes', field: 'route_id' },
  ]
  for (const c of checks) {
    const lost = missingIds(base, edited, c.table, c.field)
    if (lost.length === 0) continue
    issues.push({
      severity: 'error',
      code: c.code,
      file: `${c.table}.txt`,
      message: `入力の ${c.table}.txt にある ${c.field} が、出力の ${c.table}.txt にありません(${lost.length} 件)。${c.field} を変えると、経路検索やほかのデータとのつながりが切れます。`,
      count: lost.length,
      examples: lost.slice(0, MAX_EXAMPLES),
    })
  }
  return issues
}

function feedInfoRowsIssue(edited: GtfsFeed): ValidationIssue | null {
  const table = edited.tables.get('feed_info')
  if (!table || table.rows.length === 1) return null
  return {
    severity: 'warning',
    code: 'feedInfoRows',
    file: 'feed_info.txt',
    message: `feed_info.txt の行が ${table.rows.length} 行です。GTFS-JP では1行にします${table.rows.length > 1 ? '(Dispatcher は1行目だけを書き換えています)' : ''}。`,
    count: table.rows.length,
    examples: [],
  }
}

/**
 * 入力の calendar・calendar_dates のうち、入力の feed_info の有効期間の外にある日(§13)。
 * 出力は feed_info の有効期間をもとに切り詰めるので、その日は出力に含まれない。feed_info の日付が無い入力では見ない
 */
function calendarBeyondFeedInfoIssue(base: GtfsFeed): ValidationIssue | null {
  const info = rowsOf(base, 'feed_info')[0]
  const start = trimmed(info?.feed_start_date)
  const end = trimmed(info?.feed_end_date)
  if (!isValidGtfsDate(start) || !isValidGtfsDate(end) || start > end) return null
  const targets = new Set<string>()
  for (const r of rowsOf(base, 'calendar')) {
    const s = trimmed(r.start_date)
    const e = trimmed(r.end_date)
    if (!isValidGtfsDate(s) || !isValidGtfsDate(e) || s > e) continue
    if (s < start || e > end) targets.add(`${trimmed(r.service_id)} ${s}〜${e}`)
  }
  for (const r of rowsOf(base, 'calendar_dates')) {
    const d = trimmed(r.date)
    if (isValidGtfsDate(d) && (d < start || d > end)) targets.add(calendarDateKey(r))
  }
  if (targets.size === 0) return null
  return {
    severity: 'warning',
    code: 'calendarBeyondFeedInfo',
    file: 'calendar.txt',
    message: `入力の calendar.txt・calendar_dates.txt に、入力の feed_info.txt の有効期間(${formatDate(start)}〜${formatDate(end)})の外の日があります(${targets.size} 件)。出力は feed_info の有効期間で切り詰めるため、その日は出力に含まれません。`,
    count: targets.size,
    examples: examplesOf(targets),
  }
}

/** 出力の calendar・calendar_dates のうち、出力の feed_info の有効期間の外にある行(Skill の規則5) */
function calendarOutsideValidityIssue(edited: GtfsFeed): ValidationIssue | null {
  const info = rowsOf(edited, 'feed_info')[0]
  const start = trimmed(info?.feed_start_date)
  const end = trimmed(info?.feed_end_date)
  if (!isValidGtfsDate(start) || !isValidGtfsDate(end) || start > end) return null
  const targets = new Set<string>()
  for (const r of rowsOf(edited, 'calendar')) {
    const s = trimmed(r.start_date)
    const e = trimmed(r.end_date)
    if ((isValidGtfsDate(s) && s < start) || (isValidGtfsDate(e) && e > end)) targets.add(trimmed(r.service_id))
  }
  for (const r of rowsOf(edited, 'calendar_dates')) {
    const d = trimmed(r.date)
    if (isValidGtfsDate(d) && (d < start || d > end)) targets.add(calendarDateKey(r))
  }
  if (targets.size === 0) return null
  return {
    severity: 'warning',
    code: 'calendarOutsideValidity',
    file: 'calendar.txt',
    message: `出力の calendar.txt・calendar_dates.txt に、出力の有効期間(feed_info.txt の ${formatDate(start)}〜${formatDate(end)})の外の日付があります(${targets.size} 件)。`,
    count: targets.size,
    examples: examplesOf(targets),
  }
}

/** 時刻の書き方の違い(時が1桁、前後の空白)。署名は時刻を文字列で比べるので、同じ時刻でも別の便になる(§12.2) */
function timeFormatVariantIssue(edited: GtfsFeed): ValidationIssue | null {
  const trips = new Set<string>()
  for (const r of rowsOf(edited, 'stop_times')) {
    if (TIME_FIELDS.some((f) => isVariantTime(r[f]))) trips.add(trimmed(r.trip_id))
  }
  if (trips.size === 0) return null
  return {
    severity: 'warning',
    code: 'timeFormatVariant',
    file: 'stop_times.txt',
    message: `stop_times.txt に、時刻の書き方が HH:MM:SS とそろっていない便があります(時が1桁、前後の空白など。${trips.size} 便)。前後の比較と、便を平日に戻す処理では、時刻を文字列で比べるため、同じ時刻でも別の便として扱います。`,
    count: trips.size,
    examples: examplesOf(trips),
  }
}

/** 署名が同じ便どうしで比べる列(乗降の区分は空なら 0) */
function tripAttributes(trip: GtfsRow, rows: readonly GtfsRow[]): Record<string, string> {
  const sorted = sortByStopSequence(rows)
  const orZero = (v: string | undefined) => trimmed(v) || '0'
  return {
    trip_headsign: trimmed(trip.trip_headsign),
    direction_id: trimmed(trip.direction_id),
    stop_headsign: sorted.map((r) => trimmed(r.stop_headsign)).join('\u001f'),
    pickup_type: sorted.map((r) => orZero(r.pickup_type)).join('\u001f'),
    drop_off_type: sorted.map((r) => orZero(r.drop_off_type)).join('\u001f'),
  }
}

const ATTRIBUTE_FIELDS = ['trip_headsign', 'direction_id', 'stop_headsign', 'pickup_type', 'drop_off_type'] as const

/**
 * 編集後の平日便のうち、入力の平日便と署名(停留所・時刻)が同じなのに、行き先・方向・乗降の区分が違う便(§12.2)。
 * 前後の比較と足し戻しでは同じ便として扱うので、warning で知らせる
 */
function signatureColumnMismatchIssue(base: GtfsFeed, result: Form2Result): ValidationIssue | null {
  // 期間に走らないため組ごと除いた service は出力に便が無いので、並べない(activeWeekdayServicesOf)
  const weekdays = activeWeekdayServicesOf(result)
  const baseGroups = stopTimeGroups(base)
  const bySignature = new Map<string, Record<string, string>[]>()
  for (const t of rowsOf(base, 'trips')) {
    if (!weekdays.has(trimmed(t.service_id))) continue
    const rows = baseGroups.get(trimmed(t.trip_id)) ?? []
    const sig = tripSignature(trimmed(t.route_id), rows)
    const list = bySignature.get(sig)
    const attrs = tripAttributes(t, rows)
    if (list) list.push(attrs)
    else bySignature.set(sig, [attrs])
  }
  if (bySignature.size === 0) return null

  const editedGroups = stopTimeGroups(result.feed)
  const mismatched: string[] = []
  const fieldCounts = new Map<string, number>()
  for (const t of rowsOf(result.feed, 'trips')) {
    if (!weekdays.has(trimmed(t.service_id))) continue
    const id = trimmed(t.trip_id)
    const rows = editedGroups.get(id) ?? []
    const candidates = bySignature.get(tripSignature(trimmed(t.route_id), rows))
    if (!candidates) continue
    const attrs = tripAttributes(t, rows)
    // いちばん近い入力の便(違う列がいちばん少ない便)と比べる。同じ列の便があれば一致
    let best: string[] | null = null
    for (const c of candidates) {
      const diff = ATTRIBUTE_FIELDS.filter((f) => c[f] !== attrs[f])
      if (best === null || diff.length < best.length) best = diff
      if (diff.length === 0) break
    }
    if (best === null || best.length === 0) continue
    mismatched.push(id)
    for (const f of best) fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1)
  }
  if (mismatched.length === 0) return null
  const detail = ATTRIBUTE_FIELDS.filter((f) => fieldCounts.has(f))
    .map((f) => `${f} ${fieldCounts.get(f)} 便`)
    .join('、')
  return {
    severity: 'warning',
    code: 'signatureColumnMismatch',
    file: 'trips.txt',
    message: `平日ダイヤ(${[...weekdays].join('・')})の便のうち ${mismatched.length} 便は、入力の平日便と停留所・時刻が同じですが、行き先か乗降の扱いが違います(${detail})。前後の比較と、便を平日に戻す処理では、同じ便として扱います。行き先・乗降の扱いを確かめてください。`,
    count: mismatched.length,
    examples: examplesOf(mismatched),
  }
}

/** 停留所(location_type が空か 0)の stop_id。駅・出入口などは stop_times に出てこないので数えない */
function boardingStopIds(feed: GtfsFeed): string[] {
  return rowsOf(feed, 'stops')
    .filter((s) => {
      const type = trimmed(s.location_type)
      return type === '' || type === '0'
    })
    .map((s) => trimmed(s.stop_id))
}

/**
 * 編集で使われなくなる系統・停留所(§13)。入力では便があり(stop_times に出てきて)、出力では無いもの。
 * 入力の時点で使われていないものは数えない
 */
function unusedIssues(base: GtfsFeed, edited: GtfsFeed): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const routesWithTrips = (feed: GtfsFeed) => new Set(rowsOf(feed, 'trips').map((t) => trimmed(t.route_id)))
  const baseRoutes = routesWithTrips(base)
  const editedRoutes = routesWithTrips(edited)
  const lostRoutes = [...new Set(rowsOf(edited, 'routes').map((r) => trimmed(r.route_id)))]
    .filter((id) => baseRoutes.has(id) && !editedRoutes.has(id))
    .sort(compareStrings)
  if (lostRoutes.length > 0) {
    issues.push({
      severity: 'info',
      code: 'unusedRoutes',
      file: 'routes.txt',
      message: `出力では便が1つもなくなる系統が ${lostRoutes.length} 系統あります(入力では便があった系統)。routes.txt には残します。`,
      count: lostRoutes.length,
      examples: lostRoutes.slice(0, MAX_EXAMPLES),
    })
  }

  const usedStops = (feed: GtfsFeed) => new Set(rowsOf(feed, 'stop_times').map((r) => trimmed(r.stop_id)))
  const baseStops = usedStops(base)
  const editedStops = usedStops(edited)
  const lostStops = [...new Set(boardingStopIds(edited))].filter((id) => baseStops.has(id) && !editedStops.has(id)).sort(compareStrings)
  if (lostStops.length > 0) {
    issues.push({
      severity: 'info',
      code: 'unusedStops',
      file: 'stops.txt',
      message: `出力では stop_times に1度も出てこない停留所が ${lostStops.length} か所あります(入力では便が止まっていた停留所)。stops.txt には残します。`,
      count: lostStops.length,
      examples: lostStops.slice(0, MAX_EXAMPLES),
    })
  }
  return issues
}

/**
 * 基準と編集後を比べる規則と、warning・info の規則。
 * error:stopIdChanged・routeIdChanged。warning:feedInfoRows・calendarBeyondFeedInfo・calendarOutsideValidity・
 * timeFormatVariant・signatureColumnMismatch。info:unusedRoutes・unusedStops
 */
export function feedIssues(base: GtfsFeed, result: Form2Result): ValidationIssue[] {
  const edited = result.feed
  const issues: ValidationIssue[] = [...idChangedIssues(base, edited)]
  for (const issue of [
    feedInfoRowsIssue(edited),
    calendarBeyondFeedInfoIssue(base),
    calendarOutsideValidityIssue(edited),
    timeFormatVariantIssue(edited),
    signatureColumnMismatchIssue(base, result),
  ]) {
    if (issue) issues.push(issue)
  }
  issues.push(...unusedIssues(base, edited))
  return issues
}
