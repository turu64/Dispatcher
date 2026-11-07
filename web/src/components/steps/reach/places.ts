import { distanceM } from '@/gtfs/edit/notice'
import type { Stop } from '@/gtfs/parse'
import type { PlacesEffect } from '@/store/drivers'

/**
 * 営業所を置く欄(PlacesEditor.tsx)と、要る運転士の数の欄(DriverPanel.tsx)の材料(D05)。
 * 停留所の名前での検索と、置く前と後の勤務の数の文
 */

/** 停留所の検索の結果に出す数の上限 */
export const MAX_STOP_RESULTS = 20
/** 同じ名前の停留所を1つにまとめる距離(m。上りと下りの停留所) */
const SAME_STOP_M = 300

export interface StopMatch {
  name: string
  lat: number
  lon: number
}

function searchKey(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/**
 * 停留所を名前の一部で探す(NFKC にして空白を除き、大文字・小文字を区別しない)。名前で始まるものを先に出す。
 * 同じ名前で 300m 以内の停留所(上りと下り)は1つにまとめる。最大 limit 件
 */
export function searchStops(stops: readonly Stop[], query: string, limit: number = MAX_STOP_RESULTS): StopMatch[] {
  const q = searchKey(query)
  if (q === '') return []
  const prefix: StopMatch[] = []
  const rest: StopMatch[] = []
  const kept = new Map<string, StopMatch[]>()
  for (const s of stops) {
    if (s.locationType !== 0) continue
    const key = searchKey(s.name)
    const i = key.indexOf(q)
    if (i < 0) continue
    const same = kept.get(key) ?? []
    if (same.some((m) => distanceM(m, s) <= SAME_STOP_M)) continue
    const match = { name: s.name, lat: s.lat, lon: s.lon }
    same.push(match)
    kept.set(key, same)
    ;(i === 0 ? prefix : rest).push(match)
  }
  return [...prefix, ...rest].slice(0, limit)
}

/** 営業所を置く前と後の勤務の数の文 */
export function placesEffectText(effect: PlacesEffect): string {
  const side = (label: string, v: { without: number; with: number }) => {
    const d = v.with - v.without
    return `${label} ${v.without} → ${v.with}(${d === 0 ? '変わらない' : d > 0 ? `+${d}` : `${d}`})`
  }
  const parts = [side('減便前', effect.before)]
  if (effect.after) parts.push(side('減便後', effect.after))
  return `営業所(${effect.count} か所)を置く前と後の勤務の数(目安):${parts.join('、')}。表と判定は置いた後の数です。`
}
