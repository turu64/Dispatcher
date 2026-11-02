import type { GtfsFeed, GtfsRow } from './load'

/**
 * 運行日の判定(calendar.txt と calendar_dates.txt)。
 *
 * 日付は 'YYYYMMDD' の文字列で扱う。曜日や日付の計算は、年月日の数字から整数の計算だけで行い、
 * Date の文字列解析やローカル時刻には頼らない(タイムゾーンや 2 桁の年の解釈に左右されないため)。
 */

/** GTFS の曜日の列(月曜始まり。weekdayIndex の値と同じ順) */
const WEEKDAY_COLUMNS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/

interface YMD {
  y: number
  m: number
  d: number
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

function parseYmd(s: string): YMD | null {
  const match = DATE_PATTERN.exec(s)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return { y, m, d }
}

function requireYmd(date: string): YMD {
  const ymd = parseYmd(date)
  if (!ymd) throw new Error(`日付の形が正しくありません(${JSON.stringify(date)})。YYYYMMDD の8桁で、実在する日付を指定してください。`)
  return ymd
}

/** 1970-01-01 からの日数(先発グレゴリオ暦。Howard Hinnant の days_from_civil) */
function daysFromCivil({ y, m, d }: YMD): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** daysFromCivil の逆 */
function civilFromDays(z: number): YMD {
  const zz = z + 719468
  const era = Math.floor(zz / 146097)
  const doe = zz - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d }
}

/** 'YYYYMMDD' の8桁で、実在する日付なら true。前後の空白は許さない(呼ぶ側で取る) */
export function isValidGtfsDate(s: string): boolean {
  return parseYmd(s) !== null
}

/** 'YYYYMMDD' を n 日ずらす(n は負でもよい)。月末・年末・うるう年をまたいでよい */
export function addDays(date: string, n: number): string {
  if (!Number.isInteger(n)) throw new Error(`ずらす日数は整数で指定してください(${n})。`)
  const { y, m, d } = civilFromDays(daysFromCivil(requireYmd(date)) + n)
  if (y < 0 || y > 9999) throw new Error(`日付が範囲外になります(${date} から ${n} 日)。`)
  return `${String(y).padStart(4, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`
}

/** 曜日。0=月曜 … 6=日曜(GTFS の calendar.txt の列の順) */
export function weekdayIndex(date: string): number {
  // 1970-01-01 は木曜(3)
  const days = daysFromCivil(requireYmd(date))
  return (((days + 3) % 7) + 7) % 7
}

/** 照合に使う値(前後の空白を取る)。列が無い行は空文字にする */
function cell(row: GtfsRow, column: string): string {
  return row[column]?.trim() ?? ''
}

function rowsOf(feed: GtfsFeed, name: 'calendar' | 'calendar_dates'): GtfsRow[] {
  return feed.tables.get(name)?.rows ?? []
}

/** 削除の照合に使うキー(service_id と日付の組)。日付は8桁なので、区切りの後ろは常に日付になる */
function removalKey(serviceId: string, date: string): string {
  return `${serviceId}\u0000${date}`
}

/**
 * calendar.txt の1行が、start〜end のうち少なくとも1日、運行日を生むか。
 * 曜日の列が当たり、削除(removed)で消えていない日があれば true。
 * 曜日の列が1つでも 1 なら7日以内に当たるので、削除が無ければ数日で抜ける。
 */
function hasCalendarServiceDay(row: GtfsRow, serviceId: string, start: string, end: string, removed: Set<string>): boolean {
  let weekday = weekdayIndex(start)
  for (let d = start; ; d = addDays(d, 1)) {
    if (cell(row, WEEKDAY_COLUMNS[weekday]) === '1' && !removed.has(removalKey(serviceId, d))) return true
    // 最後の日の次は求めない(end が 99991231 のとき addDays が範囲外のエラーになるため)
    if (d === end) return false
    weekday = (weekday + 1) % 7
  }
}

/**
 * その日に運行する service_id の集合(キーは前後の空白を取った値)。
 *
 * - calendar.txt:曜日の列が 1 で、start_date <= date <= end_date なら運行
 * - calendar_dates.txt:exception_type=1 は追加、2 は削除。calendar.txt より優先する。
 *   calendar.txt に無い service_id でも追加する(calendar_dates.txt だけのフィードも扱う)
 * - 同じ service_id・日付に 1 と 2 の両方がある(GTFS では誤り)ときは、行の順に関係なく削除を優先する。
 *   つまり (calendar ∪ 追加) − 削除
 * - 日付が不正な行、service_id が空の行は数えない(検証は別の段で行う)
 *
 * date が不正な日付ならエラーにする(画面の日付選択から来る値なので、不正なら呼ぶ側の誤り)。
 */
export function activeServiceIds(feed: GtfsFeed, date: string): Set<string> {
  const column = WEEKDAY_COLUMNS[weekdayIndex(date)]
  const active = new Set<string>()

  for (const row of rowsOf(feed, 'calendar')) {
    const serviceId = cell(row, 'service_id')
    if (!serviceId || cell(row, column) !== '1') continue
    const start = cell(row, 'start_date')
    const end = cell(row, 'end_date')
    if (!isValidGtfsDate(start) || !isValidGtfsDate(end)) continue
    // 8桁の日付は文字列のまま比べれば日付の前後と一致する
    if (start <= date && date <= end) active.add(serviceId)
  }

  const removed = new Set<string>()
  for (const row of rowsOf(feed, 'calendar_dates')) {
    const serviceId = cell(row, 'service_id')
    if (!serviceId || cell(row, 'date') !== date) continue
    const type = cell(row, 'exception_type')
    if (type === '1') active.add(serviceId)
    else if (type === '2') removed.add(serviceId)
  }
  for (const serviceId of removed) active.delete(serviceId)

  return active
}

/**
 * フィードの運行期間。calendar.txt の期間と、calendar_dates.txt の追加日(exception_type=1)の最小・最大。
 *
 * 運行日を少なくとも1日生む行・追加日だけを数える(activeServiceIds と同じ規則で判定する)。
 * 数えないのは、曜日の列がすべて 0 の行、start_date > end_date の行、日付が不正な行、
 * 曜日の列が期間の中の日に一度も当たらない行、運行日がすべて削除(exception_type=2)で消える行・追加日、
 * 削除の日付そのもの。運行日が1つも無ければ null。
 * calendar_dates.txt の削除で期間の端の日が運休になる場合も、ほかの日に運行があれば端はそのまま返す
 * (日ごとの判定は activeServiceIds で行う)。
 */
export function feedServicePeriod(feed: GtfsFeed): { start: string; end: string } | null {
  // 削除(service_id と日付の組)。activeServiceIds と同じく、行の順に関係なく追加より優先する
  const removed = new Set<string>()
  for (const row of rowsOf(feed, 'calendar_dates')) {
    const serviceId = cell(row, 'service_id')
    const date = cell(row, 'date')
    if (serviceId && cell(row, 'exception_type') === '2' && isValidGtfsDate(date)) removed.add(removalKey(serviceId, date))
  }

  const ranges: { start: string; end: string }[] = []

  for (const row of rowsOf(feed, 'calendar')) {
    const serviceId = cell(row, 'service_id')
    if (!serviceId) continue
    if (!WEEKDAY_COLUMNS.some((c) => cell(row, c) === '1')) continue
    const start = cell(row, 'start_date')
    const end = cell(row, 'end_date')
    if (!isValidGtfsDate(start) || !isValidGtfsDate(end) || start > end) continue
    if (hasCalendarServiceDay(row, serviceId, start, end, removed)) ranges.push({ start, end })
  }

  for (const row of rowsOf(feed, 'calendar_dates')) {
    const serviceId = cell(row, 'service_id')
    if (!serviceId || cell(row, 'exception_type') !== '1') continue
    const date = cell(row, 'date')
    if (isValidGtfsDate(date) && !removed.has(removalKey(serviceId, date))) ranges.push({ start: date, end: date })
  }

  if (ranges.length === 0) return null
  return ranges.reduce((acc, r) => ({
    start: r.start < acc.start ? r.start : acc.start,
    end: r.end > acc.end ? r.end : acc.end,
  }))
}
