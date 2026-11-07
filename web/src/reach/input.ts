/**
 * 画面の条件から到達圏の計算の入力(ReachInput)を作るための、純粋な補助。
 */
import type { TimeBand } from '@/gtfs/departures'
import type { GtfsFeed, GtfsRow } from '@/gtfs/load'
import { NON_NEGATIVE_INTEGER, type Stop } from '@/gtfs/parse'
import type { ReachInput, ReachParams, RegionClass } from './reach'

export const REGION_CLASSES: readonly RegionClass[] = ['urban', 'suburban', 'rural']

/** 区分の画面での名前 */
export const REGION_LABELS: Record<RegionClass, string> = {
  urban: '都市部',
  suburban: '郊外',
  rural: '中山間・地方',
}

/** 画面で入力できる徒歩の分数の上限。大きすぎると調べるセルが数百万になり、計算が終わらなくなる */
export const MAX_WALK_MINUTES = 60
/** 画面で入力できる人口密度のしきい値(人/km²)の上限 */
export const MAX_DENSITY_THRESHOLD = 100_000

/** ReachParams の写し(既定値を書き換えないように、入れ子まで写す) */
export function cloneParams(p: ReachParams): ReachParams {
  return {
    densityThreshold: p.densityThreshold,
    speedMPerMin: p.speedMPerMin,
    walkMinutes: {
      urban: { ...p.walkMinutes.urban },
      suburban: { ...p.walkMinutes.suburban },
      rural: { ...p.walkMinutes.rural },
    },
  }
}

/**
 * 参照データを読む範囲の広げ幅(m)。3区分のバス停の距離の最大 + 3区分の駅の距離の最大(既定 1,200m + 1,600m = 2,800m)。
 * 調べるセルは起点の停留所からバス停の距離の最大以内にあり、そのセルから駅の距離の最大以内の駅まで判定に使うため
 * (docs/interfaces-1103.md の追記2)。
 */
export function refMarginM(p: ReachParams): number {
  let bus = 0
  let rail = 0
  for (const c of REGION_CLASSES) {
    bus = Math.max(bus, p.walkMinutes[c].bus)
    rail = Math.max(rail, p.walkMinutes[c].rail)
  }
  return (bus + rail) * p.speedMPerMin
}

/** 到達圏の起点にする停留所と、起点から除いたものの数 */
export interface OriginStops {
  /** 起点の停留所(stops の並びのまま)。地図の停留所の点もこれを使う */
  stops: Stop[]
  /** location_type が 0 か空だが、stop_times.txt に一度も出てこないので除いた停留所の数 */
  unused: number
  /** location_type が 0 でも空でもない(駅舎・出入口など)ので除いた行の数 */
  nonStop: number
  /**
   * location_type が 0 か空で stop_times.txt に出てくるが、乗れる行が1つも無いので除いた停留所の数
   * (すべて便の最後の停留所か pickup_type が 1。降車専用の停留所。docs/interfaces-1104.md §7)
   */
  noBoarding: number
}

/**
 * 乗れる行が1つ以上ある停留所の stop_id(前後の空白を取った値)。日付に関係なく、stop_times.txt の全便で判定する。
 *
 * 乗れる行は、pickup_type が '1'(前後の空白を取って照合)でなく、その便の最後の停留所でない行
 * (docs/interfaces-1104.md §7)。最後の停留所は、便(空白を取った trip_id)ごとに stop_sequence を数値として比べて最大の行。
 * stop_sequence は 0 以上の10進の整数だけを読み、読めない行は最後の停留所の判定に使わない(gtfs/departures.ts と同じ規則)。
 * 同じ便で最大の stop_sequence の行が複数あれば、どれも最後の停留所とみなす。
 * 到達圏の起点の選び方(originStops)と、運行がゼロになる停留所の 'feed' の判定(compare.ts)で、同じ定義を使う。
 */
export function boardingStopIds(feed: GtfsFeed): Set<string> {
  const rows = feed.tables.get('stop_times')?.rows ?? []
  // 1. 便ごとの最後の stop_sequence
  const lastSequence = new Map<string, string>()
  for (const row of rows) {
    const seq = sequenceOf(row)
    if (seq === null) continue
    const tripId = trimmed(row.trip_id)
    const prev = lastSequence.get(tripId)
    if (prev === undefined || isLaterSequence(seq, prev)) lastSequence.set(tripId, seq)
  }
  // 2. 乗れる行の停留所
  const ids = new Set<string>()
  for (const row of rows) {
    const stopId = trimmed(row.stop_id)
    if (stopId === '' || ids.has(stopId)) continue
    if (trimmed(row.pickup_type) === '1') continue
    const seq = sequenceOf(row)
    if (seq !== null && seq === lastSequence.get(trimmed(row.trip_id))) continue
    ids.add(stopId)
  }
  return ids
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** stop_sequence を、先頭の 0 を除いた10進の文字列にする。0 以上の10進の整数でなければ null('0x0A'・'1e1'・'1.5'・空) */
function sequenceOf(row: GtfsRow): string | null {
  const s = trimmed(row.stop_sequence)
  if (!NON_NEGATIVE_INTEGER.test(s)) return null
  return s.replace(/^0+(?=\d)/, '')
}

/** sequenceOf の値 a が b より大きいか(桁数が多いほど大きく、同じ桁数なら文字の並びで決まる) */
function isLaterSequence(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b
}

/**
 * 到達圏の起点にする停留所を選ぶ(docs/interfaces-1103.md の追記2・追記3、docs/interfaces-1104.md §7)。
 * location_type が 0 か空(toStops は空を 0 にしている)で、stop_times.txt に乗れる行(boardingStopIds)がある停留所。
 * 除いたものは、駅舎・出入口など(nonStop)、stop_times.txt に出てこない(unused)、乗れる行が無い(noBoarding)の順に1つに数える。
 * stop_id は前後の空白を取って照合する。stops は toStops の結果(緯度経度が読めない行は除いてある)。
 *
 * 渡すのは基準の GTFS(利用者が読み込んだもの)だけ。編集後の GTFS で選び直すと、便が無くなった停留所のまわりのセルが
 * 調べるセルから消える(追記3)。
 */
export function originStops(feed: GtfsFeed, stops: readonly Stop[]): OriginStops {
  const used = new Set<string>()
  for (const row of feed.tables.get('stop_times')?.rows ?? []) {
    const id = row.stop_id?.trim()
    if (id) used.add(id)
  }
  const boarding = boardingStopIds(feed)
  const origins: Stop[] = []
  let unused = 0
  let nonStop = 0
  let noBoarding = 0
  for (const s of stops) {
    if (s.locationType !== 0) nonStop++
    else if (!used.has(s.id)) unused++
    else if (!boarding.has(s.id)) noBoarding++
    else origins.push(s)
  }
  return { stops: origins, unused, nonStop, noBoarding }
}

/**
 * 停留所ごとの時間帯別の出発の数を並べる。counts に無い停留所(出発が1本も無い)は、すべての時間帯を 0 とする。
 * 停留所の並びは stops のまま(地図の停留所の表示も同じ並びを使う)。
 */
export function buildReachStops(
  stops: readonly { id: string; lat: number; lon: number }[],
  counts: ReadonlyMap<string, number[]>,
  bandCount: number,
): ReachInput['stops'] {
  return stops.map((s) => {
    const c = counts.get(s.id)
    const bandCounts = new Array<number>(bandCount)
    for (let b = 0; b < bandCount; b++) bandCounts[b] = c?.[b] ?? 0
    return { lat: s.lat, lon: s.lon, bandCounts }
  })
}

/** その時刻(時)を含む時間帯の番号。どれにも入らなければ、近いほうの端(6時より前なら最初、24時以降なら最後) */
export function bandIndexForHour(bands: readonly TimeBand[], hour: number): number {
  if (bands.length === 0) return -1
  const i = bands.findIndex((b) => b.startHour <= hour && hour < b.endHour)
  if (i >= 0) return i
  return hour < bands[0].startHour ? 0 : bands.length - 1
}

export type ParseResult = { ok: true; value: number } | { ok: false; message: string }

const NUMBER_TEXT = /^\d+(\.\d+)?$/
const INTEGER_TEXT = /^\d+$/

/**
 * 入力欄の文字を数にする(全角の数字も受け付ける)。0 以上 max 以下でなければ理由を返す。
 * integer なら整数だけを受け付ける(小数は理由を返す)
 */
function parseBounded(text: string, max: number, unit: string, integer = false): ParseResult {
  const s = text.trim().replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  if (s === '') return { ok: false, message: '数を入れてください' }
  if (integer && NUMBER_TEXT.test(s) && !INTEGER_TEXT.test(s)) return { ok: false, message: '整数を入れてください' }
  if (!NUMBER_TEXT.test(s)) return { ok: false, message: integer ? '0 以上の整数を入れてください' : '0 以上の数を入れてください' }
  const value = Number(s)
  if (value > max) return { ok: false, message: `${max.toLocaleString('ja-JP')}${unit}以下にしてください` }
  return { ok: true, value }
}

/** 徒歩の分数の入力。0〜60 分の整数(docs/interfaces-1103.md の追記2) */
export function parseWalkMinutes(text: string): ParseResult {
  return parseBounded(text, MAX_WALK_MINUTES, '分', true)
}

/** 人口密度のしきい値の入力。0〜100,000 人/km² */
export function parseDensityThreshold(text: string): ParseResult {
  return parseBounded(text, MAX_DENSITY_THRESHOLD, '人/km²')
}
