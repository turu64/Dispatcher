/**
 * 周辺の事業者の停留所(国土数値情報のバス停留所 P11)の参照データと、編集する GTFS の停留所との重なり。
 *
 * - data/ の facilities.py が、facilities/{mesh1}.json の最上位の鍵 busstops に停留所ごとの
 *   位置・停留所名・事業者(target_id)・系統名を書く。施設(facilities)と同じファイルなので、取得の回数は増えない
 * - 停留所はその位置の1次メッシュのファイルにだけ入る(事業者と違い、ファイルをまたいで重ならない)
 * - 同じ場所の停留所でも事業者が違えば別の行(系統名をその事業者のものとして数えるため)。operators はふつう1件
 * - P11 には時刻表が無いので、本数や時間帯は扱わない(画面の断り書きは「判断材料を調べる」の欄・周知文が出す)
 *
 * 計算はすべてブラウザで行う。距離は到達圏と同じ distanceM(直線)
 */
import KDBush from 'kdbush'
import { distanceM } from '@/reach/mesh'
import { isOwnOperator } from './facilities'

/**
 * 重なりを数える距離(m)。周知文の代替手段の「半径 300m 以内」(gtfs/edit/notice.ts の NEARBY_RADIUS_M)と同じ値。
 * 到達圏の区分ごとの距離は使わない(周知文と数がずれないため)
 */
export const OTHER_STOP_RADIUS_M = 300

/** 他事業者の停留所の1件 */
export interface OtherStop {
  name: string
  lat: number
  lon: number
  /** 事業者の target_id(P11:…。施設の参照データの事業者と同じ) */
  operators: string[]
  /** 系統名(重複なし) */
  routes: string[]
}

const OPERATOR_ID = /^P11:\P{Cc}{1,200}$/u
const MAX_NAME_CHARS = 200

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 停留所の1件。形が合わなければ null(読み飛ばす) */
export function parseBusstop(v: unknown): OtherStop | null {
  if (!isObj(v)) return null
  const lat = finite(v.lat)
  const lon = finite(v.lon)
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  if (typeof v.name !== 'string') return null
  const name = v.name.trim()
  if (name === '' || name.length > MAX_NAME_CHARS) return null
  if (!Array.isArray(v.operators)) return null
  const operators = [...new Set(v.operators.filter((o): o is string => typeof o === 'string' && OPERATOR_ID.test(o)))]
  if (operators.length === 0) return null
  // 系統名は無くてもよい(配列でなければ空とみなす)。空・長すぎるものは除く
  const routes = Array.isArray(v.routes)
    ? [
        ...new Set(
          v.routes
            .filter((r): r is string => typeof r === 'string')
            .map((r) => r.trim())
            .filter((r) => r !== '' && r.length <= MAX_NAME_CHARS),
        ),
      ]
    : []
  return { name, lat, lon, operators, routes }
}

/**
 * facilities/{mesh1}.json の1つから停留所を読む。busstops の鍵が無い古いファイル・形の違うファイルは空。
 * 形の合わない行は読み飛ばし、その数を skipped に返す
 */
export function parseBusstops(file: unknown): { stops: OtherStop[]; skipped: number } {
  if (!isObj(file) || !Array.isArray(file.busstops)) return { stops: [], skipped: 0 }
  const stops: OtherStop[] = []
  let skipped = 0
  for (const item of file.busstops) {
    const s = parseBusstop(item)
    if (s) stops.push(s)
    else skipped++
  }
  return { stops, skipped }
}

/** 1次メッシュのファイルの並びから停留所を読み、1つにつなぐ(停留所はファイルをまたいで重ならない) */
export function mergeBusstopFiles(files: readonly unknown[]): { stops: OtherStop[]; skipped: number } {
  const stops: OtherStop[] = []
  let skipped = 0
  for (const file of files) {
    const r = parseBusstops(file)
    stops.push(...r.stops)
    skipped += r.skipped
  }
  return { stops, skipped }
}

/** 事業者の target_id(P11:…)から事業者名(P11: を除いたもの。NFKC で整え、空白を除いてある) */
export function operatorNameOf(targetId: string): string {
  return targetId.startsWith('P11:') ? targetId.slice(4) : targetId
}

/**
 * 読み込んだ GTFS の事業者(agency_name。isOwnOperator で比べる)を除いた停留所。
 * 事業者が複数ある停留所は、自社を除いた事業者だけを残し、残らなければ停留所ごと除く。
 * nearOtherStops はこの結果を受ける(「判断材料を調べる」の欄と周知文で、除き方をそろえるため)
 */
export function excludeOwnOperators(stops: readonly OtherStop[], agencyNames: readonly string[]): OtherStop[] {
  const out: OtherStop[] = []
  for (const s of stops) {
    const others = s.operators.filter((o) => !isOwnOperator(operatorNameOf(o), agencyNames))
    if (others.length === s.operators.length) out.push(s)
    else if (others.length > 0) out.push({ ...s, operators: others })
  }
  return out
}

// ---- 空間索引 ----

const RAD = Math.PI / 180
/**
 * 候補の箱の広さ。緯度 1度の長さは 110,574m 以上、経度 1度の長さは 111,319m × cos(緯度) 以上なので、
 * 110,000m で割れば箱は実際の距離より広くなる(取りこぼさない)。箱は候補を絞るだけで、最後は distanceM で判定する
 */
const M_PER_DEG_LOWER = 110_000
const BOX_MARGIN = 1.01

interface StopIndex {
  stops: readonly OtherStop[]
  index: KDBush | null
}

const indexes = new WeakMap<readonly OtherStop[], StopIndex>()

/** 停留所の並びの空間索引(同じ配列には1回だけ作る) */
function indexOf(stops: readonly OtherStop[]): StopIndex {
  const cached = indexes.get(stops)
  if (cached) return cached
  let index: KDBush | null = null
  if (stops.length > 0) {
    index = new KDBush(stops.length)
    for (const s of stops) index.add(s.lon, s.lat)
    index.finish()
  }
  const built = { stops, index }
  indexes.set(stops, built)
  return built
}

/** (lat, lon) から radiusM 以内の停留所の番号(stops の中の位置。番号の順) */
function within(idx: StopIndex, lat: number, lon: number, radiusM: number): number[] {
  if (!idx.index || !Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusM >= 0)) return []
  const dLat = (radiusM / M_PER_DEG_LOWER) * BOX_MARGIN
  const north = Math.min(Math.abs(lat) + dLat, 89)
  const dLon = (radiusM / (M_PER_DEG_LOWER * Math.cos(north * RAD))) * BOX_MARGIN
  const center = { lat, lon }
  return idx.index
    .range(lon - dLon, lat - dLat, lon + dLon, lat + dLat)
    .filter((k) => distanceM(center, idx.stops[k]) <= radiusM)
    .sort((a, b) => a - b)
}

function byJa(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---- 1つの停留所の周り ----

/** 1つの停留所の周りの他社の停留所 */
export interface NearOtherStops {
  /** 半径内の他社の停留所(近い順。同じ距離なら停留所名・事業者の順) */
  stops: { stop: OtherStop; distanceM: number }[]
  /** その停留所の事業者(target_id。重複なし、順に並べたもの) */
  operators: string[]
  /** その停留所の系統名(重複なし、順に並べたもの) */
  routes: string[]
}

/**
 * (lat, lon) から radiusM 以内にある他社の停留所と系統名(周知文の代替手段に使う)。
 * otherStops は excludeOwnOperators で自社を除いたものを渡す。座標が数でなければ空
 */
export function nearOtherStops(
  lat: number,
  lon: number,
  otherStops: readonly OtherStop[],
  radiusM: number = OTHER_STOP_RADIUS_M,
): NearOtherStops {
  const idx = indexOf(otherStops)
  const center = { lat, lon }
  const stops = within(idx, lat, lon, radiusM)
    .map((k) => ({ stop: otherStops[k], distanceM: distanceM(center, otherStops[k]) }))
    .sort((a, b) => a.distanceM - b.distanceM || byJa(a.stop.name, b.stop.name) || byJa(a.stop.operators.join(), b.stop.operators.join()))
  const operators = new Set<string>()
  const routes = new Set<string>()
  for (const { stop } of stops) {
    for (const o of stop.operators) operators.add(o)
    for (const r of stop.routes) routes.add(r)
  }
  return { stops, operators: [...operators].sort(byJa), routes: [...routes].sort(byJa) }
}

// ---- 事業者ごとの重なり ----

/** 自社の停留所(stops.txt の stop_id と位置) */
export interface OwnStop {
  id: string
  lat: number
  lon: number
}

/** 1つの事業者の、自社の停留所との重なり */
export interface OperatorOverlap {
  /** 事業者の target_id(P11:…) */
  targetId: string
  /** この事業者の停留所が radiusM 以内にある、自社の停留所の stop_id(重複なし、順に並べたもの) */
  ownStopIds: string[]
  /** 自社のどれかの停留所から radiusM 以内にある、この事業者の停留所(緯度・経度・停留所名の順) */
  otherStops: OtherStop[]
  /** otherStops の系統名(重複なし、順に並べたもの) */
  routes: string[]
}

/**
 * 自社の停留所(ownStops)の radiusM 以内にある他事業者の停留所を、事業者(target_id)ごとに数える。
 * agencyNames(読み込んだ GTFS の agency_name)の事業者は isOwnOperator で除く。重なりの無い事業者は入らない。
 * 並びは target_id の順(重なりの数での並べ替えは呼ぶ側)。本数・時間帯は P11 に無いので返さない
 */
export function operatorOverlap(
  ownStops: readonly OwnStop[],
  otherStops: readonly OtherStop[],
  agencyNames: readonly string[],
  radiusM: number = OTHER_STOP_RADIUS_M,
): OperatorOverlap[] {
  const others = excludeOwnOperators(otherStops, agencyNames)
  const idx = indexOf(others)
  const byOperator = new Map<string, { own: Set<string>; stops: Set<number> }>()
  for (const own of ownStops) {
    for (const k of within(idx, own.lat, own.lon, radiusM)) {
      for (const op of others[k].operators) {
        let entry = byOperator.get(op)
        if (!entry) {
          entry = { own: new Set(), stops: new Set() }
          byOperator.set(op, entry)
        }
        entry.own.add(own.id)
        entry.stops.add(k)
      }
    }
  }
  return [...byOperator.entries()]
    .sort(([a], [b]) => byJa(a, b))
    .map(([targetId, { own, stops }]) => {
      const list = [...stops]
        .map((k) => others[k])
        .sort((a, b) => a.lat - b.lat || a.lon - b.lon || byJa(a.name, b.name))
      const routes = new Set<string>()
      for (const s of list) for (const r of s.routes) routes.add(r)
      return { targetId, ownStopIds: [...own].sort(byJa), otherStops: list, routes: [...routes].sort(byJa) }
    })
}
