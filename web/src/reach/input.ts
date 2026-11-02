/**
 * 画面の条件から到達圏の計算の入力(ReachInput)を作るための、純粋な補助。
 */
import type { TimeBand } from '@/gtfs/departures'
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

/** 最大の徒歩圏(m)。分数の最大 × 分速。調べるセルと、読む参照データの範囲を決める */
export function maxWalkRadiusM(p: ReachParams): number {
  let max = 0
  for (const c of REGION_CLASSES) max = Math.max(max, p.walkMinutes[c].bus, p.walkMinutes[c].rail)
  return max * p.speedMPerMin
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

/** 入力欄の文字を数にする(全角の数字も受け付ける)。0 以上 max 以下でなければ理由を返す */
function parseBounded(text: string, max: number, unit: string): ParseResult {
  const s = text.trim().replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  if (s === '') return { ok: false, message: '数を入れてください' }
  if (!NUMBER_TEXT.test(s)) return { ok: false, message: '0 以上の数を入れてください' }
  const value = Number(s)
  if (value > max) return { ok: false, message: `${max.toLocaleString('ja-JP')}${unit}以下にしてください` }
  return { ok: true, value }
}

/** 徒歩の分数の入力。0〜60 分 */
export function parseWalkMinutes(text: string): ParseResult {
  return parseBounded(text, MAX_WALK_MINUTES, '分')
}

/** 人口密度のしきい値の入力。0〜100,000 人/km² */
export function parseDensityThreshold(text: string): ParseResult {
  return parseBounded(text, MAX_DENSITY_THRESHOLD, '人/km²')
}
