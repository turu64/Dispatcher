import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { loadGtfsZip } from '@/gtfs/load'
import { toStops } from '@/gtfs/parse'
import { originStops, refMarginM } from './input'
import { distanceM } from './mesh'
import { DEFAULT_REACH_PARAMS } from './reach'
import { expandBounds, fetchRefData, inMeshRange, pointsBounds, refMeshesFor, type RefCache } from './refData'

describe('inMeshRange', () => {
  it('日本の点は範囲の中', () => {
    expect(inMeshRange(43.7647, 142.3579)).toBe(true)
  })

  it('(0, 0)・NaN・範囲の外は範囲外', () => {
    expect(inMeshRange(0, 0)).toBe(false)
    expect(inMeshRange(Number.NaN, 142)).toBe(false)
    expect(inMeshRange(43, 99.9)).toBe(false)
    expect(inMeshRange(70, 142)).toBe(false)
  })
})

describe('pointsBounds', () => {
  it('範囲の中の点だけで外接矩形を作る', () => {
    expect(
      pointsBounds([
        { lat: 43.5, lon: 142.2 },
        { lat: 0, lon: 0 },
        { lat: 44.1, lon: 141.9 },
        { lat: Number.NaN, lon: 142 },
      ]),
    ).toEqual({ south: 43.5, west: 141.9, north: 44.1, east: 142.2 })
  })

  it('範囲の中の点が無ければ null', () => {
    expect(pointsBounds([])).toBeNull()
    expect(pointsBounds([{ lat: 0, lon: 0 }])).toBeNull()
  })
})

describe('expandBounds', () => {
  const b = { south: 43.5, west: 142.2, north: 44.1, east: 142.8 }

  it('0m なら変わらない', () => {
    expect(expandBounds(b, 0)).toEqual(b)
  })

  it('広げた幅は、どの辺でも 1,600m 以上(足りなくならない)、1,700m 未満(広げすぎない)', () => {
    const e = expandBounds(b, 1600)
    const south = distanceM({ lat: b.south, lon: b.west }, { lat: e.south, lon: b.west })
    const north = distanceM({ lat: b.north, lon: b.west }, { lat: e.north, lon: b.west })
    // 経度の幅は北ほど短いので、北端で測る(最も狭いところ)
    const west = distanceM({ lat: e.north, lon: b.west }, { lat: e.north, lon: e.west })
    const east = distanceM({ lat: e.north, lon: b.east }, { lat: e.north, lon: e.east })
    for (const d of [south, north, west, east]) {
      expect(d).toBeGreaterThanOrEqual(1600)
      expect(d).toBeLessThan(1700)
    }
  })

  it('地域メッシュの範囲で切る', () => {
    const e = expandBounds({ south: 0.001, west: 100.001, north: 66.66, east: 199.999 }, 5000)
    expect(e.south).toBe(0)
    expect(e.west).toBe(100)
    expect(e.north).toBeCloseTo((100 * 640) / 960, 12)
    expect(e.east).toBe(200)
  })

  it('負の距離はエラー', () => {
    expect(() => expandBounds(b, -1)).toThrow('0 以上')
  })
})

describe('refMeshesFor', () => {
  it('1次メッシュの真ん中の停留所だけなら、その1次メッシュだけ', () => {
    expect(refMeshesFor([{ lat: 43.6667, lon: 142.5 }], 1600)).toEqual(['6542'])
  })

  it('南の境界から 1,100m の停留所は、南の1次メッシュも読む', () => {
    // 6542 の南端は 43.3333…度。0.01度は約 1,111m
    expect(refMeshesFor([{ lat: 130 / 3 + 0.01, lon: 142.5 }], 1600)).toEqual(['6442', '6542'])
  })

  it('西の境界から 1,800m の停留所は、西の1次メッシュを読まない', () => {
    // 北緯 43.67度で経度 0.0223度は約 1,800m
    expect(refMeshesFor([{ lat: 43.6667, lon: 142.0223 }], 1600)).toEqual(['6542'])
    expect(refMeshesFor([{ lat: 43.6667, lon: 142.0150 }], 1600)).toEqual(['6541', '6542'])
  })

  it('範囲外の停留所は使わない。範囲の中の停留所が無ければ空', () => {
    expect(refMeshesFor([{ lat: 0, lon: 0 }, { lat: 43.6667, lon: 142.5 }], 1600)).toEqual(['6542'])
    expect(refMeshesFor([{ lat: 0, lon: 0 }], 1600)).toEqual([])
  })
})

// ---- fetchRefData ----

function refJson(mesh1: string, extra: Partial<Record<'pop250' | 'did125' | 'stations' | 'sources', unknown>> = {}) {
  return {
    mesh1,
    pop250: { [`${mesh1}000011`]: 120 },
    did125: [`${mesh1}0000111`],
    stations: [{ name: `駅${mesh1}`, line: '函館線', operator: '北海道旅客鉄道', lat: 43.5, lon: 142.5 }],
    sources: ['令和2年国勢調査 地域メッシュ統計(e-Stat)を加工して作成'],
    ...extra,
  }
}

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** 1次メッシュ → 返す内容。'404'・'500'・'neterr'・'badjson' は失敗のしかた */
function fakeFetch(table: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const mesh1 = url.replace('/api/ref/', '')
    const v = table[mesh1]
    if (v === 'neterr') throw new TypeError('Failed to fetch')
    if (v === '404' || v === undefined) return response(404, { detail: 'なし' })
    if (v === '500') return response(500, null)
    if (v === 'badjson') return { ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('bad')) }
    return response(200, v)
  })
}

describe('fetchRefData', () => {
  it('すべて取れたら、まとめた参照データと駅・出典を返す', async () => {
    const fetchFn = fakeFetch({ '6542': refJson('6542'), '6543': refJson('6543') })
    const r = await fetchRefData(['6542', '6543'], fetchFn, new Map())
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual(['/api/ref/6542', '/api/ref/6543'])
    if (!r.ok) throw new Error('ok のはず')
    expect(r.mesh1s).toEqual(['6542', '6543'])
    expect(r.ref.pop250.get('6542000011')).toBe(120)
    expect(r.ref.pop250.get('6543000011')).toBe(120)
    expect(r.ref.did125.has('65420000111')).toBe(true)
    expect(r.ref.stations).toHaveLength(2)
    expect(r.stations.map((s) => s.name)).toEqual(['駅6542', '駅6543'])
    expect(r.stations[0]).toEqual({ name: '駅6542', line: '函館線', lat: 43.5, lon: 142.5 })
    expect(r.sources).toEqual(['令和2年国勢調査 地域メッシュ統計(e-Stat)を加工して作成'])
  })

  it('並行で取る(1つ目の返事を待たずに2つ目を問い合わせる)', async () => {
    const resolvers: (() => void)[] = []
    const fetchFn = vi.fn(
      (url: string) =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolvers.push(() => resolve(response(200, refJson(url.slice(-4)))))
        }),
    )
    const p = fetchRefData(['6542', '6543', '6642'], fetchFn, new Map())
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(3)
    resolvers.forEach((r) => r())
    expect((await p).ok).toBe(true)
  })

  it('1つでも 404 なら ok: false で、読めなかった1次メッシュを返す', async () => {
    const r = await fetchRefData(['6541', '6542', '6543'], fakeFetch({ '6542': refJson('6542'), '6543': '404' }), new Map())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.missing).toEqual(['6541', '6543'])
    expect(r.message).toContain('6541・6543')
    expect(r.message).toContain('サーバーにファイルがありません')
  })

  it('通信の失敗・サーバーのエラー・JSON として読めない返事も ok: false', async () => {
    for (const [v, text] of [
      ['neterr', 'サーバーにつながりません'],
      ['500', '500'],
      ['badjson', 'JSON として読めません'],
    ]) {
      const r = await fetchRefData(['6542'], fakeFetch({ '6542': v }), new Map())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toContain(text)
    }
  })

  it('JSON の形が違えば ok: false で、どのファイルかを書く', async () => {
    const r = await fetchRefData(['6542'], fakeFetch({ '6542': refJson('6542', { did125: 'x' }) }), new Map())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.missing).toEqual(['6542'])
      expect(r.message).toContain('参照データ(6542)の did125 が配列ではありません')
    }
  })

  it('取れたものは cache に入れ、次はサーバーに問い合わせない', async () => {
    const cache: RefCache = new Map()
    const fetchFn = fakeFetch({ '6542': refJson('6542') })
    await fetchRefData(['6542'], fetchFn, cache)
    await fetchRefData(['6542'], fetchFn, cache)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(cache.has('6542')).toBe(true)
  })

  it('取れなかったものは cache に入れず、次に取り直す', async () => {
    const cache: RefCache = new Map()
    const table: Record<string, unknown> = { '6542': refJson('6542'), '6543': 'neterr' }
    const fetchFn = fakeFetch(table)
    expect((await fetchRefData(['6542', '6543'], fetchFn, cache)).ok).toBe(false)
    // 1つが失敗した回は、取れたものも入れない(形の確かめはまとめて行うため)
    expect(cache.size).toBe(0)
    table['6543'] = refJson('6543')
    expect((await fetchRefData(['6542', '6543'], fetchFn, cache)).ok).toBe(true)
    expect([...cache.keys()]).toEqual(['6542', '6543'])
  })

  it('形の誤った JSON は cache に入れない', async () => {
    const cache: RefCache = new Map()
    await fetchRefData(['6542'], fakeFetch({ '6542': refJson('6542', { pop250: [] }) }), cache)
    expect(cache.size).toBe(0)
  })

  it('1次メッシュが無ければ、空の参照データで ok', async () => {
    const fetchFn = fakeFetch({})
    const r = await fetchRefData([], fetchFn, new Map())
    expect(fetchFn).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ref.pop250.size).toBe(0)
  })
})

// ---- 実データ(GTFS の ZIP と data/out/ref があるときだけ) ----
const ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const ZIP_AFTER = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url))
const REF_DIR = fileURLToPath(new URL('../../../data/out/ref/', import.meta.url))
const EXPECTED_MESHES = ['6541', '6542', '6543', '6641', '6642', '6643']

async function originsOf(zip: string) {
  const feed = await loadGtfsZip(new Uint8Array(readFileSync(zip)).buffer)
  return originStops(feed, toStops(feed).stops)
}

// 起点の数は、乗れる行が無い停留所(すべて終点か pickup_type が 1。降車専用。旭川駅前 0010_10・旭川空港 9000_02 など)を
// 起点にしない規則(docs/interfaces-1104.md §7)で数えたもの。9/17 版・10/29 版とも、この規則で 10 停留所を除く
describe.skipIf(!existsSync(ZIP))('実データ(道北バス 減便前)', () => {
  it('起点の停留所(乗れる行の無い 10 停留所を除く 1,450)の外接矩形を 2,800m(バス停 1,200m + 駅 1,600m)広げた範囲の1次メッシュは 6541〜6643 の6つ', async () => {
    const { stops: origins, noBoarding } = await originsOf(ZIP)
    expect(origins).toHaveLength(1450)
    expect(noBoarding).toBe(10)
    expect(refMeshesFor(origins, refMarginM(DEFAULT_REACH_PARAMS))).toEqual(EXPECTED_MESHES)
  })

  it.skipIf(!existsSync(ZIP_AFTER))('減便後の起点の停留所(乗れる行の無い 10 停留所を除く 1,354)では、6541・6542・6641・6642 の4つ(6つに収まる)', async () => {
    const { stops: origins, noBoarding } = await originsOf(ZIP_AFTER)
    expect(origins).toHaveLength(1354)
    expect(noBoarding).toBe(10)
    const meshes = refMeshesFor(origins, refMarginM(DEFAULT_REACH_PARAMS))
    expect(meshes).toEqual(['6541', '6542', '6641', '6642'])
    expect(meshes.every((m) => EXPECTED_MESHES.includes(m))).toBe(true)
  })

  it.skipIf(!EXPECTED_MESHES.every((m) => existsSync(`${REF_DIR}${m}.json`)))(
    'data/out/ref の6ファイルを読むと、参照データが使える(駅の名前もそろう)',
    async () => {
      const fetchFn = async (url: string) => {
        const mesh1 = url.replace('/api/ref/', '')
        return response(200, JSON.parse(readFileSync(`${REF_DIR}${mesh1}.json`, 'utf8')))
      }
      const r = await fetchRefData(EXPECTED_MESHES, fetchFn, new Map())
      if (!r.ok) throw new Error(r.message)
      expect(r.stations.length).toBe(r.ref.stations.length)
      expect(r.stations.length).toBeGreaterThan(0)
      expect(r.stations.every((s) => s.name !== '')).toBe(true)
      expect(r.stations.some((s) => s.name === '旭川')).toBe(true)
      expect(r.ref.pop250.size).toBeGreaterThan(0)
    },
  )
})
