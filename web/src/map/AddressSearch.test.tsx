// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMapStore } from '@/store/map'
import AddressSearch, { ADDRESS_SEARCH_ATTRIBUTION, SEARCH_SOURCE_ID } from './AddressSearch'
import { GeocodeError, type GeocodeResult } from './geocode'

const searchAddress = vi.fn<(q: string, o?: { signal?: AbortSignal }) => Promise<GeocodeResult[]>>()
vi.mock('./geocode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./geocode')>()),
  searchAddress: (q: string, o?: { signal?: AbortSignal }) => searchAddress(q, o),
}))

const MIYASHITA: GeocodeResult = { label: '宮下通八丁目、宮下通、神楽、旭川市', lat: 43.7634, lon: 142.3588, bbox: [142.3561, 43.7616, 142.3615, 43.7651] }
const STATION: GeocodeResult = { label: '旭川駅、宮下通、旭川市', lat: 43.7627, lon: 142.3581, bbox: null }

function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()
  const layers = new Set<string>()
  const map = {
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string) => sources.set(id, { setData: vi.fn() })),
    getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
    addLayer: vi.fn((l: { id: string }) => layers.add(l.id)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    flyTo: vi.fn(),
    fitBounds: vi.fn(),
  }
  act(() => useMapStore.getState().setMap(map as unknown as MapLibreMap))
  return { map, sources, layers }
}

const box = () => screen.getByRole('textbox', { name: '住所・地名' }) as HTMLInputElement
const submit = () => screen.getByRole('button', { name: '検索' }) as HTMLButtonElement

beforeEach(() => searchAddress.mockReset())
afterEach(() => {
  cleanup()
  act(() => useMapStore.getState().setMap(null))
})

describe('AddressSearch', () => {
  it('地図が無い・隠れているときは出さない', () => {
    const { rerender } = render(<AddressSearch />)
    expect(screen.queryByRole('search')).toBeNull()
    fakeMap()
    rerender(<AddressSearch visible={false} />)
    expect(screen.queryByRole('search')).toBeNull()
  })

  it('入力の途中では送らず、「検索」を押したときだけ送る。空のときは押せない', async () => {
    fakeMap()
    render(<AddressSearch />)
    expect(submit().disabled).toBe(true)
    fireEvent.change(box(), { target: { value: '旭川市宮下通' } })
    expect(searchAddress).not.toHaveBeenCalled()
    searchAddress.mockResolvedValue([MIYASHITA, STATION])
    fireEvent.click(submit())
    await screen.findByRole('list', { name: '住所検索の結果' })
    expect(searchAddress).toHaveBeenCalledTimes(1)
    expect(searchAddress.mock.calls[0][0]).toBe('旭川市宮下通')
    expect(screen.getByText(ADDRESS_SEARCH_ATTRIBUTION)).toBeTruthy()
  })

  it('結果を選ぶと、範囲があれば範囲に合わせ、無ければその点へ寄って、印を置く', async () => {
    const { map, sources } = fakeMap()
    render(<AddressSearch />)
    searchAddress.mockResolvedValue([MIYASHITA, STATION])
    fireEvent.change(box(), { target: { value: '旭川' } })
    fireEvent.click(submit())
    const list = await screen.findByRole('list', { name: '住所検索の結果' })
    fireEvent.click(within(list).getByRole('button', { name: /宮下通八丁目/ }))
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [142.3561, 43.7616],
        [142.3615, 43.7651],
      ],
      expect.objectContaining({ maxZoom: 17 }),
    )
    expect(map.addSource).toHaveBeenCalledWith(SEARCH_SOURCE_ID, expect.anything())
    fireEvent.click(within(list).getByRole('button', { name: /旭川駅/ }))
    expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [142.3581, 43.7627], zoom: 16 }))
    expect(sources.get(SEARCH_SOURCE_ID)?.setData).toHaveBeenCalled()
    expect(within(list).getByRole('button', { name: /旭川駅/ }).getAttribute('aria-current')).toBe('location')
  })

  it('結果が1件ならそのまま動かす。0件・失敗はその旨を出す', async () => {
    const { map } = fakeMap()
    render(<AddressSearch />)
    searchAddress.mockResolvedValueOnce([STATION])
    fireEvent.change(box(), { target: { value: '旭川駅' } })
    fireEvent.click(submit())
    await waitFor(() => expect(map.flyTo).toHaveBeenCalled())

    searchAddress.mockResolvedValueOnce([])
    fireEvent.change(box(), { target: { value: 'どこにもない町' } })
    fireEvent.click(submit())
    expect((await screen.findByRole('status')).textContent).toContain('「どこにもない町」は見つかりませんでした')

    searchAddress.mockRejectedValueOnce(new GeocodeError('住所検索が混み合っています。少し待ってからもう一度押してください。'))
    fireEvent.click(submit())
    expect((await screen.findByRole('alert')).textContent).toContain('混み合っています')
  })

  it('「検索を消す」と Escape で、入力・結果・印を消す', async () => {
    const { map } = fakeMap()
    render(<AddressSearch />)
    searchAddress.mockResolvedValue([MIYASHITA, STATION])
    fireEvent.change(box(), { target: { value: '旭川' } })
    fireEvent.click(submit())
    const list = await screen.findByRole('list', { name: '住所検索の結果' })
    fireEvent.click(within(list).getByRole('button', { name: /旭川駅/ }))
    fireEvent.click(screen.getByRole('button', { name: '検索を消す' }))
    expect(box().value).toBe('')
    expect(screen.queryByRole('list', { name: '住所検索の結果' })).toBeNull()
    expect(document.activeElement).toBe(box())

    fireEvent.change(box(), { target: { value: '旭川' } })
    fireEvent.click(submit())
    await screen.findByRole('list', { name: '住所検索の結果' })
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(box().value).toBe('')
    expect(screen.queryByRole('list', { name: '住所検索の結果' })).toBeNull()
    expect(map.flyTo).toHaveBeenCalledTimes(1)
  })

  it('地図を外したら印を片付ける', async () => {
    const { map } = fakeMap()
    render(<AddressSearch />)
    searchAddress.mockResolvedValue([STATION])
    fireEvent.change(box(), { target: { value: '旭川駅' } })
    fireEvent.click(submit())
    await waitFor(() => expect(map.addSource).toHaveBeenCalled())
    act(() => useMapStore.getState().setMap(null))
    expect(map.removeSource).toHaveBeenCalledWith(SEARCH_SOURCE_ID)
  })
})
