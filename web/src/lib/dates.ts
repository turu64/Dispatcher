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
