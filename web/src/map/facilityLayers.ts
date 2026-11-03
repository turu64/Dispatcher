/**
 * 前提情報の手順の地図のレイヤー:停留所の外接矩形 +2km にある施設・事業者(調査の対象の候補)の記号。
 * 色だけに頼らず形で分ける(病院は四角に十字、診療所は丸に十字、学校は三角、バス事業者はひし形)。
 * 選んでいる対象は濃く、選んでいない候補は薄く出す。部品は FacilityLayer.tsx
 */
import type { ResearchCandidate } from '@/ref/facilities'
import type { FacilityKind } from '@/ref/facilities'
import type { LayerMap } from './layers'

export const FACILITIES_SOURCE = 'research-facilities'
export const FACILITIES_LAYER = 'research-facilities-icon'

/** 記号の色(Okabe-Ito の配色から。形でも区別する) */
export const FACILITY_COLORS: Record<FacilityKind, string> = {
  hospital: '#D55E00',
  clinic: '#CC79A7',
  school: '#009E73',
  operator: '#56B4E9',
}

export const FACILITY_SHAPES: Record<FacilityKind, 'square-cross' | 'circle-cross' | 'triangle' | 'diamond'> = {
  hospital: 'square-cross',
  clinic: 'circle-cross',
  school: 'triangle',
  operator: 'diamond',
}

export const FACILITY_KINDS: readonly FacilityKind[] = ['hospital', 'clinic', 'school', 'operator']

export function facilityIconId(kind: FacilityKind): string {
  return `research-facility-${kind}`
}

/** 選んでいない候補の記号の不透明度 */
const UNSELECTED_OPACITY = 0.4

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/**
 * 記号の画素(RGBA)。形の中を色で塗り、縁を黒くする(背景の地図や到達圏の塗りの上でも見えるように)。
 * 十字は白。size は画素の数(pixelRatio 2 で置くので、画面では size / 2 の大きさ)
 */
export function facilityIcon(kind: FacilityKind, size = 28): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(size * size * 4)
  const fill = hexRgb(FACILITY_COLORS[kind])
  const dark: [number, number, number] = [0x1a, 0x1a, 0x1a]
  const white: [number, number, number] = [0xff, 0xff, 0xff]
  const shape = FACILITY_SHAPES[kind]
  const c = (size - 1) / 2
  const border = 2
  // (x, y) が形の中か。inset だけ内側に縮めた形で判定する(縁の判定に使う)
  const inside = (x: number, y: number, inset: number): boolean => {
    const dx = x - c
    const dy = y - c
    const r = c - 1 - inset
    switch (shape) {
      case 'square-cross':
        return Math.abs(dx) <= r && Math.abs(dy) <= r
      case 'circle-cross':
        return dx * dx + dy * dy <= r * r
      case 'diamond':
        return Math.abs(dx) + Math.abs(dy) <= r
      case 'triangle': {
        // 上向きの三角(上の頂点から下の辺まで)
        const top = c - r
        const bottom = c + r * 0.8
        if (y < top || y > bottom) return false
        const half = ((y - top) / (bottom - top)) * r
        return Math.abs(dx) <= half
      }
    }
  }
  const cross = (x: number, y: number): boolean => {
    if (shape !== 'square-cross' && shape !== 'circle-cross') return false
    const arm = size * 0.28
    const w = size * 0.09
    return (Math.abs(x - c) <= w && Math.abs(y - c) <= arm) || (Math.abs(y - c) <= w && Math.abs(x - c) <= arm)
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let color: [number, number, number] | null = null
      if (inside(x, y, border)) color = cross(x, y) ? white : fill
      else if (inside(x, y, 0)) color = dark
      if (!color) continue
      const i = (y * size + x) * 4
      data[i] = color[0]
      data[i + 1] = color[1]
      data[i + 2] = color[2]
      data[i + 3] = 0xff
    }
  }
  return { width: size, height: size, data }
}

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
        name: c.facility.name,
        selected: selected.has(c.facility.targetId) ? 1 : 0,
      },
    })),
  }
}

/** 施設の地図の Map のうち、使う部分(テストでは偽物を渡す) */
export type FacilityMap = Pick<LayerMap, 'getSource' | 'addSource' | 'getLayer' | 'addLayer' | 'removeLayer' | 'removeSource' | 'hasImage' | 'addImage' | 'removeImage'> & {
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown
}

/** 施設の記号・ソース・レイヤーを足す(足し済みなら何もしない) */
export function addFacilityLayers(map: FacilityMap): void {
  for (const kind of FACILITY_KINDS) {
    const id = facilityIconId(kind)
    if (!map.hasImage(id)) map.addImage(id, facilityIcon(kind), { pixelRatio: 2 })
  }
  if (!map.getSource(FACILITIES_SOURCE)) map.addSource(FACILITIES_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  if (!map.getLayer(FACILITIES_LAYER)) {
    map.addLayer({
      id: FACILITIES_LAYER,
      type: 'symbol',
      source: FACILITIES_SOURCE,
      layout: {
        'icon-image': ['match', ['get', 'kind'], ...FACILITY_KINDS.flatMap((k) => [k, facilityIconId(k)]), facilityIconId('school')],
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
  for (const kind of FACILITY_KINDS) {
    const id = facilityIconId(kind)
    if (map.hasImage(id)) map.removeImage(id)
  }
}
