import { useEffect, useMemo } from 'react'
import type { Stop } from '@/gtfs/parse'
import { formatDateJa } from '@/lib/dates'
import { emptyCollection, stationsToGeoJson, stopsToGeoJson } from '@/reach/geojson'
import { bandIndexForHour, refMarginM } from '@/reach/input'
import { pointsBounds } from '@/reach/refData'
import { useMapStore } from '@/store/map'
import { useReachStore } from '@/store/reach'
import { cellsWithBaseline, diffCountsOf, MODE_LABELS, stationsNear, zeroStopsToGeoJson } from './compareData'
import {
  addReachLayers,
  CELLS_SOURCE,
  removeReachLayers,
  setGeoJson,
  setReachBand,
  STATIONS_SOURCE,
  STOPS_SOURCE,
  ZERO_STOPS_SOURCE,
  type CellPaintMode,
} from './layers'
import MapLegend from './MapLegend'

/** 停留所の範囲に地図を合わせるときの余白(px)と、近づきすぎない上限のズーム */
const FIT_PADDING = 48
const FIT_MAX_ZOOM = 14

const NO_STOPS: Stop[] = []

/**
 * 到達圏のセル・停留所・鉄道駅を地図に重ね、凡例を出す。
 * 停留所の点は、到達圏の起点と同じ停留所(stop_times に乗れる行がある、location_type が 0 か空のもの)だけを出す。
 * 鉄道駅は、起点から「バス停の距離の最大 + 駅の距離の最大」以内のものだけを出す(参照データの1次メッシュには遠い駅も入るため)。
 * 到達できる見込みの無いセルは塗らず、凡例に数を出す。
 * 減便後の GTFS があれば、塗り分け(減便前・減便後・前後の差の4色)を凡例で切り替え、前後の差では運行がゼロになる停留所に × を付ける。
 * データは計算の結果が変わったときだけ入れ直し、時間帯と塗り分けの切り替えは paint の式を差し替えるだけにする。
 * レイヤーは地図の準備ができてから足し、外れたら片付ける。
 */
export default function ReachLayers() {
  const map = useMapStore((s) => s.map)
  const origins = useReachStore((s) => s.origins)
  const stops = origins?.stops ?? NO_STOPS
  const snapshot = useReachStore((s) => s.snapshot)
  const selectedHour = useReachStore((s) => s.selectedHour)
  const computing = useReachStore((s) => s.computing)
  const ref = useReachStore((s) => s.ref)
  const compareMode = useReachStore((s) => s.compareMode)
  const params = useReachStore((s) => s.params)

  const baseline = snapshot?.baseline
  // 減便後の GTFS が無いときは、表示する側(基準)の可否 m で2色に塗る
  const mode: CellPaintMode = baseline ? compareMode : 'after'
  const cells = useMemo(
    () => (snapshot ? cellsWithBaseline(snapshot.result, snapshot.baseline?.result) : emptyCollection()),
    [snapshot],
  )
  const stopFeatures = useMemo(
    () => (snapshot ? stopsToGeoJson(stops, snapshot.departures.counts, snapshot.bands.length) : stopsToGeoJson(stops, new Map(), 0)),
    [stops, snapshot],
  )
  const loadedStations = ref.status === 'done' && ref.result.ok ? ref.result.stations : null
  const margin = refMarginM(snapshot?.params ?? params)
  const stations = useMemo(() => (loadedStations ? stationsNear(loadedStations, stops, margin) : null), [loadedStations, stops, margin])
  const stationFeatures = useMemo(() => (stations ? stationsToGeoJson(stations) : emptyCollection()), [stations])
  const zeroStops = snapshot?.zeroStops
  const zeroFeatures = useMemo(
    () => (mode === 'diff' && zeroStops ? zeroStopsToGeoJson(zeroStops, stops) : emptyCollection()),
    [mode, zeroStops, stops],
  )
  const band = snapshot ? bandIndexForHour(snapshot.bands, selectedHour) : -1
  const bounds = useMemo(() => pointsBounds(stops), [stops])

  useEffect(() => {
    if (!map) return
    addReachLayers(map)
    return () => removeReachLayers(map)
  }, [map])

  useEffect(() => {
    if (map) setGeoJson(map, CELLS_SOURCE, cells)
  }, [map, cells])

  useEffect(() => {
    if (map) setGeoJson(map, STOPS_SOURCE, stopFeatures)
  }, [map, stopFeatures])

  useEffect(() => {
    if (map) setGeoJson(map, STATIONS_SOURCE, stationFeatures)
  }, [map, stationFeatures])

  useEffect(() => {
    if (map) setGeoJson(map, ZERO_STOPS_SOURCE, zeroFeatures)
  }, [map, zeroFeatures])

  useEffect(() => {
    if (map) setReachBand(map, band, mode)
  }, [map, band, mode])

  // 読み込んだ GTFS の起点の停留所の範囲に合わせる(地図の準備が後になっても合わせる)
  useEffect(() => {
    if (!map || !bounds) return
    map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 0 },
    )
  }, [map, bounds])

  if (!snapshot) return null
  const bandLabel = band >= 0 ? snapshot.bands[band].label : ''
  const usedFallback = snapshot.result.usedFallback
  const nonCoverable = usedFallback ? null : (baseline ?? snapshot).summary.nonCoverableCells
  return (
    <MapLegend
      caption={`${formatDateJa(snapshot.date)} ${bandLabel}の徒歩圏${baseline ? `(${MODE_LABELS[mode]})` : ''}`}
      computing={computing}
      showStations={stations !== null && stations.length > 0}
      nonCoverableCells={nonCoverable}
      compare={
        baseline
          ? {
              mode,
              onModeChange: (m) => useReachStore.getState().setCompareMode(m),
              counts: band >= 0 ? diffCountsOf(baseline.result, snapshot.result, band) : null,
              draft: snapshot.draft === true,
              zeroStops: {
                feed: zeroStops?.filter((z) => z.scope === 'feed').length ?? 0,
                day: zeroStops?.filter((z) => z.scope === 'day').length ?? 0,
              },
            }
          : undefined
      }
    />
  )
}
