/**
 * 地図に描く GeoJSON を作る。
 *
 * - セル:時間帯ごとの到達の可否を、properties の整数 m 1つにまとめる(時間帯 b に到達できれば 2^b のビットを立てる。
 *   docs/interfaces-1103.md の追記2)。到達できる見込みの無いセル(coverable でないセル)は地図に塗らないので、地物にしない
 * - 停留所:時間帯ごとの出発の数を、properties に b0, b1, … として入れる
 *
 * 時間帯を切り替えるときは、地図の paint の式を差し替えるだけにし、データは入れ直さない。
 */
import { meshBounds } from './mesh'
import type { ReachResult } from './reach'
import { inMeshRange, type StationInfo } from './refData'

/** GeoJSON の形(使う部分だけ。@types/geojson を直接は読み込めないため書いている) */
export interface PolygonFeature<P> {
  type: 'Feature'
  geometry: { type: 'Polygon'; coordinates: [number, number][][] }
  properties: P
}

export interface PointFeature<P> {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: P
}

export interface FeatureCollection<F> {
  type: 'FeatureCollection'
  features: F[]
}

/** 停留所の時間帯 i の出発の数を入れる properties の名前 */
export function bandProperty(i: number): string {
  return `b${i}`
}

/**
 * m に入れられる時間帯の数の上限。m は浮動小数(倍精度)の整数として地図の式で割り算するので、
 * 2^53 未満(52 個の時間帯まで)なら誤差なく扱える。画面の時間帯は最大 18(1時間ごと)
 */
export const MAX_MASK_BANDS = 52

/**
 * セルの properties。
 * m は時間帯ごとの到達の可否(時間帯 b に到達できれば 2^b のビットが立つ。すべての時間帯で外れれば 0)
 */
export interface CellProperties {
  /** 8分の1地域メッシュ(11 桁) */
  code: string
  /** 区分(urban・suburban・rural) */
  cls: string
  /** 推計人口 */
  pop: number
  m: number
}

/** 時間帯ごとの可否(reachable[b][i])を、セル i の整数 m にまとめる。ビット演算(32 ビット)は使わず、2^b を足す */
export function reachMask(reachable: readonly (readonly boolean[])[], i: number): number {
  let m = 0
  for (let b = 0; b < reachable.length; b++) if (reachable[b][i]) m += 2 ** b
  return m
}

/**
 * 到達圏のセルのうち、到達できる見込みのあるもの(coverable)を面(セルの四隅)にする。
 * 見込みの無いセル(ダイヤと関係なく外れるセル)は地図に塗らないので入れない(数は凡例と表に出す)。
 * properties:code(11 桁)、cls(区分)、pop(推計人口)、m(時間帯ごとの到達の可否のビット)。
 */
export function cellsToGeoJson(result: ReachResult): FeatureCollection<PolygonFeature<CellProperties>> {
  const bandCount = result.reachable.length
  if (bandCount > MAX_MASK_BANDS) {
    throw new RangeError(`地図に出せる時間帯は ${MAX_MASK_BANDS} 個までです:${bandCount}`)
  }
  const features: PolygonFeature<CellProperties>[] = []
  result.cells.forEach((code, i) => {
    if (!result.coverable[i]) return
    const { south, west, north, east } = meshBounds(code)
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
      properties: { code, cls: result.classes[i], pop: result.cellPopulation[i] ?? 0, m: reachMask(result.reachable, i) },
    })
  })
  return { type: 'FeatureCollection', features }
}

/** 停留所の properties。b0, b1, … はその時間帯の出発の数 */
export type StopProperties = { id: string; name: string } & Record<string, number | string>

/**
 * 停留所を点にする。properties:id、name、b{時間帯}(その時間帯の出発の数。counts に無ければ 0)。
 * 地域メッシュの範囲外の停留所((0, 0) など)は到達圏の計算から除くので、地図にも出さない。
 */
export function stopsToGeoJson(
  stops: readonly { id: string; name: string; lat: number; lon: number }[],
  counts: ReadonlyMap<string, number[]>,
  bandCount: number,
): FeatureCollection<PointFeature<StopProperties>> {
  const features: PointFeature<StopProperties>[] = []
  for (const s of stops) {
    if (!inMeshRange(s.lat, s.lon)) continue
    const c = counts.get(s.id)
    const properties: StopProperties = { id: s.id, name: s.name }
    for (let b = 0; b < bandCount; b++) properties[bandProperty(b)] = c?.[b] ?? 0
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties })
  }
  return { type: 'FeatureCollection', features }
}

/** 鉄道駅を点にする。properties:name、line */
export function stationsToGeoJson(stations: readonly StationInfo[]): FeatureCollection<PointFeature<{ name: string; line: string }>> {
  return {
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { name: s.name, line: s.line },
    })),
  }
}

/** 空の GeoJSON(レイヤーを先に作っておくときに使う) */
export function emptyCollection(): FeatureCollection<never> {
  return { type: 'FeatureCollection', features: [] }
}
