// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import type { Stop } from '@/gtfs/parse'
import { facilityMeshes, mergeFacilityFiles, researchCandidates } from '@/ref/facilities'
import { useGtfsStore } from '@/store/gtfs'
import { useMapStore } from '@/store/map'
import { useReachStore } from '@/store/reach'
import { useResearchStore } from '@/store/research'
import { FacilityLayer } from './FacilityLayer'
import { FACILITIES_LAYER, FACILITIES_SOURCE, facilitiesToGeoJson, facilityIcon, facilityIconId } from './facilityLayers'

const STOPS: Stop[] = [
  { id: 'S1', name: '停留所1', lat: 43.76, lon: 142.35, locationType: 0, parentStation: '' },
  { id: 'S2', name: '停留所2', lat: 43.78, lon: 142.37, locationType: 0, parentStation: '' },
  { id: 'S3', name: '停留所3', lat: 43.77, lon: 142.36, locationType: 0, parentStation: '' },
]

const FILE = {
  facilities: [
    { target_id: 'P04:hosp', kind: 'hospital', name: '病院', municipality: '旭川市', lat: 43.77, lon: 142.36, detail: { beds: 100 } },
    { target_id: 'P29:elem', kind: 'school', name: '小学校', municipality: '旭川市', lat: 43.771, lon: 142.36, detail: { school_type: '小学校' } },
  ],
}

/** MapLibre の Map の偽物(足したものを記録する) */
function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()
  const layers = new Map<string, object>()
  const images = new Set<string>()
  const layout: Record<string, unknown> = {}
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => void sources.set(id, { setData: vi.fn() }),
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: { id: string }) => void layers.set(layer.id, layer),
    removeLayer: (id: string) => void layers.delete(id),
    removeSource: (id: string) => void sources.delete(id),
    hasImage: (id: string) => images.has(id),
    addImage: (id: string) => void images.add(id),
    removeImage: (id: string) => void images.delete(id),
    setLayoutProperty: (layerId: string, name: string, value: unknown) => void (layout[`${layerId}.${name}`] = value),
    on: vi.fn(),
    off: vi.fn(),
    getCanvas: () => ({ style: {} }),
  }
  act(() => useMapStore.getState().setMap(map as unknown as MapLibreMap))
  return { map, sources, layers, images, layout }
}

beforeEach(() => {
  act(() => {
    useGtfsStore.setState({ feed: smallFeed(), stops: STOPS })
    useReachStore.setState({ origins: { stops: STOPS, unused: 0, nonStop: 0, noBoarding: 0 } })
    const { facilities, sources } = mergeFacilityFiles([FILE])
    useResearchStore.setState({ facilities: { status: 'ready', key: facilityMeshes(STOPS).join(','), facilities, sources } })
  })
})

afterEach(() => {
  cleanup()
  act(() => {
    useMapStore.getState().setMap(null)
    useGtfsStore.getState().clear()
    useReachStore.setState({ origins: null })
    useResearchStore.getState().reset()
  })
})

describe('facilityIcon', () => {
  it('種類ごとに形が違う(塗った画素の数が違う)', () => {
    const filled = (kind: Parameters<typeof facilityIcon>[0]) => {
      const { data } = facilityIcon(kind)
      let n = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++
      return n
    }
    const counts = new Set((['hospital', 'clinic', 'school', 'operator'] as const).map(filled))
    expect(counts.size).toBe(4)
  })
})

describe('facilitiesToGeoJson', () => {
  it('選んだ対象に selected: 1 を付ける', () => {
    const { facilities } = mergeFacilityFiles([FILE])
    const fc = facilitiesToGeoJson(researchCandidates(facilities, STOPS, []), new Set(['P04:hosp']))
    expect(fc.features.map((f) => [f.properties.id, f.properties.kind, f.properties.selected])).toEqual([
      ['P04:hosp', 'hospital', 1],
      ['P29:elem', 'school', 0],
    ])
    expect(fc.features[0].geometry.coordinates).toEqual([142.36, 43.77])
  })
})

describe('FacilityLayer', () => {
  it('前提情報の手順を開くまではレイヤーを足さない', () => {
    const { layers, images } = fakeMap()
    render(<FacilityLayer visible={false} />)
    expect(layers.size).toBe(0)
    expect(images.size).toBe(0)
  })

  it('開いたら記号・点・凡例を出し、閉じたら隠すだけ(消さない)。外れたら片付ける', () => {
    const { layers, images, sources, layout } = fakeMap()
    const { rerender, unmount } = render(<FacilityLayer visible />)
    expect(layers.has(FACILITIES_LAYER)).toBe(true)
    expect(images.has(facilityIconId('hospital'))).toBe(true)
    const data = sources.get(FACILITIES_SOURCE)!.setData.mock.calls.at(-1)![0] as { features: { properties: { selected: number } }[] }
    // 既定の選び方:病院は選び、小学校(優先順位の外)は選ばない
    expect(data.features.map((f) => f.properties.selected)).toEqual([1, 0])
    expect(layout[`${FACILITIES_LAYER}.visibility`]).toBe('visible')
    const legend = screen.getByRole('group', { name: '施設の凡例' })
    expect(legend.textContent).toContain('病院 1 件')
    expect(legend.textContent).toContain('学校 1 件')
    expect(legend.textContent).toContain('選んだ対象(1 件)')

    rerender(<FacilityLayer visible={false} />)
    expect(layout[`${FACILITIES_LAYER}.visibility`]).toBe('none')
    expect(layers.has(FACILITIES_LAYER)).toBe(true)
    expect(screen.queryByRole('group', { name: '施設の凡例' })).toBeNull()

    unmount()
    expect(layers.size).toBe(0)
    expect(sources.size).toBe(0)
    expect(images.size).toBe(0)
  })
  it('凡例と押した記号の名前は右上の列に縦に積み、下の端(時間帯の切り替え)には置かない', () => {
    const { map } = fakeMap()
    render(<FacilityLayer visible />)
    const legend = screen.getByRole('group', { name: '施設の凡例' })
    const column = screen.getByTestId('facility-overlay')
    expect(legend.parentElement).toBe(column)
    expect(column.className).toContain('top-24')
    expect(column.className).toContain('right-3')
    for (const el of [column, legend]) expect(el.className).not.toMatch(/(^|\s)bottom-/)

    // 記号を押すと、名前を凡例の下(同じ列)に出す
    const onClick = map.on.mock.calls.find((c) => c[0] === 'click')![2] as (e: unknown) => void
    act(() => onClick({ features: [{ properties: { name: '病院', kind: 'hospital' } }] }))
    const picked = screen.getByRole('status')
    expect(picked.textContent).toContain('病院')
    expect(picked.parentElement).toBe(column)
    expect([...column.children].indexOf(picked)).toBeGreaterThan([...column.children].indexOf(legend))
    expect(picked.className).not.toMatch(/(^|\s)(absolute|bottom-)/)
  })
})
