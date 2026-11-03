/**
 * 地図に出すデータのうち、減便の前後の比較と鉄道駅の絞り込みに関わるもの(docs/interfaces-1104.md §7)。
 * 計算は reach/ の結果を並べ替えるだけで、到達圏は計算し直さない。
 */
import type { Stop } from '@/gtfs/parse'
import type { ZeroServiceStop } from '@/reach/compare'
import { cellsToGeoJson, reachMask, type CellProperties, type FeatureCollection, type PointFeature, type PolygonFeature } from '@/reach/geojson'
import { distanceM } from '@/reach/mesh'
import type { ReachResult } from '@/reach/reach'
import { inMeshRange, type StationInfo } from '@/reach/refData'
import type { CellPaintMode } from './layers'

/** 地図の塗り分けの名前(凡例の切り替えと見出しに使う) */
export const MODE_LABELS: Record<CellPaintMode, string> = {
  before: '減便前',
  after: '減便後',
  diff: '前後の差',
}

/** セルの properties に、基準(減便前)の時間帯ごとの可否 m0 を足したもの */
export type CompareCellProperties = CellProperties & { m0?: number }

/**
 * 表示する側の到達圏のセル(cellsToGeoJson)に、baseline があれば基準の可否を m0 として足す。
 * 基準と編集後は同じ起点で計算するので、セルは同じ並び(compareReach が確かめている)。並びが違っても、セルの番号で引いて入れる
 */
export function cellsWithBaseline(
  result: ReachResult,
  baseline?: ReachResult,
): FeatureCollection<PolygonFeature<CompareCellProperties>> {
  const fc = cellsToGeoJson(result) as FeatureCollection<PolygonFeature<CompareCellProperties>>
  if (!baseline) return fc
  const index = new Map<string, number>()
  baseline.cells.forEach((code, i) => index.set(code, i))
  for (const f of fc.features) {
    const i = index.get(f.properties.code)
    f.properties.m0 = i === undefined ? 0 : reachMask(baseline.reachable, i)
  }
  return fc
}

/**
 * 起点の停留所のどれかから radiusM 以内にある駅だけ。参照データの1次メッシュには、停留所から遠い駅(北見・滝川など)も入っているため。
 * radiusM は「バス停の距離の最大 + 駅の距離の最大」(refMarginM。参照データを読む範囲と同じ)
 */
export function stationsNear(stations: readonly StationInfo[], origins: readonly { lat: number; lon: number }[], radiusM: number): StationInfo[] {
  const points = origins.filter((p) => inMeshRange(p.lat, p.lon))
  if (points.length === 0 || !(radiusM >= 0)) return []
  // 緯度・経度の差で先にふるい落とす(緯度 1度は 110km 以上、経度 1度は北緯 66度でも 45km 以上)
  const dLat = radiusM / 110_000
  return stations.filter((s) => {
    const dLon = radiusM / (111_000 * Math.cos((s.lat * Math.PI) / 180))
    return points.some(
      (p) => Math.abs(p.lat - s.lat) <= dLat && Math.abs(p.lon - s.lon) <= dLon && distanceM(p, s) <= radiusM,
    )
  })
}

/** 選んだ時間帯の、前後の差の4つのセルの数(地図の凡例に出す) */
export interface DiffCounts {
  lost: number
  bothUnreachable: number
  bothReachable: number
  gained: number
}

/**
 * 基準と編集後の結果から、時間帯 band の4つのセルの数を数える。数えるのは到達できる見込みのあるセルだけ
 * (見込みの無いセルは地図に塗らない)。band が範囲の外なら null
 */
export function diffCountsOf(before: ReachResult, after: ReachResult, band: number): DiffCounts | null {
  const was = before.reachable[band]
  const now = after.reachable[band]
  if (!was || !now) return null
  const counts: DiffCounts = { lost: 0, bothUnreachable: 0, bothReachable: 0, gained: 0 }
  for (let i = 0; i < after.cells.length; i++) {
    if (!after.coverable[i]) continue
    if (was[i] && !now[i]) counts.lost++
    else if (!was[i] && !now[i]) counts.bothUnreachable++
    else if (!was[i] && now[i]) counts.gained++
    else counts.bothReachable++
  }
  return counts
}

/** 運行がゼロになる停留所の点。properties:id、name、scope('feed' は出力のどの日にも便が来ない) */
export function zeroStopsToGeoJson(
  zeroStops: readonly ZeroServiceStop[],
  origins: readonly Stop[],
): FeatureCollection<PointFeature<{ id: string; name: string; scope: 'day' | 'feed' }>> {
  const byId = new Map<string, Stop>()
  for (const s of origins) if (!byId.has(s.id)) byId.set(s.id, s)
  const features: PointFeature<{ id: string; name: string; scope: 'day' | 'feed' }>[] = []
  for (const z of zeroStops) {
    const s = byId.get(z.stopId)
    if (!s || !inMeshRange(s.lat, s.lon)) continue
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: z.stopId, name: z.name, scope: z.scope } })
  }
  return { type: 'FeatureCollection', features }
}
