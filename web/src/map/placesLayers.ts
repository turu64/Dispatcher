import { PLACE_TYPES, type PlaceType } from '@/lib/placesFile'
import type { UserPlace } from '@/store/drivers'
import { loadSymbolImage, type FacilityMap, type LoadSymbolImage } from './facilityLayers'

/**
 * 利用者が置いた営業所(D05)の地図のレイヤーと記号。部品は PlacesLayer.tsx。
 * 記号の画像は施設の記号と同じく SVG の文字列から Image を作り、map.addImage で足す(facilityLayers.ts の loadSymbolImage)
 */

export const PLACES_SOURCE = 'user-places'
export const PLACES_LAYER = 'user-places-icon'
export const PLACE_IMAGE_PREFIX = 'user-place-'

/** 凡例の見出し */
export const PLACES_LEGEND_TITLE = '利用者が置いた場所'

/** 記号の色(到達圏・施設の記号の色と重ならない濃い色) */
export const PLACE_COLORS: Record<PlaceType, string> = {
  office: '#6A3D9A',
}

/** 記号の形(24 × 24)。営業所は四角(施設の記号の丸と形でも分ける) */
export const PLACE_PATHS: Record<PlaceType, string> = {
  office: 'M4.5 4.5h15v15h-15z',
}

const IMAGE_SIZE = 48
const IMAGE_PIXEL_RATIO = 3

export function placeImageId(type: PlaceType): string {
  return `${PLACE_IMAGE_PREFIX}${type}`
}

/** 地図の記号の画像の SVG(縁は白) */
export function placeSymbolSvg(type: PlaceType, size: number = IMAGE_SIZE): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><path d="${PLACE_PATHS[type]}" fill="${PLACE_COLORS[type]}" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>`
}

export interface PlaceFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: { id: string; type: PlaceType; name: string }
}

export function placesToGeoJson(places: readonly UserPlace[]): { type: 'FeatureCollection'; features: PlaceFeature[] } {
  return {
    type: 'FeatureCollection',
    features: places.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { id: p.id, type: p.type, name: p.name },
    })),
  }
}

/** 場所の地図の Map のうち、使う部分(テストでは偽物を渡す) */
export type PlacesMap = FacilityMap & {
  on(type: string, layerOrListener: unknown, listener?: unknown): unknown
  off(type: string, layerOrListener: unknown, listener?: unknown): unknown
  getCanvas(): { style: { cursor: string } }
}

/** 記号の画像を足す(足し済みの種類は飛ばす)。signal が中止されたら足さない */
export async function addPlaceImages(map: FacilityMap, signal?: AbortSignal, load: LoadSymbolImage = loadSymbolImage): Promise<void> {
  await Promise.all(
    PLACE_TYPES.map(async (type) => {
      const id = placeImageId(type)
      if (map.hasImage(id)) return
      const image = await load(placeSymbolSvg(type), IMAGE_SIZE)
      if (signal?.aborted || map.hasImage(id)) return
      map.addImage(id, image, { pixelRatio: IMAGE_PIXEL_RATIO })
    }),
  )
}

/** ソースとレイヤーを足す(足し済みなら何もしない)。画像は先に addPlaceImages で足しておく */
export function addPlaceLayers(map: FacilityMap): void {
  if (!map.getSource(PLACES_SOURCE)) map.addSource(PLACES_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  if (!map.getLayer(PLACES_LAYER)) {
    map.addLayer({
      id: PLACES_LAYER,
      type: 'symbol',
      source: PLACES_SOURCE,
      layout: {
        'icon-image': ['concat', PLACE_IMAGE_PREFIX, ['get', 'type']],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 1.1, 12, 1.4, 15, 1.6],
      },
    })
  }
}

export function removePlaceLayers(map: FacilityMap): void {
  if (map.getLayer(PLACES_LAYER)) map.removeLayer(PLACES_LAYER)
  if (map.getSource(PLACES_SOURCE)) map.removeSource(PLACES_SOURCE)
  for (const type of PLACE_TYPES) {
    const id = placeImageId(type)
    if (map.hasImage(id)) map.removeImage(id)
  }
}
