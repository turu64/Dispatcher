/**
 * 前提情報の手順の地図のレイヤー:停留所の外接矩形 +2km にある施設・事業者(調査の対象の候補)の記号。
 * 記号の形と色は facilitySymbols.ts(国土地理院の地図記号に合わせ、色分けを残す)。
 * 記号の画像は SVG の文字列から Image を作り、map.addImage で足す(読み込みは非同期なので、足し終えてからレイヤーを足す)。
 * 選んでいる対象は濃く、選んでいない候補は薄く出す。部品は FacilityLayer.tsx
 */
import type { ResearchCandidate } from '@/ref/facilities'
import { FACILITY_IMAGE_PREFIX, FACILITY_SYMBOL_KINDS, facilitySymbolId, facilitySymbolKind, facilitySymbolSvg } from './facilitySymbols'
import type { LayerMap } from './layers'

export const FACILITIES_SOURCE = 'research-facilities'
export const FACILITIES_LAYER = 'research-facilities-icon'

/** 記号の画像の画素の大きさ(pixelRatio 3 で置くので、画面では 16px 前後) */
const IMAGE_SIZE = 48
const IMAGE_PIXEL_RATIO = 3

/** 選んでいない候補の記号の不透明度 */
const UNSELECTED_OPACITY = 0.4

/** SVG の文字列から画像を作る(テストでは差し替える) */
export type LoadSymbolImage = (svg: string, size: number) => Promise<HTMLImageElement>

/** 既定の画像の作り方:SVG を data URL にして Image に読ませる */
export const loadSymbolImage: LoadSymbolImage = (svg, size) =>
  new Promise((resolve, reject) => {
    const img = new Image(size, size)
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('施設の記号の画像を作れませんでした'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })

/** 候補を地図の点にする。selected は選んでいる対象 */
export function facilitiesToGeoJson(candidates: readonly ResearchCandidate[], selected: ReadonlySet<string>) {
  return {
    type: 'FeatureCollection' as const,
    features: candidates.map((c) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [c.facility.lon, c.facility.lat] },
      properties: {
        id: c.facility.targetId,
        kind: c.facility.kind,
        symbol: facilitySymbolKind(c.facility.kind, c.facility.schoolType),
        name: c.facility.name,
        selected: selected.has(c.facility.targetId) ? 1 : 0,
      },
    })),
  }
}

/** 施設の地図の Map のうち、使う部分(テストでは偽物を渡す) */
export type FacilityMap = Pick<LayerMap, 'getSource' | 'addSource' | 'getLayer' | 'addLayer' | 'removeLayer' | 'removeSource' | 'hasImage' | 'removeImage'> & {
  addImage(id: string, image: HTMLImageElement, options?: { pixelRatio?: number }): unknown
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown
}

/**
 * 記号の画像を足す(足し済みの種類は飛ばす)。画像の読み込みは非同期なので、終わるまで待つ。
 * signal が中止されたら、足さずに止める(待っている間に地図から外れたとき、外れた後に画像を足さないため)
 */
export async function addFacilityImages(map: FacilityMap, signal?: AbortSignal, load: LoadSymbolImage = loadSymbolImage): Promise<void> {
  await Promise.all(
    FACILITY_SYMBOL_KINDS.map(async (symbol) => {
      const id = facilitySymbolId(symbol)
      if (map.hasImage(id)) return
      const image = await load(facilitySymbolSvg(symbol, IMAGE_SIZE), IMAGE_SIZE)
      if (signal?.aborted || map.hasImage(id)) return
      map.addImage(id, image, { pixelRatio: IMAGE_PIXEL_RATIO })
    }),
  )
}

/** 施設のソース・レイヤーを足す(足し済みなら何もしない)。記号の画像は先に addFacilityImages で足しておく */
export function addFacilityLayers(map: FacilityMap): void {
  if (!map.getSource(FACILITIES_SOURCE)) map.addSource(FACILITIES_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  if (!map.getLayer(FACILITIES_LAYER)) {
    map.addLayer({
      id: FACILITIES_LAYER,
      type: 'symbol',
      source: FACILITIES_SOURCE,
      layout: {
        'icon-image': ['concat', FACILITY_IMAGE_PREFIX, ['get', 'symbol']],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // 選んだ対象を上に描く
        'symbol-sort-key': ['get', 'selected'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 12, 0.9, 15, 1.1],
      },
      paint: {
        'icon-opacity': ['case', ['==', ['get', 'selected'], 1], 1, UNSELECTED_OPACITY],
      },
    })
  }
}

export function removeFacilityLayers(map: FacilityMap): void {
  if (map.getLayer(FACILITIES_LAYER)) map.removeLayer(FACILITIES_LAYER)
  if (map.getSource(FACILITIES_SOURCE)) map.removeSource(FACILITIES_SOURCE)
  for (const symbol of FACILITY_SYMBOL_KINDS) {
    const id = facilitySymbolId(symbol)
    if (map.hasImage(id)) map.removeImage(id)
  }
}
