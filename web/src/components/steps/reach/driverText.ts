import type { DutyParams, DutyPlace } from '@/gtfs/edit/duties'
import { formatDateJa } from '@/lib/dates'
import type { ParseResult } from '@/reach/input'
import { MAX_ROSTER, MAX_SHORTAGE, type DriverVerdict, type RosterCheck } from '@/store/drivers'

/**
 * 要る運転士の数(目安)の欄(DriverPanel.tsx)と、前提情報の手順の「運行の前提」の欄(research/OperationPremise.tsx)の文。語は docs/wording.md に従い、「あなた」を使わない。
 * 数はすべて計算(store/drivers.ts の compareDrivers)から入れる。届出・勤務の要否は言い切らない
 */

/** 欄の見出し */
export const DRIVER_PANEL_TITLE = '要る運転士の数(目安)'

/** 欄の説明(見出しの下) */
export const DRIVER_PANEL_LEAD =
  '比較する日付の便を時刻順に勤務へつなぎ、改善基準告示の上限で区切った勤務の数を、要る運転士の数の下限の目安として出します。'

/** 欠員の入力欄の名前 */
export const SHORTAGE_LABEL = '欠員(その日に乗務できない運転士の数)'

/** 在籍の運転士の数の入力欄の名前 */
export const ROSTER_LABEL = '在籍の運転士の数(任意)'

/** 前提情報の手順の「運行の前提」の欄の見出し */
export const PREMISE_TITLE = '運行の前提(営業所・休憩施設・運転士の数)'

/** 影響(到達圏)の手順の欄から、運行の前提の欄へ移るボタン */
export const PREMISE_JUMP = '前提情報で設定する'

/** 欠員を入れていないときに、結果の欄に出す文 */
export const SHORTAGE_HINT = '前提情報で欠員を入れると、足りるかの目安を出します。'

/** 欠員を入れていないときに、平日便を戻す手順の1行に添える文(入れる場所を示す) */
export const SHORTAGE_WHERE = '手順「前提情報」の「運行の前提」の欄で欠員を入れると、足りるかの目安を出します。'

/** 分を「400時間42分」にする */
export function formatHours(minutes: number): string {
  const sign = minutes < 0 ? '−' : ''
  const m = Math.abs(minutes)
  return `${sign}${Math.floor(m / 60)}時間${m % 60}分`
}

/** 差(前 − 後)を「−14」「+2」「±0」にする。減ったら − */
export function formatDiff(reduced: number, unit = ''): string {
  if (reduced === 0) return `±0${unit}`
  return `${reduced > 0 ? '−' : '+'}${Math.abs(reduced).toLocaleString('ja-JP')}${unit}`
}

/** 営業運行時間の差(前 − 後。分)を「−48時間54分」「+1時間0分」「±0」にする。減ったら − */
export function formatHoursDiff(reducedMin: number): string {
  if (reducedMin === 0) return '±0'
  return `${reducedMin > 0 ? '−' : '+'}${formatHours(Math.abs(reducedMin))}`
}

/** 削減の割合(0〜1。増えたら負)を「−12.2%」「+3.0%」にする */
export function formatRatioDiff(ratio: number): string {
  return `${ratio > 0 ? '−' : '+'}${(Math.abs(ratio) * 100).toFixed(1)}%`
}

/** 判定の文。判定は減る勤務の数と欠員の比較だけ */
export function verdictText(verdict: DriverVerdict, date: string): string {
  switch (verdict.kind) {
    case 'noEdited':
      return '減便の方針を承認すると(承認待ちの下書きでも)、減便で減る勤務の数(目安)と欠員を比べます。'
    case 'notWeekday':
      return notWeekdayText(date)
    case 'noShortage':
      return `減便で減る勤務の数(目安)は ${verdict.reduced} です。`
    case 'enough':
      return `減便で減る勤務の数(目安)${verdict.reduced} ≥ 欠員 ${verdict.shortage} → 足りる目安です。`
    case 'short':
      return `減便で減る勤務の数(目安)${verdict.reduced} < 欠員 ${verdict.shortage} → あと ${verdict.missing} 足りない目安です。`
  }
}

/** 比較する日付に平日ダイヤが走らないときの文 */
export function notWeekdayText(date: string): string {
  return `比較する日付(${formatDateJa(date)})は減便前の平日ダイヤが走らない日のため、減便の前後で便と勤務の数は変わりません。欠員と比べるには、地図の下の操作盤で平日の日付を選んでください。`
}

/**
 * 断り書き。下限の目安であること、改善基準告示の上限で区切ったこと、事業者が決めること、営業所・休憩施設の扱い
 */
export function driverCaveats(params: Pick<DutyParams, 'maxBoundMin' | 'maxDrivingMin' | 'maxContinuousMin'>, places: readonly DutyPlace[] = []): string[] {
  const hours = (min: number) => (min % 60 === 0 ? `${min / 60} 時間` : `${Math.floor(min / 60)} 時間 ${min % 60} 分`)
  const depots = places.some((p) => p.kind !== 'rest')
  const rests = places.some((p) => p.kind === 'rest')
  return [
    '勤務の数は、要る運転士の数の下限の目安です。実際に要る人数はこれより多くなることがあります。',
    `改善基準告示 第5条の上限(拘束 ${hours(params.maxBoundMin)}・運転 ${hours(params.maxDrivingMin)}・連続運転 ${hours(params.maxContinuousMin)})で勤務を区切りました。`,
    '休息期間・休日・予備の要員・36協定と、実際の仕業・交番は事業者が判断します。Dispatcher は運転士ごとの勤務を判定しません。',
    depots
      ? '出庫・入庫の回送は、最寄りの営業所・車庫との直線距離から見積もっています。'
      : '営業所・車庫を置いていないため、出庫・入庫の回送を 0 として数えています。',
    rests
      ? '休憩は、前の便の終着か次の便の始発のどちらかが休憩施設・営業所の近くなら、そのすき間を休憩に数える甘めの数え方です(車庫は休憩に数えません)。'
      : '休憩施設を置いていないため、どの停留所でのすき間も休憩に数える甘めの数え方です。',
  ]
}

/**
 * 在籍の運転士の数を入れたときの参考の文(主な判定とは別)。
 * 「参考:乗務できる運転士(在籍 110 − 欠員 20)90 人/減便後に要る勤務の数(目安)57。」
 */
export function rosterCheckText(check: RosterCheck): string {
  const minus = check.shortage === null ? '。欠員は未入力' : ` − 欠員 ${check.shortage}`
  const side = check.basis === 'after' ? '減便後' : '減便前'
  return `参考:乗務できる運転士(在籍 ${check.roster}${minus})${check.available} 人/${side}に要る勤務の数(目安)${check.needed}。`
}

/** 在籍の運転士の数の参考の注意(要る勤務の数が乗務できる運転士を上回る・欠員が在籍より多い)。どちらでもなければ null */
export function rosterWarningText(check: RosterCheck): string | null {
  if (check.shortageOverRoster) return '注意:欠員が在籍の運転士の数より多くなっています。前提情報の数を確かめてください。'
  if (check.over > 0) {
    return `注意:${check.basis === 'after' ? '減便後' : '減便前'}に要る勤務の数(目安)が、乗務できる運転士の数を ${check.over} 上回ります。`
  }
  return null
}

/** 在籍の運転士の数の参考に添える1文。勤務の数は下限の目安で、事業者の運用番号の数と差があること */
export function rosterCaveatText(operatorRuns: number | null): string {
  return operatorRuns === null
    ? '勤務の数の推定は下限の目安のため、事業者の運用番号の数(実際の勤務の数)とは差があります。'
    : `勤務の数の推定は下限の目安のため、事業者の運用番号の数(入力の運用番号の数(参考)は減便前 ${operatorRuns})とは差があります。`
}

/** 使った仮定の短い一覧(拘束・点呼・回送の速さ・置いた場所の数) */
export function assumptionsSummary(params: Pick<DutyParams, 'maxBoundMin' | 'preCheckMin' | 'postCheckMin' | 'deadheadKmh'>, places: readonly DutyPlace[]): string[] {
  const depots = places.filter((p) => p.kind !== 'rest').length
  const rests = places.filter((p) => p.kind === 'rest').length
  return [
    `拘束時間の上限 ${params.maxBoundMin / 60} 時間`,
    `点呼 出庫前 ${params.preCheckMin} 分・入庫後 ${params.postCheckMin} 分`,
    `回送 時速 ${params.deadheadKmh}km`,
    `営業所・車庫 ${depots} か所・休憩施設 ${rests} か所`,
  ]
}

/** 運用番号の数(参考)の説明 */
export const OPERATOR_RUNS_NOTE =
  '入力の運用番号の数は、減便前の GTFS の trip_id の先頭の番号の種類の数です(参考。事業者の実際の勤務の数とは限りません)。'

/** 営業運行時間の数え方 */
export const SERVICE_HOURS_NOTE = '営業運行時間は各便の始発から終着までの合計で、回送・待機・点呼は含みません。'

/** 全角の数字を半角にし、前後の空白を除く */
function normalizeDigits(text: string): string {
  return text.trim().replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

export type OptionalCountResult = { ok: true; value: number | null } | { ok: false; message: string }

/** 空でもよい人数の入力。空なら null(入れていない)。0〜max の整数 */
function parseOptionalCount(text: string, max: number): OptionalCountResult {
  const s = normalizeDigits(text)
  if (s === '') return { ok: true, value: null }
  if (!/^\d+$/.test(s)) return { ok: false, message: '0 以上の整数を入れてください' }
  const value = Number(s)
  if (value > max) return { ok: false, message: `${max}人以下にしてください` }
  return { ok: true, value }
}

/** 欠員の入力。空なら null(入れていない)。0〜999 の整数 */
export function parseShortage(text: string): OptionalCountResult {
  return parseOptionalCount(text, MAX_SHORTAGE)
}

/** 在籍の運転士の数の入力。空なら null(入れていない)。0〜9999 の整数 */
export function parseRoster(text: string): OptionalCountResult {
  return parseOptionalCount(text, MAX_ROSTER)
}

function parseIntegerIn(text: string, min: number, max: number, unit: string): ParseResult {
  const s = normalizeDigits(text)
  if (s === '') return { ok: false, message: '数を入れてください' }
  if (!/^\d+$/.test(s)) return { ok: false, message: `${min} 以上の整数を入れてください` }
  const value = Number(s)
  if (value < min) return { ok: false, message: `${min}${unit}以上にしてください` }
  if (value > max) return { ok: false, message: `${max}${unit}以下にしてください` }
  return { ok: true, value }
}

/** 点呼の分の上限 */
export const MAX_CHECK_MIN = 120
/** 回送の速さの範囲(km/h) */
export const DEADHEAD_KMH_RANGE = { min: 5, max: 60 } as const

/** 点呼の分の入力。0〜120 分の整数 */
export function parseCheckMinutes(text: string): ParseResult {
  return parseIntegerIn(text, 0, MAX_CHECK_MIN, '分')
}

/** 回送の速さの入力。5〜60 km/h の整数 */
export function parseDeadheadKmh(text: string): ParseResult {
  return parseIntegerIn(text, DEADHEAD_KMH_RANGE.min, DEADHEAD_KMH_RANGE.max, 'km/h')
}
