/**
 * 到達圏の地図のレイヤー(セル・停留所・鉄道駅)。
 *
 * - データ(GeoJSON)は計算の結果が変わったときだけ入れ直す
 * - 時間帯の切り替えは、paint の式を差し替えるだけにする。セルは整数 m のビット(時間帯 b は 2^b)を式で取り出し、
 *   停留所は見る properties の名前(b0, b1, …)を差し替える
 * - 到達できる見込みの無いセルは GeoJSON に入れない(塗らない)
 *
 * MapLibre の Map のうち使う部分だけを LayerMap として受け取る(テストでは偽物を渡す)。
 */
import { bandProperty } from '@/reach/geojson'
import { REACH_COLORS, REACH_FILL_OPACITY, REACH_FILL_OPACITY_REACHABLE, STOP_COLORS } from './colors'

export const CELLS_SOURCE = 'reach-cells'
export const STOPS_SOURCE = 'reach-stops'
export const STATIONS_SOURCE = 'reach-stations'
export const CELLS_LAYER = 'reach-cells-fill'
export const STOPS_LAYER = 'reach-stops-circle'
export const STATIONS_LAYER = 'reach-stations-icon'
export const STATION_ICON = 'reach-station-icon'

/** Map のうち、ここで使う部分 */
export interface LayerMap {
  getSource(id: string): unknown
  addSource(id: string, source: object): unknown
  getLayer(id: string): unknown
  addLayer(layer: object, beforeId?: string): unknown
  removeLayer(id: string): unknown
  removeSource(id: string): unknown
  setPaintProperty(layerId: string, name: string, value: unknown): unknown
  hasImage(id: string): boolean
  addImage(id: string, image: { width: number; height: number; data: Uint8Array }, options?: { pixelRatio?: number }): unknown
  removeImage(id: string): unknown
  getStyle(): { layers?: { id: string; type: string }[] } | undefined
}

/** 停留所の時間帯 band の出発の数を読む式。時間帯が無い(-1)ときは、どの地物にも無い名前を読む(null になる) */
function bandValue(band: number): unknown[] {
  return ['get', band >= 0 ? bandProperty(band) : '_none']
}

/**
 * セルの時間帯 band のビット(到達できれば 1、外れれば 0)を取り出す式。
 * docs/interfaces-1103.md の追記2の形:["%", ["floor", ["/", ["get", "m"], 2^b]], 2]
 */
export function cellBandBit(band: number): unknown[] {
  return ['%', ['floor', ['/', ['get', 'm'], 2 ** band]], 2]
}

/** セルが時間帯 band に到達できるかの式。時間帯が無い(-1)ときは、どのセルも外れるとする */
function cellReachable(band: number): unknown {
  return band >= 0 ? ['==', cellBandBit(band), 1] : false
}

/** セルの塗りの色:その時間帯に到達できれば青、外れれば橙 */
export function cellFillColor(band: number): unknown[] {
  return ['case', cellReachable(band), REACH_COLORS.reachable, REACH_COLORS.unreachable]
}

/** セルの塗りの不透明度:到達できるセルは薄く、外れるセルは濃く */
export function cellFillOpacity(band: number): unknown[] {
  return ['case', cellReachable(band), REACH_FILL_OPACITY_REACHABLE, REACH_FILL_OPACITY]
}

/** 停留所の塗り:その時間帯に出発があれば黒、無ければ白(白抜き) */
export function stopCircleColor(band: number): unknown[] {
  return ['case', ['>', ['coalesce', bandValue(band), 0], 0], STOP_COLORS.active, STOP_COLORS.inactive]
}

/**
 * 鉄道駅の記号(四角の中に黒い四角。停留所の丸と形で区別する)。RGBA の画素を作る。
 * size は画素の数(pixelRatio 2 で地図に置くので、画面では size / 2 の大きさになる)。
 */
export function stationIcon(size = 24): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(size * size * 4)
  const dark = [0x1a, 0x1a, 0x1a]
  const white = [0xff, 0xff, 0xff]
  const border = Math.max(2, Math.round(size / 8))
  const halo = 1
  const innerFrom = Math.round(size * 0.35)
  const innerTo = size - innerFrom
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y)
      let rgb: number[]
      if (edge < halo) rgb = white
      else if (edge < halo + border) rgb = dark
      else if (x >= innerFrom && x < innerTo && y >= innerFrom && y < innerTo) rgb = dark
      else rgb = white
      const i = (y * size + x) * 4
      data[i] = rgb[0]
      data[i + 1] = rgb[1]
      data[i + 2] = rgb[2]
      data[i + 3] = 255
    }
  }
  return { width: size, height: size, data }
}

const EMPTY = { type: 'FeatureCollection', features: [] }

/** 背景の地図の最初の文字のレイヤー。セルはその下に入れ、地名が読めるようにする */
function firstSymbolLayer(map: LayerMap): string | undefined {
  return map.getStyle()?.layers?.find((l) => l.type === 'symbol')?.id
}

/**
 * レイヤーを足す。すでにあれば足さない(開発時の StrictMode では、足す→片付け→足すの順に2回走るため)。
 * データは空で作り、setGeoJson で入れる。
 */
export function addReachLayers(map: LayerMap): void {
  for (const id of [CELLS_SOURCE, STOPS_SOURCE, STATIONS_SOURCE]) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY })
  }
  if (!map.hasImage(STATION_ICON)) map.addImage(STATION_ICON, stationIcon(), { pixelRatio: 2 })

  if (!map.getLayer(CELLS_LAYER)) {
    map.addLayer(
      {
        id: CELLS_LAYER,
        type: 'fill',
        source: CELLS_SOURCE,
        paint: {
          'fill-color': cellFillColor(-1),
          'fill-opacity': cellFillOpacity(-1),
          // 隣り合うセルの境目に細い線が出ないようにする
          'fill-antialias': false,
        },
      },
      firstSymbolLayer(map),
    )
  }
  if (!map.getLayer(STOPS_LAYER)) {
    map.addLayer({
      id: STOPS_LAYER,
      type: 'circle',
      source: STOPS_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2, 12, 4, 15, 6],
        'circle-color': stopCircleColor(-1),
        'circle-stroke-color': STOP_COLORS.stroke,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 1],
      },
    })
  }
  if (!map.getLayer(STATIONS_LAYER)) {
    map.addLayer({
      id: STATIONS_LAYER,
      type: 'symbol',
      source: STATIONS_SOURCE,
      layout: {
        'icon-image': STATION_ICON,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 12, 1.2],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
  }
}

/**
 * レイヤーを片付ける。地図がすでに壊されている(BaseMap が先に remove した)ときは何もしない。
 */
export function removeReachLayers(map: LayerMap): void {
  try {
    if (!map.getStyle()) return
    for (const id of [STATIONS_LAYER, STOPS_LAYER, CELLS_LAYER]) if (map.getLayer(id)) map.removeLayer(id)
    for (const id of [STATIONS_SOURCE, STOPS_SOURCE, CELLS_SOURCE]) if (map.getSource(id)) map.removeSource(id)
    if (map.hasImage(STATION_ICON)) map.removeImage(STATION_ICON)
  } catch {
    // 壊された地図からは外せない(片付けるものも残っていない)
  }
}

/** ソースのデータを入れ直す。ソースが無ければ何もしない */
export function setGeoJson(map: LayerMap, sourceId: string, data: unknown): void {
  const source = map.getSource(sourceId) as { setData?: (d: unknown) => unknown } | undefined
  source?.setData?.(data)
}

/** 表示する時間帯を切り替える(paint の式を差し替えるだけ) */
export function setReachBand(map: LayerMap, band: number): void {
  if (map.getLayer(CELLS_LAYER)) {
    map.setPaintProperty(CELLS_LAYER, 'fill-color', cellFillColor(band))
    map.setPaintProperty(CELLS_LAYER, 'fill-opacity', cellFillOpacity(band))
  }
  if (map.getLayer(STOPS_LAYER)) map.setPaintProperty(STOPS_LAYER, 'circle-color', stopCircleColor(band))
}
