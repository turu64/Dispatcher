/**
 * 祝日一覧(内閣府「国民の祝日について」の syukujitsu.csv を data/ で JSON にしたもの)。
 *
 * サーバーの GET /api/holidays から読む。形は docs/interfaces-1104.md の §2。
 * 日付は 'YYYYMMDD' の文字列で扱い、比べるときは文字列の順(日付の順と同じ)を使う。
 */
import { addDays, isValidGtfsDate } from './calendar'

export interface HolidayList {
  /** キーは 'YYYYMMDD'、値は名称 */
  names: Map<string, string>
  /** 収録の最初の日(最初の祝日) */
  first: string
  /** この日までは祝日を判定できる(最後の祝日の年の 12月31日。内閣府は翌年の祝日を 1 年分まとめて載せる) */
  coveredUntil: string
  /** 画面の「データの出典」に出す文 */
  source: string
}

const SHAPE_ERROR = '祝日一覧の形が違います'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireDate(v: unknown, what: string): string {
  if (typeof v !== 'string' || !isValidGtfsDate(v)) {
    throw new Error(`${SHAPE_ERROR}(${what}が YYYYMMDD の実在する日付ではありません:${JSON.stringify(v)})。`)
  }
  return v
}

/**
 * サーバーが返す JSON を読む。形が違えば日本語のエラーを投げる。
 * 祝日の日付が収録の範囲(first〜coveredUntil)の外にあるもの、同じ日付の重複も形の違いとして止める。
 */
export function parseHolidayJson(json: unknown): HolidayList {
  if (!isRecord(json)) throw new Error(`${SHAPE_ERROR}(JSON のオブジェクトではありません)。`)
  const { source, first, coveredUntil, holidays } = json
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error(`${SHAPE_ERROR}(source が文字列ではありません)。`)
  }
  const firstDate = requireDate(first, 'first')
  const coveredDate = requireDate(coveredUntil, 'coveredUntil')
  if (firstDate > coveredDate) {
    throw new Error(`${SHAPE_ERROR}(first ${firstDate} が coveredUntil ${coveredDate} より後です)。`)
  }
  if (!Array.isArray(holidays)) throw new Error(`${SHAPE_ERROR}(holidays が配列ではありません)。`)

  const entries: [string, string][] = []
  holidays.forEach((item: unknown, i) => {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[1] !== 'string') {
      throw new Error(`${SHAPE_ERROR}(holidays の ${i + 1} 件目が [日付, 名称] ではありません)。`)
    }
    const date = requireDate(item[0], `holidays の ${i + 1} 件目の日付`)
    if (date < firstDate || date > coveredDate) {
      throw new Error(`${SHAPE_ERROR}(holidays の ${i + 1} 件目の日付 ${date} が収録の範囲 ${firstDate}〜${coveredDate} の外です)。`)
    }
    entries.push([date, item[1]])
  })
  // 日付の昇順に入れる(Map の順がそのまま日付の順になる)
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const names = new Map<string, string>()
  for (const [date, name] of entries) {
    if (names.has(date)) throw new Error(`${SHAPE_ERROR}(${date} が 2 回出てきます)。`)
    names.set(date, name)
  }
  return { names, first: firstDate, coveredUntil: coveredDate, source }
}

/** fetch の代わりに渡せる、使う部分だけの形(テストで差し替える) */
type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/**
 * 祝日一覧を読む。サーバーに無い(404)ときは null。ほかの失敗(通信・サーバーの失敗・形の違い)はエラー。
 * 祝日一覧は公開データで、GTFS は送らない。
 */
export async function fetchHolidays(fetchFn: FetchLike = (url) => fetch(url)): Promise<HolidayList | null> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchFn('/api/holidays')
  } catch {
    throw new Error('祝日一覧を取得できませんでした(サーバーに接続できません)。')
  }
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`祝日一覧を取得できませんでした(${res.status})。`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error(`${SHAPE_ERROR}(JSON として読めません)。`)
  }
  return parseHolidayJson(json)
}

/** start〜end(両端を含む)の祝日を日付の昇順で返す。start が end より後なら空 */
export function holidaysBetween(list: HolidayList, start: string, end: string): { date: string; name: string }[] {
  if (start > end) return []
  const found: { date: string; name: string }[] = []
  for (const [date, name] of list.names) {
    if (date >= start && date <= end) found.push({ date, name })
  }
  // names は日付の昇順で作るが、別の経路で作った Map でも昇順で返す
  return found.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * start〜end(両端を含む)のうち、収録の範囲(first〜coveredUntil)の外の部分。無ければ空。
 * 範囲の前と後の両方にはみ出すときは 2 つ(前、後の順)。start が end より後なら空。
 */
export function uncoveredRanges(list: HolidayList, start: string, end: string): { start: string; end: string }[] {
  if (start > end) return []
  const ranges: { start: string; end: string }[] = []
  if (start < list.first) {
    const beforeEnd = addDays(list.first, -1)
    ranges.push({ start, end: end < beforeEnd ? end : beforeEnd })
  }
  if (end > list.coveredUntil) {
    const afterStart = addDays(list.coveredUntil, 1)
    ranges.push({ start: start > afterStart ? start : afterStart, end })
  }
  return ranges
}
