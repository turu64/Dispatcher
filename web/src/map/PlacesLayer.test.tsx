// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import { useDriversStore, type UserPlace } from '@/store/drivers'
import { useMapStore } from '@/store/map'
import PlacesLayer from './PlacesLayer'
import {
  addPlaceImages,
  addPlaceLayers,
  PLACE_COLORS,
  PLACES_LAYER,
  PLACES_LEGEND_TITLE,
  PLACES_SOURCE,
  placeImageId,
  placeSymbolSvg,
  placesToGeoJson,
  removePlaceLayers,
} from './placesLayers'

type Handler = (e: unknown) => void

/** MapLibre の Map の偽物(足したものと、登録した操作を記録する) */
function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()
  const layers = new Map<string, object>()
  const images = new Set<string>()
  const layout: Record<string, unknown> = {}
  // 'click' → 地図全体の操作、'click:<layer>' → レイヤーの操作
  const handlers = new Map<string, Set<Handler>>()
  const canvas = { style: { cursor: '' } }
  const keyOf = (type: string, layer: unknown) => (typeof layer === 'string' ? `${type}:${layer}` : type)
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
    setFilter: vi.fn(),
    on: (type: string, a: unknown, b?: unknown) => {
      const key = keyOf(type, a)
      const fn = (typeof a === 'string' ? b : a) as Handler
      if (!handlers.has(key)) handlers.set(key, new Set())
      handlers.get(key)!.add(fn)
    },
    off: (type: string, a: unknown, b?: unknown) => {
      handlers.get(keyOf(type, a))?.delete((typeof a === 'string' ? b : a) as Handler)
    },
    getCanvas: () => canvas,
    // 地図を動かす操作(場所を置いても呼ばないことを確かめる)
    flyTo: vi.fn(),
    easeTo: vi.fn(),
    jumpTo: vi.fn(),
    fitBounds: vi.fn(),
  }
  /** 地図を押す(地図全体の操作のあと、レイヤーの操作) */
  const click = (lng: number, lat: number, features?: unknown[]) => {
    const originalEvent = {}
    for (const fn of [...(handlers.get('click') ?? [])]) fn({ lngLat: { lng, lat }, originalEvent })
    if (features) for (const fn of [...(handlers.get(`click:${PLACES_LAYER}`) ?? [])]) fn({ lngLat: { lng, lat }, originalEvent, features })
  }
  return { map, sources, layers, images, layout, handlers, canvas, click }
}

const immediateImage = () => Promise.resolve({} as HTMLImageElement)

const PLACE: UserPlace = { id: 'p1', type: 'office', kind: 'depot', name: '営業所A', lat: 43.77, lon: 142.36 }

function resetDrivers(places: UserPlace[] = []) {
  useDriversStore.setState({ shortage: null, params: { ...DUTY_DEFAULTS }, places, placing: null })
}

afterEach(() => {
  cleanup()
  resetDrivers()
  useMapStore.setState({ map: null })
})

function setup(places: UserPlace[] = []) {
  const fake = fakeMap()
  resetDrivers(places)
  useMapStore.setState({ map: fake.map as unknown as MapLibreMap })
  return fake
}

describe('PlacesLayer の材料', () => {
  it('場所を地図の点にする(経度・緯度の順)', () => {
    expect(placesToGeoJson([PLACE])).toEqual({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [142.36, 43.77] }, properties: { id: 'p1', type: 'office', name: '営業所A' } }],
    })
  })

  it('種類ごとに色と形の違う画像を1回ずつ足し、片付けで消す', async () => {
    const fake = fakeMap()
    const load = vi.fn(immediateImage)
    await addPlaceImages(fake.map, undefined, load)
    await addPlaceImages(fake.map, undefined, load)
    expect(load).toHaveBeenCalledTimes(3)
    expect([...fake.images].sort()).toEqual([placeImageId('garage'), placeImageId('office'), placeImageId('rest')])
    expect(new Set(Object.values(PLACE_COLORS)).size).toBe(3)
    const svgs = (['office', 'garage', 'rest'] as const).map((t) => placeSymbolSvg(t))
    expect(new Set(svgs.map((s) => s.match(/d="([^"]+)"/)?.[1])).size).toBe(3)
    addPlaceLayers(fake.map)
    expect(fake.sources.has(PLACES_SOURCE)).toBe(true)
    expect(fake.layers.has(PLACES_LAYER)).toBe(true)
    removePlaceLayers(fake.map)
    expect(fake.sources.size + fake.layers.size + fake.images.size).toBe(0)
  })
})

describe('PlacesLayer(地図の記号と凡例)', () => {
  it('場所が無ければ何も出さず、レイヤーも足さない', async () => {
    const fake = setup()
    render(<PlacesLayer visible loadImage={immediateImage} />)
    await act(async () => {})
    expect(screen.queryByTestId('places-overlay')).toBeNull()
    expect(fake.layers.size).toBe(0)
  })

  it('場所があれば記号を足し、凡例に「利用者が置いた場所」と種類ごとの数を出す', async () => {
    const fake = setup([PLACE, { ...PLACE, id: 'p2', type: 'rest', kind: 'rest', name: '休憩所' }])
    render(<PlacesLayer visible loadImage={immediateImage} />)
    await waitFor(() => expect(fake.layers.has(PLACES_LAYER)).toBe(true))
    await waitFor(() => expect(fake.sources.get(PLACES_SOURCE)!.setData).toHaveBeenCalled())
    const data = fake.sources.get(PLACES_SOURCE)!.setData.mock.lastCall![0] as { features: unknown[] }
    expect(data.features).toHaveLength(2)
    expect(fake.layout[`${PLACES_LAYER}.visibility`]).toBe('visible')
    const legend = screen.getByRole('group', { name: '利用者が置いた場所の凡例' })
    expect(legend.textContent).toContain(PLACES_LEGEND_TITLE)
    expect(legend.textContent).toContain('営業所 1 か所')
    expect(legend.textContent).toContain('休憩施設 1 か所')
    expect(legend.textContent).not.toContain('車庫')
  })

  it('地図を隠す手順・場所を見せない手順(visible が false)では何も出さず、記号も隠す', async () => {
    const fake = setup([PLACE])
    const { rerender } = render(<PlacesLayer visible loadImage={immediateImage} />)
    await waitFor(() => expect(fake.layers.has(PLACES_LAYER)).toBe(true))
    rerender(<PlacesLayer visible={false} loadImage={immediateImage} />)
    await waitFor(() => expect(fake.layout[`${PLACES_LAYER}.visibility`]).toBe('none'))
    expect(screen.queryByTestId('places-overlay')).toBeNull()
  })

  it('記号を押すと名前と種類を出す', async () => {
    const fake = setup([PLACE])
    render(<PlacesLayer visible loadImage={immediateImage} />)
    await waitFor(() => expect(fake.handlers.get(`click:${PLACES_LAYER}`)?.size).toBe(1))
    act(() => fake.click(142.36, 43.77, [{ properties: { id: 'p1', name: '営業所A', type: 'office' } }]))
    expect(screen.getByRole('status').textContent).toContain('営業所A')
  })
})

describe('PlacesLayer(地図で置く)', () => {
  it('置き始めると十字の印にし、地図を1回押した位置に場所を足して置き終える。地図は動かさない', async () => {
    const fake = setup()
    render(<PlacesLayer visible loadImage={immediateImage} />)
    act(() => useDriversStore.getState().startPlacing('garage'))
    expect(fake.canvas.style.cursor).toBe('crosshair')
    expect(screen.getByRole('status').textContent).toContain('地図を押すと車庫を置きます(Esc でやめる)')
    act(() => fake.click(142.4, 43.8))
    const places = useDriversStore.getState().places
    expect(places).toHaveLength(1)
    expect(places[0]).toMatchObject({ type: 'garage', kind: 'garage', name: '車庫 1', lat: 43.8, lon: 142.4 })
    expect(useDriversStore.getState().placing).toBeNull()
    expect(fake.canvas.style.cursor).toBe('')
    // 置き終えたら、もう一度押しても足さない
    act(() => fake.click(142.5, 43.9))
    expect(useDriversStore.getState().places).toHaveLength(1)
    for (const fn of [fake.map.flyTo, fake.map.easeTo, fake.map.jumpTo, fake.map.fitBounds]) expect(fn).not.toHaveBeenCalled()
  })

  it('記号の上を押して置いても、その記号の名前は出さない', async () => {
    const fake = setup([PLACE])
    render(<PlacesLayer visible loadImage={immediateImage} />)
    await waitFor(() => expect(fake.handlers.get(`click:${PLACES_LAYER}`)?.size).toBe(1))
    act(() => useDriversStore.getState().startPlacing('rest'))
    act(() => fake.click(142.36, 43.77, [{ properties: { id: 'p1', name: '営業所A', type: 'office' } }]))
    expect(useDriversStore.getState().places.map((p) => p.name)).toEqual(['営業所A', '休憩施設 1'])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('置く操作の無い手順(placeable が false)では地図を押しても足さず、置いている途中ならやめる', async () => {
    const fake = setup()
    const { rerender } = render(<PlacesLayer visible loadImage={immediateImage} />)
    act(() => useDriversStore.getState().startPlacing('office'))
    expect(fake.canvas.style.cursor).toBe('crosshair')
    rerender(<PlacesLayer visible placeable={false} loadImage={immediateImage} />)
    expect(useDriversStore.getState().placing).toBeNull()
    expect(fake.canvas.style.cursor).toBe('')
    act(() => useDriversStore.getState().startPlacing('office'))
    act(() => fake.click(142.4, 43.8))
    expect(useDriversStore.getState().places).toHaveLength(0)
  })

  it('Esc でやめる', async () => {
    const fake = setup()
    render(<PlacesLayer visible loadImage={immediateImage} />)
    act(() => useDriversStore.getState().startPlacing('office'))
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useDriversStore.getState().placing).toBeNull()
    expect(fake.canvas.style.cursor).toBe('')
    expect(fake.handlers.get('click')?.size ?? 0).toBe(0)
    act(() => fake.click(142.4, 43.8))
    expect(useDriversStore.getState().places).toHaveLength(0)
  })

  it('場所を見せない手順に移ると、置くのをやめる', async () => {
    setup()
    const { rerender } = render(<PlacesLayer visible loadImage={immediateImage} />)
    act(() => useDriversStore.getState().startPlacing('office'))
    rerender(<PlacesLayer visible={false} loadImage={immediateImage} />)
    expect(useDriversStore.getState().placing).toBeNull()
  })
})
