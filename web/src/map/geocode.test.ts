import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GeocodeError,
  MAX_QUERY_LENGTH,
  MIN_INTERVAL_MS,
  NOMINATIM_SEARCH_URL,
  parseItem,
  resetGeocodeThrottle,
  searchAddress,
  shortLabel,
} from './geocode'

const MIYASHITA = {
  display_name: '宮下通八丁目, 宮下通, 神楽, 旭川市, 上川総合振興局, 北海道, 北海道地方, 070-0030, 日本',
  lat: '43.7633810',
  lon: '142.3588070',
  boundingbox: ['43.7616', '43.7651', '142.3561', '142.3615'],
}

function okFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

beforeEach(() => resetGeocodeThrottle())
afterEach(() => vi.useRealTimers())

describe('shortLabel', () => {
  it('日本・北海道地方・郵便番号を落とし、読点でつなぐ', () => {
    expect(shortLabel(MIYASHITA.display_name)).toBe('宮下通八丁目、宮下通、神楽、旭川市、上川総合振興局')
  })
})

describe('parseItem', () => {
  it('座標と範囲([西, 南, 東, 北])を読む', () => {
    expect(parseItem(MIYASHITA)).toEqual({
      label: '宮下通八丁目、宮下通、神楽、旭川市、上川総合振興局',
      lat: 43.763381,
      lon: 142.358807,
      bbox: [142.3561, 43.7616, 142.3615, 43.7651],
    })
  })

  it('座標が読めない・範囲の外なら null。範囲が壊れていれば bbox だけ null', () => {
    expect(parseItem({ lat: 'x', lon: '1' })).toBeNull()
    expect(parseItem({ lat: '91', lon: '1' })).toBeNull()
    expect(parseItem({ display_name: 'A', lat: '43', lon: '142', boundingbox: ['1', '2'] })?.bbox).toBeNull()
  })
})

describe('searchAddress', () => {
  it('空の入力は送らない', async () => {
    const fetchImpl = okFetch([])
    expect(await searchAddress('   ', { fetchImpl })).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('長すぎる入力は送らずに断る', async () => {
    const fetchImpl = okFetch([])
    await expect(searchAddress('あ'.repeat(MAX_QUERY_LENGTH + 1), { fetchImpl })).rejects.toBeInstanceOf(GeocodeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('日本の中だけ・日本語・件数の上限つきで Nominatim に問い合わせ、結果を読む', async () => {
    const fetchImpl = okFetch([MIYASHITA, { lat: 'bad', lon: '1' }])
    const results = await searchAddress(' 旭川市宮下通8丁目 ', { fetchImpl })
    expect(results).toHaveLength(1)
    expect(results[0].label).toBe('宮下通八丁目、宮下通、神楽、旭川市、上川総合振興局')
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]))
    expect(`${url.origin}${url.pathname}`).toBe(NOMINATIM_SEARCH_URL)
    expect(url.searchParams.get('q')).toBe('旭川市宮下通8丁目')
    expect(url.searchParams.get('countrycodes')).toBe('jp')
    expect(url.searchParams.get('accept-language')).toBe('ja')
    expect(url.searchParams.get('format')).toBe('jsonv2')
    expect(url.searchParams.get('limit')).toBe('5')
  })

  it('前の問い合わせから 1 秒たっていなければ、待ってから送る(Nominatim の決まり)', async () => {
    vi.useFakeTimers()
    let t = 10_000
    const now = () => t
    const fetchImpl = okFetch([])
    await searchAddress('旭川', { fetchImpl, now })
    t += 200
    const second = searchAddress('深川', { fetchImpl, now })
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 201)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    t += MIN_INTERVAL_MS - 200
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('混み合い(429)・失敗・形の合わない応答・つながらないときは GeocodeError', async () => {
    const status = (s: number) => vi.fn(async () => new Response('[]', { status: s }))
    await expect(searchAddress('旭川', { fetchImpl: status(429) })).rejects.toThrow('混み合っています')
    resetGeocodeThrottle()
    await expect(searchAddress('旭川', { fetchImpl: status(500) })).rejects.toThrow('失敗しました(500)')
    resetGeocodeThrottle()
    await expect(searchAddress('旭川', { fetchImpl: okFetch({ not: 'array' }) })).rejects.toThrow('読めませんでした')
    resetGeocodeThrottle()
    const down = vi.fn(async () => {
      throw new TypeError('network')
    })
    await expect(searchAddress('旭川', { fetchImpl: down })).rejects.toThrow('つながりませんでした')
  })

  it('中断したら AbortError のまま返す', async () => {
    const ctrl = new AbortController()
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(ctrl.signal)
      throw new DOMException('aborted', 'AbortError')
    })
    ctrl.abort()
    await expect(searchAddress('旭川', { fetchImpl: fetchImpl as unknown as typeof fetch, signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
