import { addDays, isValidGtfsDate, weekdayIndex } from '../calendar'
import type { HolidayList } from '../holidays'
import type { GtfsFeed, GtfsRow } from '../load'
import { compareStrings, stopTimesByTrip, tripSignature } from './signature'

/**
 * service_id の役割の見分けと、有効期間・運行日の計算(取り決め 1104 §3・§5.6)。
 * 日付は 'YYYYMMDD'。運行日の規則は calendar.ts の activeServiceIds と同じ(calendar_dates の削除を優先)。
 */

export type ServiceRole = 'weekday' | 'saturday' | 'sunday' | 'saturdaySunday' | 'other'

export interface ServiceInfo {
  /** 空白を取った値 */
  serviceId: string
  role: ServiceRole
  /** calendar の曜日の列(月〜日)。calendar に行が無ければ null */
  days: boolean[] | null
  /** calendar_dates で、祝日一覧の祝日に追加(exception_type=1)される日がある。祝日一覧が無ければ null(判定できない) */
  addedOnHolidays: boolean | null
  tripCount: number
  calendarRange: { start: string; end: string } | null
}

export interface ServiceChoice {
  weekday: string | null
  saturday: string | null
  sundayHoliday: string | null
  /** 決められなかった理由(画面に出す)。決まったものには無い */
  notes: string[]
}

const WEEKDAY_COLUMNS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

function rowsOf(feed: GtfsFeed, name: string): GtfsRow[] {
  return feed.tables.get(name)?.rows ?? []
}

// ---- 日付 ----

/** 1970-01-01 からの日数(先発グレゴリオ暦)。日付は正しいものに限る */
export function dayNumber(date: string): number {
  if (!isValidGtfsDate(date)) throw new Error(`日付の形が正しくありません(${JSON.stringify(date)})。`)
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(4, 6))
  const d = Number(date.slice(6, 8))
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** start〜end の日数(両端を含む)。end が start より前なら 0 */
export function countDays(start: string, end: string): number {
  return Math.max(0, dayNumber(end) - dayNumber(start) + 1)
}

/** start〜end(両端を含む)の各日に fn を呼ぶ。weekday は 0=月曜 … 6=日曜。fn が true を返したら止める */
export function forEachDay(start: string, end: string, fn: (date: string, weekday: number) => boolean | void): void {
  if (start > end) return
  let weekday = weekdayIndex(start)
  for (let d = start; ; d = addDays(d, 1)) {
    if (fn(d, weekday) === true) return
    if (d === end) return
    weekday = (weekday + 1) % 7
  }
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b
}

function minDate(a: string, b: string): string {
  return a < b ? a : b
}

// ---- 有効期間(§5.6) ----

/**
 * 入力の有効期間。feed_info の1行目の feed_start_date・feed_end_date(空白を取って正しい日付なら)。
 * 無い端は参照実装(data/tools/form2_ref.py)に合わせ、開始は calendar の start_date と calendar_dates の date の最小、
 * 末日は calendar の end_date と calendar_dates の date の最大(どちらも正しい日付だけ)。start_date と end_date を
 * 1つにまとめないのは、start_date > end_date の行があると、その start_date が末日になってしまうため。
 * feedServicePeriod(運行日を生まない行を数えない)とは別のもの。決められなければ null
 */
export function feedValidity(feed: GtfsFeed): { start: string; end: string } | null {
  const info = rowsOf(feed, 'feed_info')[0]
  let start = info ? trimmed(info.feed_start_date) : ''
  let end = info ? trimmed(info.feed_end_date) : ''
  if (!isValidGtfsDate(start)) start = ''
  if (!isValidGtfsDate(end)) end = ''
  if (start === '' || end === '') {
    const starts: string[] = []
    const ends: string[] = []
    for (const row of rowsOf(feed, 'calendar')) {
      starts.push(trimmed(row.start_date))
      ends.push(trimmed(row.end_date))
    }
    for (const row of rowsOf(feed, 'calendar_dates')) {
      const date = trimmed(row.date)
      starts.push(date)
      ends.push(date)
    }
    const validStarts = starts.filter(isValidGtfsDate)
    const validEnds = ends.filter(isValidGtfsDate)
    if (start === '' && validStarts.length > 0) start = validStarts.reduce(minDate)
    if (end === '' && validEnds.length > 0) end = validEnds.reduce(maxDate)
  }
  return start !== '' && end !== '' ? { start, end } : null
}

/**
 * 方針の期間から作る新しい有効期間。開始 = max(入力の開始日, period.start)、
 * 終わり = period.end が null なら入力の末日、そうでなければ min(入力の末日, period.end)。
 * 開始が終わりより後(空)なら null。期間の日付は正しいものに限る
 */
export function policyValidity(
  input: { start: string; end: string },
  period: { start: string; end: string | null },
): { start: string; end: string; days: number } | null {
  const start = maxDate(input.start, period.start)
  const end = period.end === null ? input.end : minDate(input.end, period.end)
  if (start > end) return null
  return { start, end, days: countDays(start, end) }
}

// ---- 運行日 ----

/** 1つの service の運行日の材料(calendar の行と calendar_dates の追加・削除) */
export interface ServiceDays {
  calendar: { days: boolean[]; start: string; end: string }[]
  added: Set<string>
  removed: Set<string>
}

function emptyServiceDays(): ServiceDays {
  return { calendar: [], added: new Set(), removed: new Set() }
}

/**
 * service_id(空白を取った値)ごとの運行日の材料。calendar の日付が不正な行は運行日を生まないので入れない
 * (activeServiceIds と同じ)。calendar_dates は exception_type が '1'・'2' の行だけ
 */
export function indexServiceDays(
  calendarRows: readonly GtfsRow[],
  calendarDateRows: readonly GtfsRow[],
): Map<string, ServiceDays> {
  const index = new Map<string, ServiceDays>()
  const get = (id: string) => {
    let sd = index.get(id)
    if (!sd) {
      sd = emptyServiceDays()
      index.set(id, sd)
    }
    return sd
  }
  for (const row of calendarRows) {
    const id = trimmed(row.service_id)
    if (id === '') continue
    const sd = get(id)
    const start = trimmed(row.start_date)
    const end = trimmed(row.end_date)
    if (!isValidGtfsDate(start) || !isValidGtfsDate(end)) continue
    sd.calendar.push({ days: WEEKDAY_COLUMNS.map((c) => trimmed(row[c]) === '1'), start, end })
  }
  for (const row of calendarDateRows) {
    const id = trimmed(row.service_id)
    if (id === '') continue
    const sd = get(id)
    const date = trimmed(row.date)
    const type = trimmed(row.exception_type)
    if (type === '1') sd.added.add(date)
    else if (type === '2') sd.removed.add(date)
  }
  return index
}

export function indexFeedServiceDays(feed: GtfsFeed): Map<string, ServiceDays> {
  return indexServiceDays(rowsOf(feed, 'calendar'), rowsOf(feed, 'calendar_dates'))
}

/** その日に走るか(activeServiceIds と同じ規則:(calendar ∪ 追加) − 削除) */
export function runsOn(sd: ServiceDays | undefined, date: string, weekday: number): boolean {
  if (!sd || sd.removed.has(date)) return false
  if (sd.added.has(date)) return true
  return sd.calendar.some((c) => c.days[weekday] && c.start <= date && date <= c.end)
}

/** start〜end(両端を含む)のうち、sd の service が走る日の数 */
export function countRunningDays(sd: ServiceDays | undefined, start: string, end: string): number {
  if (!sd) return 0
  let n = 0
  forEachDay(start, end, (date, weekday) => {
    if (runsOn(sd, date, weekday)) n++
  })
  return n
}

/** start〜end の中で1日でも走るか(見つかったところで止める) */
export function runsAnyDay(sd: ServiceDays | undefined, start: string, end: string): boolean {
  if (!sd) return false
  let found = false
  forEachDay(start, end, (date, weekday) => {
    found = runsOn(sd, date, weekday)
    return found
  })
  return found
}

/** その service が start〜end(両端を含む)の中で走る日(activeServiceIds に入る日)の数 */
export function activeDaysIn(feed: GtfsFeed, serviceId: string, start: string, end: string): number {
  if (!isValidGtfsDate(start) || !isValidGtfsDate(end) || start > end) return 0
  return countRunningDays(indexFeedServiceDays(feed).get(serviceId.trim()), start, end)
}

// ---- 役割 ----

function roleOf(days: boolean[] | null): ServiceRole {
  if (!days) return 'other'
  const mf = days.slice(0, 5)
  const [sat, sun] = [days[5], days[6]]
  if (mf.every(Boolean) && !sat && !sun) return 'weekday'
  if (mf.every((d) => !d)) {
    if (sat && !sun) return 'saturday'
    if (!sat && sun) return 'sunday'
    if (sat && sun) return 'saturdaySunday'
  }
  return 'other'
}

/** service_id ごとの役割と材料(service_id の昇順)。calendar・calendar_dates・trips のどれかに出てくる service を並べる */
export function describeServices(feed: GtfsFeed, holidays: HolidayList | null): ServiceInfo[] {
  const firstCalendar = new Map<string, GtfsRow>()
  for (const row of rowsOf(feed, 'calendar')) {
    const id = trimmed(row.service_id)
    if (id !== '' && !firstCalendar.has(id)) firstCalendar.set(id, row)
  }
  const added = new Map<string, Set<string>>()
  for (const row of rowsOf(feed, 'calendar_dates')) {
    const id = trimmed(row.service_id)
    if (id === '') continue
    let set = added.get(id)
    if (!set) added.set(id, (set = new Set()))
    if (trimmed(row.exception_type) === '1') set.add(trimmed(row.date))
  }
  const tripCounts = new Map<string, number>()
  for (const row of rowsOf(feed, 'trips')) {
    const id = trimmed(row.service_id)
    if (id !== '') tripCounts.set(id, (tripCounts.get(id) ?? 0) + 1)
  }

  const ids = new Set<string>([...firstCalendar.keys(), ...added.keys(), ...tripCounts.keys()])
  return [...ids].sort(compareStrings).map((serviceId) => {
    const row = firstCalendar.get(serviceId)
    const days = row ? WEEKDAY_COLUMNS.map((c) => trimmed(row[c]) === '1') : null
    const addedDates = added.get(serviceId)
    return {
      serviceId,
      role: roleOf(days),
      days,
      addedOnHolidays: holidays === null ? null : [...(addedDates ?? [])].some((d) => holidays.names.has(d)),
      tripCount: tripCounts.get(serviceId) ?? 0,
      calendarRange: row ? { start: trimmed(row.start_date), end: trimmed(row.end_date) } : null,
    }
  })
}

const ROLE_LABELS: Record<ServiceRole, string> = {
  weekday: '平日(月〜金)',
  saturday: '土曜',
  sunday: '日曜',
  saturdaySunday: '土休日(土・日)',
  other: 'その他',
}

/**
 * 方針に使う service の推定。便が1本以上あり、新しい有効期間(validity)の中で1日以上走る service だけを候補にする。
 * 決まらなければ null にし、理由を notes に入れる(利用者に選ばせる)
 */
export function guessServiceChoice(
  feed: GtfsFeed,
  services: readonly ServiceInfo[],
  validity: { start: string; end: string },
): ServiceChoice {
  const index = indexFeedServiceDays(feed)
  const candidates = services.filter(
    (s) => s.tripCount > 0 && runsAnyDay(index.get(s.serviceId), validity.start, validity.end),
  )
  const byRole = (role: ServiceRole) => candidates.filter((s) => s.role === role)
  const notes: string[] = []
  const many = (label: string, list: readonly ServiceInfo[]) =>
    `${label}の service が ${list.length} 個(${list.map((s) => s.serviceId).join('、')})あるため、決められません。選んでください。`

  let weekday: string | null = null
  const weekdays = byRole('weekday')
  if (weekdays.length === 1) weekday = weekdays[0].serviceId
  else if (weekdays.length === 0) notes.push(`${ROLE_LABELS.weekday}のダイヤの service が見つかりません。選んでください。`)
  else notes.push(many(`${ROLE_LABELS.weekday}のダイヤ`, weekdays))

  const both = byRole('saturdaySunday')
  let saturday: string | null = null
  const saturdays = byRole('saturday')
  if (saturdays.length === 1) saturday = saturdays[0].serviceId
  else if (saturdays.length > 1) notes.push(many('土曜のダイヤ', saturdays))
  else if (both.length === 1) saturday = both[0].serviceId
  else if (both.length > 1) notes.push(many(`${ROLE_LABELS.saturdaySunday}のダイヤ`, both))
  else notes.push('土曜のダイヤの service が見つかりません。選んでください。')

  let sundayHoliday: string | null = null
  const sundays = byRole('sunday')
  if (sundays.length === 1) sundayHoliday = sundays[0].serviceId
  else if (sundays.length > 1) {
    if (sundays.some((s) => s.addedOnHolidays === null)) {
      notes.push('祝日一覧を読めないため、日祝のダイヤを決められません')
    } else {
      const onHolidays = sundays.filter((s) => s.addedOnHolidays === true)
      if (onHolidays.length === 1) sundayHoliday = onHolidays[0].serviceId
      else notes.push(many('日曜のダイヤ', sundays))
    }
  } else if (both.length === 1) sundayHoliday = both[0].serviceId
  else if (both.length > 1) notes.push(many(`${ROLE_LABELS.saturdaySunday}のダイヤ`, both))
  else notes.push('日祝のダイヤの service が見つかりません。選んでください。')

  return { weekday, saturday, sundayHoliday, notes }
}

/** その service の便の署名(並べ替えたもの) */
function sortedSignatures(feed: GtfsFeed, serviceId: string, groups: Map<string, GtfsRow[]>): string[] {
  const id = serviceId.trim()
  return rowsOf(feed, 'trips')
    .filter((t) => trimmed(t.service_id) === id)
    .map((t) => tripSignature(trimmed(t.route_id), groups.get(trimmed(t.trip_id)) ?? []))
    .sort(compareStrings)
}

/** 2つの service の便が、署名(§5.1)の多重集合として同じか(道北バスの 03 と 06 は同じ) */
export function sameTimetable(feed: GtfsFeed, a: string, b: string): boolean {
  const groups = stopTimesByTrip(rowsOf(feed, 'stop_times'))
  const sa = sortedSignatures(feed, a, groups)
  const sb = sortedSignatures(feed, b, groups)
  return sa.length === sb.length && sa.every((s, i) => s === sb[i])
}
