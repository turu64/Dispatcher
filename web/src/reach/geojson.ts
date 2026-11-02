/**
 * 地図に描く GeoJSON を作る。
 *
 * 時間帯ごとの値は、地物の properties に b0, b1, … として入れる。
 * 時間帯を切り替えるときは、地図の paint の式で見る名前(bandProperty)を差し替えるだけにし、データは入れ直さない。
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

/** 時間帯 i の値を入れる properties の名前 */
export function bandProperty(i: number): string {
  return `b${i}`
}

/** セルの properties。b0, b1, … は到達できれば 1、外れれば 0 */
export type CellProperties = { code: string; cls: string; pop: number } & Record<string, number | string>

/**
 * 到達圏のセルを面(セルの四隅)にする。
 * properties:code(11 桁)、cls(区分)、pop(推計人口)、b{時間帯}(到達できれば 1、外れれば 0)。
 */
export function cellsToGeoJson(result: ReachResult): FeatureCollection<PolygonFeature<CellProperties>> {
  const bandCount = result.reachable.length
  const features = result.cells.map((code, i) => {
    const { south, west, north, east } = meshBounds(code)
    const properties: CellProperties = { code, cls: result.classes[i], pop: result.cellPopulation[i] ?? 0 }
    for (let b = 0; b < bandCount; b++) properties[bandProperty(b)] = result.reachable[b][i] ? 1 : 0
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ] as [number, number][],
        ],
      },
      properties,
    }
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
