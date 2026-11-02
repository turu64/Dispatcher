import { useEffect, useMemo } from 'react'
import { formatDateJa } from '@/lib/dates'
import { cellsToGeoJson, emptyCollection, stationsToGeoJson, stopsToGeoJson } from '@/reach/geojson'
import { bandIndexForHour } from '@/reach/input'
import { pointsBounds } from '@/reach/refData'
import { useGtfsStore } from '@/store/gtfs'
import { useMapStore } from '@/store/map'
import { useReachStore } from '@/store/reach'
import {
  addReachLayers,
  CELLS_SOURCE,
  removeReachLayers,
  setGeoJson,
  setReachBand,
  STATIONS_SOURCE,
  STOPS_SOURCE,
} from './layers'
import MapLegend from './MapLegend'

/** 停留所の範囲に地図を合わせるときの余白(px)と、近づきすぎない上限のズーム */
const FIT_PADDING = 48
const FIT_MAX_ZOOM = 14

/**
 * 到達圏のセル・停留所・鉄道駅を地図に重ね、凡例を出す。
 * データは計算の結果が変わったときだけ入れ直し、時間帯の切り替えは paint の式を差し替えるだけにする。
 * レイヤーは地図の準備ができてから足し、外れたら片付ける。
 */
export default function ReachLayers() {
  const map = useMapStore((s) => s.map)
  const stops = useGtfsStore((s) => s.stops)
  const snapshot = useReachStore((s) => s.snapshot)
  const selectedHour = useReachStore((s) => s.selectedHour)
  const computing = useReachStore((s) => s.computing)
  const ref = useReachStore((s) => s.ref)

  const cells = useMemo(() => (snapshot ? cellsToGeoJson(snapshot.result) : emptyCollection()), [snapshot])
  const stopFeatures = useMemo(
    () => (snapshot ? stopsToGeoJson(stops, snapshot.departures.counts, snapshot.bands.length) : stopsToGeoJson(stops, new Map(), 0)),
    [stops, snapshot],
  )
  const stations = ref.status === 'done' && ref.result.ok ? ref.result.stations : null
  const stationFeatures = useMemo(() => (stations ? stationsToGeoJson(stations) : emptyCollection()), [stations])
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
    if (map) setReachBand(map, band)
  }, [map, band])

  // 読み込んだ GTFS の停留所の範囲に合わせる(地図の準備が後になっても合わせる)
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
  return (
    <MapLegend
      caption={`${formatDateJa(snapshot.date)} ${bandLabel}の徒歩圏`}
      computing={computing}
      showStations={stations !== null && stations.length > 0}
    />
  )
}
