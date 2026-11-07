import { DUTY_DEFAULTS, type DutyParams, type DutyPlace } from '@/gtfs/edit/duties'
import { formatDateJa } from '@/lib/dates'
import type { ParseResult } from '@/reach/input'
import { MAX_ROSTER, MAX_SHORTAGE, WORK_DAYS_RANGE, type DriverNeed, type DriverSupply, type DriverVerdict } from '@/store/drivers'

/**
 * 要る運転士の数(目安)の欄(DriverPanel.tsx)と、運行の前提の手順の「運行の前提」の欄(research/OperationPremise.tsx)・減便の方針の手順の欠員の欄(policy/ShortageSection.tsx)の文。語は docs/wording.md に従い、「あなた」を使わない。
 * 数はすべて計算(store/drivers.ts の compareDrivers)から入れる。届出・勤務の要否は言い切らない
 */

/** 欄の見出し */
export const DRIVER_PANEL_TITLE = '要る運転士の数(目安)'

/** 欄の説明(見出しの下) */
export const DRIVER_PANEL_LEAD =
  '便を時刻順に勤務へつなぎ、改善基準告示の上限で区切った勤務の数を、要る運転士の数の下限の目安として出します。'

/** 欠員の入力欄の名前 */
export const SHORTAGE_LABEL = '欠員(その日に乗務できない運転士の数)'

/** 在籍の運転士の数の入力欄の名前 */
export const ROSTER_LABEL = '在籍の運転士の数'

/** 週の出勤日数の入力欄の名前 */
export const WORK_DAYS_LABEL = '1人あたりの週の出勤日数'

/** 運行の前提の手順の「運行の前提」の欄の見出し */
export const PREMISE_TITLE = '運行の前提(営業所・運転士の数)'

/** 影響(到達圏)の手順の欄から、運行の前提の手順の「運行の前提」の欄へ移るボタン */
export const PREMISE_JUMP = '運行の前提で設定する'

/** 影響(到達圏)の手順の欄から、減便の方針の手順の欠員の欄へ移るボタン */
export const SHORTAGE_JUMP = '欠員を入れる(減便の方針)'

/** 在籍の運転士の数を入れていないときに、結果の欄に出す文 */
export const ROSTER_HINT = '在籍の運転士の数を入れると、足りるかの目安を出します。'

/** 在籍の運転士の数を入れていないときに、平日便を戻す手順の1行に添える文(入れる場所を示す) */
export const ROSTER_WHERE = '手順「運行の前提」で在籍の運転士の数を入れると、足りるかの目安を出します。'

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

/**
 * 判定の文。乗務できる運転士の数(目安)と減便後に要る勤務の数を比べ、減便前のままでの過不足も並べる。
 * 「減便後に要る勤務の数 70 に対して、乗務できる運転士の数(目安)88 → 足りる目安です(余り 18)。減便前のままでは 13 足りない目安です。」
 */
export function verdictText(verdict: DriverVerdict, date: string): string {
  switch (verdict.kind) {
    case 'noEdited':
      return '減便の方針を承認すると(承認待ちの下書きでも)、乗務できる運転士の数(目安)と減便後に要る勤務の数を比べます。'
    case 'notWeekday':
      return notWeekdayText(date)
    case 'noRoster':
      return ROSTER_HINT
    case 'enough':
    case 'short': {
      const head = `減便後に要る勤務の数 ${verdict.needed} に対して、乗務できる運転士の数(目安)${verdict.available} → `
      const result = verdict.kind === 'enough' ? `足りる目安です(余り ${verdict.spare})。` : `あと ${verdict.missing} 足りない目安です。`
      return head + result + beforeMarginText(verdict.beforeMargin)
    }
  }
}

/** 減便前のままでの過不足の文 */
function beforeMarginText(margin: number): string {
  return margin >= 0 ? `減便前のままでも足りる目安です(余り ${margin})。` : `減便前のままでは ${-margin} 足りない目安です。`
}

/**
 * 乗務できる運転士の数(目安)の数え方の文。
 * 「乗務できる運転士の数(目安)は、在籍 150 × 週の出勤日数 5 ÷ 7 = 107(小数は切り捨て)から欠員 19 を引いた 88 です。」
 */
export function supplyText(supply: DriverSupply): string {
  const head = `乗務できる運転士の数(目安)は、在籍 ${supply.roster} × 週の出勤日数 ${supply.workDays} ÷ 7 = ${supply.onDuty}(小数は切り捨て)`
  if (supply.shortage === null) return `${head}です(欠員は未入力のため 0 として数えました)。`
  return `${head}から欠員 ${supply.shortage} を引いた ${supply.available} です。`
}

/** 欠員がその日に出勤する運転士の数より多いときの注意。そうでなければ null */
export function supplyWarningText(supply: DriverSupply): string | null {
  return supply.shortageOverOnDuty
    ? '注意:欠員が、その日に出勤する運転士の数(在籍 × 週の出勤日数 ÷ 7)より多くなっています。手順「運行の前提」の在籍の運転士の数・週の出勤日数と、手順「減便の方針」の欠員を確かめてください。'
    : null
}

/**
 * 要る勤務の数をどう出したかの1文。
 * 「要る勤務の数は、減便前は入力の運用番号の数 101、減便後はそれに推定した勤務の数の比(55/79)を掛けた 70 です。」
 */
export function needBasisText(need: DriverNeed): string {
  if (need.basis === 'operatorRuns') {
    if (need.after === null || need.estimateAfter === null) return `要る勤務の数は、減便前は入力の運用番号の数 ${need.before} です。`
    return `要る勤務の数は、減便前は入力の運用番号の数 ${need.before}、減便後はそれに推定した勤務の数の比(${need.estimateAfter}/${need.estimateBefore})を掛けた ${need.after} です(四捨五入)。`
  }
  return '入力の運用番号の数が取れないため、要る勤務の数は、推定した勤務の数(目安。下限の目安)をそのまま使っています。'
}

/** 比較する日付に平日ダイヤが走らないときの文 */
export function notWeekdayText(date: string): string {
  return `比較する日付(${formatDateJa(date)})は減便前の平日ダイヤが走らない日のため、減便の前後で便と勤務の数は変わりません。欠員と比べるには、地図の下の操作盤で平日の日付を選んでください。`
}

/**
 * 断り書き。下限の目安であること、改善基準告示の上限で区切ったこと、事業者が決めること、営業所の扱い
 */
export function driverCaveats(
  params: Pick<DutyParams, 'maxBoundMin' | 'maxDrivingMin' | 'maxContinuousMin'> & Partial<Pick<DutyParams, 'maxRemoteWaitMin'>>,
  places: readonly DutyPlace[] = [],
): string[] {
  const hours = (min: number) => (min % 60 === 0 ? `${min / 60} 時間` : `${Math.floor(min / 60)} 時間 ${min % 60} 分`)
  const remoteWait = params.maxRemoteWaitMin === undefined ? DUTY_DEFAULTS.maxRemoteWaitMin : params.maxRemoteWaitMin
  const offices = places.length > 0
  return [
    '勤務の数は、要る運転士の数の下限の目安です。実際に要る人数はこれより多くなることがあります。',
    `改善基準告示 第5条の上限(拘束 ${hours(params.maxBoundMin)}・運転 ${hours(params.maxDrivingMin)}・連続運転 ${hours(params.maxContinuousMin)})で勤務を区切りました。`,
    '休息期間・休日・予備の要員・36協定と、実際の仕業・交番は事業者が判断します。Dispatcher は運転士ごとの勤務を判定しません。',
    offices
      ? '出庫・入庫の回送は、最寄りの営業所との直線距離から見積もっています。'
      : '営業所を置いていないため、出庫・入庫の回送を 0 として数えています。',
    offices
      ? remoteWait === null
        ? '休憩はどの停留所でのすき間にも数える甘めの数え方です。'
        : `休憩はどの停留所でのすき間にも数え、営業所から遠い停留所で ${hours(remoteWait)}より長く待つすき間は営業所へ戻って休むとみなす甘めの数え方です。`
      : '営業所を置いていないため、どの停留所でのすき間も休憩に数える甘めの数え方です。',
  ]
}

/** 使った仮定の短い一覧(拘束・点呼・回送の速さ・置いた場所の数) */
export function assumptionsSummary(params: Pick<DutyParams, 'maxBoundMin' | 'preCheckMin' | 'postCheckMin' | 'deadheadKmh'>, places: readonly DutyPlace[]): string[] {
  return [
    `拘束時間の上限 ${params.maxBoundMin / 60} 時間`,
    `点呼 出庫前 ${params.preCheckMin} 分・入庫後 ${params.postCheckMin} 分`,
    `回送 時速 ${params.deadheadKmh}km`,
    `営業所 ${places.length} か所`,
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

/** 1人あたりの週の出勤日数の入力。1〜7 の整数(空は受け付けない) */
export function parseWorkDays(text: string): ParseResult {
  return parseIntegerIn(text, WORK_DAYS_RANGE.min, WORK_DAYS_RANGE.max, '日')
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
