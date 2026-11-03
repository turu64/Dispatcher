/**
 * 前提情報の手順の地図のレイヤー:停留所の外接矩形 +2km にある施設(調査の対象の候補)と、
 * こちらの停留所から 300m 以内にあるほかの事業者の停留所の記号。
 * 事業者そのものの点(停留所の重心)は出さない(位置に意味が無いため)。事業者は、重なる停留所で示す。
 * 記号の形と色は facilitySymbols.ts(国土地理院の地図記号に合わせ、色分けを残す)。
 * 記号の画像は SVG の文字列から Image を作り、map.addImage で足す(読み込みは非同期なので、足し終えてからレイヤーを足す)。
 * 選んでいる対象は濃く、選んでいない候補は薄く出す。一覧で焦点の当たっている対象(store/map.ts の highlightedTargetId)は、
 * 別のレイヤーで輪を付けて記号を大きくする(地図は動かさない)。部品は FacilityLayer.tsx
 */
import { operatorNameOf, type OperatorOverlap } from '@/ref/busstops'
import type { ResearchCandidate } from '@/ref/facilities'
import { FACILITY_IMAGE_PREFIX, FACILITY_SYMBOL_KINDS, facilitySymbolId, facilitySymbolKind, facilitySymbolSvg } from './facilitySymbols'
import type { LayerMap } from './layers'

export const FACILITIES_SOURCE = 'research-facilities'
export const FACILITIES_LAYER = 'research-facilities-icon'
/** 強調する対象の輪(記号の下に描く) */
export const FACILITIES_HIGHLIGHT_RING = 'research-facilities-highlight-ring'
/** 強調する対象の記号(大きくして、ほかの記号の上に描く) */
export const FACILITIES_HIGHLIGHT_LAYER = 'research-facilities-highlight-icon'
/** 地図の施設のレイヤーすべて(表示・非表示をそろえる) */
export const FACILITY_LAYER_IDS = [FACILITIES_HIGHLIGHT_RING, FACILITIES_LAYER, FACILITIES_HIGHLIGHT_LAYER] as const

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

/** 地図の点の1つ。id は強調の絞り込みに使う target_id(ほかの事業者の停留所は、その事業者の target_id) */
export interface FacilityFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: {
    id: string
    kind: ResearchCandidate['facility']['kind']
    symbol: ReturnType<typeof facilitySymbolKind>
    name: string
    /** 押したときに名前の横に出す文(ほかの事業者の停留所の事業者名と系統名) */
    detail: string
    selected: 0 | 1
  }
}

/**
 * 候補を地図の点にする。selected は選んでいる対象。
 * 事業者は点にせず、overlaps(事業者ごとの重なり)の停留所を、その事業者の target_id で点にする
 * (2つの事業者が同じ停留所に入るときは、事業者ごとに1つずつ置く。事業者の行で強調するため)
 */
export function facilitiesToGeoJson(
  candidates: readonly ResearchCandidate[],
  selected: ReadonlySet<string>,
  overlaps: Iterable<OperatorOverlap> = [],
): { type: 'FeatureCollection'; features: FacilityFeature[] } {
  const features: FacilityFeature[] = []
  for (const c of candidates) {
    if (c.facility.kind === 'operator') continue
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.facility.lon, c.facility.lat] },
      properties: {
        id: c.facility.targetId,
        kind: c.facility.kind,
        symbol: facilitySymbolKind(c.facility.kind, c.facility.schoolType),
        name: c.facility.name,
        detail: '',
        selected: selected.has(c.facility.targetId) ? 1 : 0,
      },
    })
  }
  for (const o of overlaps) {
    const operator = operatorNameOf(o.targetId)
    for (const stop of o.otherStops) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
        properties: {
          id: o.targetId,
          kind: 'operator',
          symbol: 'busstop',
          name: stop.name,
          detail: stop.routes.length > 0 ? `${operator}・系統:${stop.routes.join('、')}` : operator,
          selected: selected.has(o.targetId) ? 1 : 0,
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** 重なる停留所の数(2つの事業者が入る同じ停留所は1か所と数える) */
export function distinctOtherStops(overlaps: Iterable<OperatorOverlap>): number {
  const keys = new Set<string>()
  for (const o of overlaps) for (const s of o.otherStops) keys.add(`${s.lat},${s.lon},${s.name}`)
  return keys.size
}

/** 強調の絞り込み(id が一致する点だけ)。強調するものが無ければ、どの点にも当たらない値にする */
export function highlightFilter(targetId: string | null): unknown[] {
  return ['==', ['get', 'id'], targetId ?? '']
}

/** 施設の地図の Map のうち、使う部分(テストでは偽物を渡す) */
export type FacilityMap = Pick<LayerMap, 'getSource' | 'addSource' | 'getLayer' | 'addLayer' | 'removeLayer' | 'removeSource' | 'hasImage' | 'removeImage'> & {
  addImage(id: string, image: HTMLImageElement, options?: { pixelRatio?: number }): unknown
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown
  setFilter(layerId: string, filter: unknown): unknown
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

/** 強調の輪の色(地図の上で目立つ濃い色。記号の色とは別にする) */
const HIGHLIGHT_COLOR = '#1a1a1a'

/** 施設のソース・レイヤーを足す(足し済みなら何もしない)。記号の画像は先に addFacilityImages で足しておく */
export function addFacilityLayers(map: FacilityMap): void {
  if (!map.getSource(FACILITIES_SOURCE)) map.addSource(FACILITIES_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  // 強調の輪は記号の下に描く(記号を隠さない)
  if (!map.getLayer(FACILITIES_HIGHLIGHT_RING)) {
    map.addLayer({
      id: FACILITIES_HIGHLIGHT_RING,
      type: 'circle',
      source: FACILITIES_SOURCE,
      filter: highlightFilter(null),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 11, 12, 15, 15, 18],
        'circle-color': '#ffffff',
        'circle-opacity': 0.85,
        'circle-stroke-color': HIGHLIGHT_COLOR,
        'circle-stroke-width': 3,
      },
    })
  }
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
  // 強調する記号は大きくして、ほかの記号の上に描く(選んでいなくても濃く出す)
  if (!map.getLayer(FACILITIES_HIGHLIGHT_LAYER)) {
    map.addLayer({
      id: FACILITIES_HIGHLIGHT_LAYER,
      type: 'symbol',
      source: FACILITIES_SOURCE,
      filter: highlightFilter(null),
      layout: {
        'icon-image': ['concat', FACILITY_IMAGE_PREFIX, ['get', 'symbol']],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 1, 12, 1.4, 15, 1.6],
      },
    })
  }
}

/** 強調する対象を替える(輪と大きい記号のレイヤーを id で絞る)。地図は動かさない */
export function setFacilityHighlight(map: FacilityMap, targetId: string | null): void {
  for (const id of [FACILITIES_HIGHLIGHT_RING, FACILITIES_HIGHLIGHT_LAYER]) if (map.getLayer(id)) map.setFilter(id, highlightFilter(targetId))
}

export function removeFacilityLayers(map: FacilityMap): void {
  for (const id of [FACILITIES_HIGHLIGHT_LAYER, FACILITIES_HIGHLIGHT_RING]) if (map.getLayer(id)) map.removeLayer(id)
  if (map.getLayer(FACILITIES_LAYER)) map.removeLayer(FACILITIES_LAYER)
  if (map.getSource(FACILITIES_SOURCE)) map.removeSource(FACILITIES_SOURCE)
  for (const symbol of FACILITY_SYMBOL_KINDS) {
    const id = facilitySymbolId(symbol)
    if (map.hasImage(id)) map.removeImage(id)
  }
}
