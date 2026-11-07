/**
 * 画面の日付の扱い。GTFS の日付('YYYYMMDD')と、input type=date の値('YYYY-MM-DD')の変換、
 * 日本の今日の日付、画面に出す日付の書き方。
 *
 * 曜日は gtfs/calendar.ts の weekdayIndex(数字から計算する)に任せ、Date の文字列解析やローカル時刻には頼らない。
 */
import { isValidGtfsDate, weekdayIndex } from '@/gtfs/calendar'

/** weekdayIndex の値(0=月曜 … 6=日曜)に対応する曜日の1文字 */
export const WEEKDAY_LABELS = ['月', '火', '水', '木', '金', '土', '日'] as const

const INPUT_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 'YYYYMMDD' → 'YYYY-MM-DD'(input type=date の value・min・max)。不正な日付なら '' */
export function toInputDate(date: string): string {
  if (!isValidGtfsDate(date)) return ''
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
}

/** 'YYYY-MM-DD'(input type=date の値)→ 'YYYYMMDD'。空や不正な日付なら null */
export function fromInputDate(value: string): string | null {
  const m = INPUT_DATE.exec(value)
  if (!m) return null
  const date = `${m[1]}${m[2]}${m[3]}`
  return isValidGtfsDate(date) ? date : null
}

/** 日本時間(UTC+9。夏時間は無い)での、その時刻の日付('YYYYMMDD')。パソコンの時計の設定に左右されない */
export function todayInJapan(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000)
  const y = String(jst.getUTCFullYear()).padStart(4, '0')
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(jst.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** 画面に出す日付。'20261104' → '2026年11月4日(水)'。不正な日付ならそのまま返す */
export function formatDateJa(date: string): string {
  if (!isValidGtfsDate(date)) return date
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(4, 6))
  const d = Number(date.slice(6, 8))
  return `${y}年${m}月${d}日(${WEEKDAY_LABELS[weekdayIndex(date)]})`
}

/**
 * デモのときだけ固定する「今日」。URL のクエリ `?today=YYYY-MM-DD` を読み、'YYYYMMDD' を返す。
 * 渡していない・形が違う・実在しない日付なら null(固定しない)。ハッシュ(#/about)はクエリと別なので両立する
 */
export function fixedTodayFrom(search: string): string | null {
  const value = new URLSearchParams(search).get('today')
  return value === null ? null : fromInputDate(value)
}

/** 今の画面で固定している「今日」('YYYYMMDD')。固定していなければ null */
export function fixedToday(search: string = typeof window === 'undefined' ? '' : window.location.search): string | null {
  return fixedTodayFrom(search)
}

/**
 * 画面の「今日」('YYYYMMDD'、日本時間)。デモで `?today=` を渡したときはその日にする。
 * 画面・判断材料・AI に送る [画面の状態] の「今日」は、すべてこの関数を通す
 */
export function appToday(search?: string): string {
  return fixedToday(search) ?? todayInJapan(new Date())
}

/**
 * 画面の「今」。固定していなければ今の時刻。固定しているときは、固定した日の、今の時刻(日本時間の時・分・秒)にする
 * (承認した日時・出力の作成日時(feed_version の既定)を固定した日にそろえるため)
 */
export function appNow(search?: string, real: Date = new Date()): Date {
  const fixed = fixedToday(search)
  if (fixed === null) return real
  const day = 86_400_000
  const jst = 9 * 3600 * 1000
  const msOfDay = (((real.getTime() + jst) % day) + day) % day
  const midnightUtc = Date.UTC(Number(fixed.slice(0, 4)), Number(fixed.slice(4, 6)) - 1, Number(fixed.slice(6, 8)))
  return new Date(midnightUtc - jst + msOfDay)
}
