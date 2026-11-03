import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  REACH_COLORS,
  REACH_DIFF_COLORS,
  REACH_DIFF_OPACITY,
  REACH_FILL_OPACITY,
  REACH_FILL_OPACITY_REACHABLE,
  STOP_COLORS,
} from './colors'
import {
  addReachLayers,
  CELLS_LAYER,
  CELLS_SOURCE,
  cellBandBit,
  cellFillColor,
  cellFillOpacity,
  removeReachLayers,
  setGeoJson,
  setReachBand,
  stationIcon,
  STATION_ICON,
  STATIONS_LAYER,
  STATIONS_SOURCE,
  stopCircleColor,
  STOPS_LAYER,
  STOPS_SOURCE,
  ZERO_STOP_ICON,
  ZERO_STOPS_LAYER,
  ZERO_STOPS_SOURCE,
  zeroStopIcon,
  type LayerMap,
} from './layers'

/** 呼ばれた操作を記録する偽の地図 */
function fakeMap(baseLayers: { id: string; type: string }[] = [{ id: 'water', type: 'fill' }, { id: 'place-label', type: 'symbol' }]) {
  const sources = new Map<string, { spec: object; data?: unknown; setData(d: unknown): void }>()
  const layers: { layer: Record<string, unknown>; beforeId?: string }[] = []
  const images = new Map<string, unknown>()
  const paint: [string, string, unknown][] = []
  let removed = false
  const map: LayerMap & { remove(): void } = {
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => {
      if (sources.has(id)) throw new Error(`同じソースがあります:${id}`)
      const s = {
        spec,
        data: undefined as unknown,
        setData(d: unknown) {
          s.data = d
        },
      }
      sources.set(id, s)
    },
    getLayer: (id) => layers.find((l) => l.layer.id === id),
    addLayer: (layer, beforeId) => {
      const l = layer as Record<string, unknown>
      if (layers.some((x) => x.layer.id === l.id)) throw new Error(`同じレイヤーがあります:${String(l.id)}`)
      layers.push({ layer: l, beforeId })
    },
    removeLayer: (id) => {
      if (removed) throw new Error('壊された地図')
      layers.splice(
        layers.findIndex((l) => l.layer.id === id),
        1,
      )
    },
    removeSource: (id) => {
      if (removed) throw new Error('壊された地図')
      sources.delete(id)
    },
    setPaintProperty: (layerId, name, value) => {
      paint.push([layerId, name, value])
    },
    hasImage: (id) => images.has(id),
    addImage: (id, image) => {
      images.set(id, image)
    },
    removeImage: (id) => {
      images.delete(id)
    },
    getStyle: () => {
      if (removed) return undefined
      return { layers: [...baseLayers, ...layers.map((l) => ({ id: String(l.layer.id), type: String(l.layer.type) }))] }
    },
    remove: () => {
      removed = true
    },
  }
  return { map, sources, layers, images, paint }
}

describe('式', () => {
  it('セルの時間帯 b のビットは、取り決め(追記2)の形 floor(m / 2^b) % 2 で取り出す', () => {
    expect(cellBandBit(0)).toEqual(['%', ['floor', ['/', ['get', 'm'], 1]], 2])
    expect(cellBandBit(5)).toEqual(['%', ['floor', ['/', ['get', 'm'], 32]], 2])
    expect(cellBandBit(17)).toEqual(['%', ['floor', ['/', ['get', 'm'], 131072]], 2])
  })

  it('セルの色は、時間帯のビットが 1 なら青、それ以外は橙', () => {
    expect(cellFillColor(2)).toEqual(['case', ['==', cellBandBit(2), 1], REACH_COLORS.reachable, REACH_COLORS.unreachable])
  })

  it('セルの不透明度は、到達できるセルが薄い', () => {
    expect(cellFillOpacity(0)).toEqual(['case', ['==', cellBandBit(0), 1], REACH_FILL_OPACITY_REACHABLE, REACH_FILL_OPACITY])
  })

  it('時間帯が無い(-1)ときは、どのセルも外れる色にする', () => {
    expect(cellFillColor(-1)).toEqual(['case', false, REACH_COLORS.reachable, REACH_COLORS.unreachable])
    expect(cellFillOpacity(-1)).toEqual(['case', false, REACH_FILL_OPACITY_REACHABLE, REACH_FILL_OPACITY])
  })

  it('停留所は、その時間帯の出発が 1 以上なら黒、無ければ白', () => {
    expect(stopCircleColor(5)).toEqual([
      'case',
      ['>', ['coalesce', ['get', 'b5'], 0], 0],
      STOP_COLORS.active,
      STOP_COLORS.inactive,
    ])
  })

  it('時間帯が無い(-1)ときは、停留所はどの地物にも無い名前を読む', () => {
    expect(JSON.stringify(cellFillColor(-1))).not.toContain('"b-1"')
    expect(JSON.stringify(stopCircleColor(-1))).toContain('_none')
  })
})

describe('stationIcon', () => {
  const icon = stationIcon(24)
  const px = (x: number, y: number) => [...icon.data.slice((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)]

  it('24 × 24 の RGBA', () => {
    expect(icon.width).toBe(24)
    expect(icon.height).toBe(24)
    expect(icon.data.length).toBe(24 * 24 * 4)
  })

  it('外側は白の縁、その内側は黒の枠、中は白、真ん中は黒(すべて不透明)', () => {
    expect(px(0, 0)).toEqual([255, 255, 255, 255])
    expect(px(1, 12)).toEqual([0x1a, 0x1a, 0x1a, 255])
    expect(px(5, 5)).toEqual([255, 255, 255, 255])
    expect(px(12, 12)).toEqual([0x1a, 0x1a, 0x1a, 255])
    expect(px(23, 23)).toEqual([255, 255, 255, 255])
  })
})

describe('addReachLayers・removeReachLayers', () => {
  it('ソース4つ、レイヤー4つ、駅と運行がゼロになる停留所の記号を足す。セルは背景の地図の文字の下に入れる', () => {
    const { map, sources, layers, images } = fakeMap()
    addReachLayers(map)
    expect([...sources.keys()]).toEqual([CELLS_SOURCE, STOPS_SOURCE, STATIONS_SOURCE, ZERO_STOPS_SOURCE])
    expect(layers.map((l) => l.layer.id)).toEqual([CELLS_LAYER, STOPS_LAYER, STATIONS_LAYER, ZERO_STOPS_LAYER])
    expect(layers[0].beforeId).toBe('place-label')
    expect(layers[1].beforeId).toBeUndefined()
    expect(images.has(STATION_ICON)).toBe(true)
    expect(images.has(ZERO_STOP_ICON)).toBe(true)
  })

  it('2回呼んでも(StrictMode)、同じものを2つ足さない', () => {
    const { map, layers } = fakeMap()
    addReachLayers(map)
    expect(() => addReachLayers(map)).not.toThrow()
    expect(layers).toHaveLength(4)
  })

  it('背景の地図に文字のレイヤーが無ければ、いちばん上に足す', () => {
    const { map, layers } = fakeMap([{ id: 'water', type: 'fill' }])
    addReachLayers(map)
    expect(layers[0].beforeId).toBeUndefined()
  })

  it('片付けで、足したものをすべて外す', () => {
    const { map, sources, layers, images } = fakeMap()
    addReachLayers(map)
    removeReachLayers(map)
    expect(sources.size).toBe(0)
    expect(layers).toHaveLength(0)
    expect(images.size).toBe(0)
    // 外したあとにもう一度足せる
    addReachLayers(map)
    expect(layers).toHaveLength(4)
  })

  it('地図が先に壊されていても、片付けで例外を出さない', () => {
    const { map } = fakeMap()
    addReachLayers(map)
    map.remove()
    expect(() => removeReachLayers(map)).not.toThrow()
  })
})

describe('setGeoJson・setReachBand', () => {
  it('ソースのデータを入れ直す。ソースが無ければ何もしない', () => {
    const { map, sources } = fakeMap()
    addReachLayers(map)
    const data = { type: 'FeatureCollection', features: [] }
    setGeoJson(map, CELLS_SOURCE, data)
    expect(sources.get(CELLS_SOURCE)?.data).toBe(data)
    expect(() => setGeoJson(map, 'なし', data)).not.toThrow()
  })

  it('時間帯を切り替えると、セルの色・不透明度と停留所の色の式を差し替える', () => {
    const { map, paint } = fakeMap()
    addReachLayers(map)
    setReachBand(map, 3)
    expect(paint).toEqual([
      [CELLS_LAYER, 'fill-color', cellFillColor(3)],
      [CELLS_LAYER, 'fill-opacity', cellFillOpacity(3)],
      [STOPS_LAYER, 'circle-color', stopCircleColor(3)],
    ])
  })

  it('レイヤーが無ければ何もしない', () => {
    const { map, paint } = fakeMap()
    setReachBand(map, 0)
    expect(paint).toEqual([])
  })

  it('塗り分けを渡すと、その塗り分けの式に差し替える', () => {
    const { map, paint } = fakeMap()
    addReachLayers(map)
    setReachBand(map, 2, 'diff')
    expect(paint.slice(0, 2)).toEqual([
      [CELLS_LAYER, 'fill-color', cellFillColor(2, 'diff')],
      [CELLS_LAYER, 'fill-opacity', cellFillOpacity(2, 'diff')],
    ])
  })
})

describe('減便の前後の塗り分け', () => {
  it("'before' は基準の可否(m0)、'after' と省略は表示する側の可否(m)で2色にする", () => {
    expect(cellBandBit(1, 'm0')).toEqual(['%', ['floor', ['/', ['get', 'm0'], 2]], 2])
    expect(cellFillColor(1, 'before')).toEqual(['case', ['==', cellBandBit(1, 'm0'), 1], REACH_COLORS.reachable, REACH_COLORS.unreachable])
    expect(cellFillColor(1, 'after')).toEqual(cellFillColor(1))
    expect(cellFillOpacity(1, 'after')).toEqual(cellFillOpacity(1))
  })

  it("'diff' は、減便で外れた・両方で外れる・新たに到達・両方で到達の4つに塗り分ける", () => {
    const was = ['==', cellBandBit(0, 'm0'), 1]
    const now = ['==', cellBandBit(0, 'm'), 1]
    expect(cellFillColor(0, 'diff')).toEqual([
      'case',
      ['all', was, ['!', now]],
      REACH_DIFF_COLORS.lost,
      ['all', ['!', was], ['!', now]],
      REACH_DIFF_COLORS.bothUnreachable,
      ['all', ['!', was], now],
      REACH_DIFF_COLORS.gained,
      REACH_DIFF_COLORS.bothReachable,
    ])
    expect(cellFillOpacity(0, 'diff')[2]).toBe(REACH_DIFF_OPACITY.lost)
  })
})

describe('zeroStopIcon', () => {
  const icon = zeroStopIcon(28)
  const px = (x: number, y: number) => [...icon.data.slice((y * 28 + x) * 4, (y * 28 + x) * 4 + 4)]

  it('背景は透明で、真ん中と対角線の上は黒(×の形)。四辺の真ん中は描かない', () => {
    expect(icon.data.length).toBe(28 * 28 * 4)
    expect(px(0, 0)[3]).toBe(0)
    expect(px(14, 14)).toEqual([0x1a, 0x1a, 0x1a, 255])
    expect(px(8, 8)).toEqual([0x1a, 0x1a, 0x1a, 255])
    expect(px(19, 8)).toEqual([0x1a, 0x1a, 0x1a, 255])
    expect(px(14, 1)[3]).toBe(0)
    expect(px(1, 14)[3]).toBe(0)
  })
})

// MapLibre のスタイルの検証器(maplibre-gl が使っているもの)で、足すレイヤーの書き方を確かめる。
// 直接の依存ではないため、pnpm の置き場所に見つからなければ飛ばす
const PNPM_DIR = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
const STYLE_SPEC_DIR = existsSync(PNPM_DIR)
  ? readdirSync(PNPM_DIR).find((n) => n.startsWith('@maplibre+maplibre-gl-style-spec@'))
  : undefined
const STYLE_SPEC = STYLE_SPEC_DIR
  ? `${PNPM_DIR}${STYLE_SPEC_DIR}/node_modules/@maplibre/maplibre-gl-style-spec/dist/index.mjs`
  : undefined

/** スタイルの検証器のうち、ここで使う部分 */
interface StyleSpec {
  validateStyleMin(style: unknown): { message: string }[]
  createExpression(
    expression: unknown,
    propertySpec: unknown,
  ): { result: 'success'; value: { evaluate(globals: { zoom: number }, feature: unknown): unknown } } | { result: 'error'; value: { message: string }[] }
  latest: { paint_fill: Record<string, unknown> }
}

describe.skipIf(!STYLE_SPEC || !existsSync(STYLE_SPEC))('MapLibre のスタイルの検証器', () => {
  const loadSpec = async () => (await import(/* @vite-ignore */ pathToFileURL(STYLE_SPEC!).href)) as StyleSpec

  it('足すソース・レイヤーと、時間帯を切り替えた式が、スタイルとして正しい', async () => {
    const spec = await loadSpec()
    const { map, sources, layers } = fakeMap([])
    addReachLayers(map)
    const style = {
      version: 8,
      sources: Object.fromEntries([...sources].map(([id, s]) => [id, s.spec])),
      layers: layers.map((l) => l.layer),
    }
    expect(spec.validateStyleMin(style).map((e) => e.message)).toEqual([])

    for (const band of [-1, 0, 5, 17]) {
      for (const mode of ['before', 'after', 'diff'] as const) {
        const switched = structuredClone(style)
        const paintOf = (id: string) => (switched.layers.find((l) => l.id === id) as { paint: Record<string, unknown> }).paint
        paintOf(CELLS_LAYER)['fill-color'] = cellFillColor(band, mode)
        paintOf(CELLS_LAYER)['fill-opacity'] = cellFillOpacity(band, mode)
        paintOf(STOPS_LAYER)['circle-color'] = stopCircleColor(band)
        expect(spec.validateStyleMin(switched).map((e) => e.message)).toEqual([])
      }
    }
  })

  it('MapLibre の式の評価で、セルの m から時間帯ごとの可否を取り出せる(18 の時間帯すべて)', async () => {
    const spec = await loadSpec()
    // 時間帯ごとの可否の並び。1時間ごと(18)で、いろいろなビットの組み合わせを作る
    const patterns = [0, 1, 2 ** 17, 2 ** 18 - 1, 0b101010101010101010, 0b010101010101010101, 0b100000000000000001, 12345]
    for (let band = 0; band < 18; band++) {
      const parsed = spec.createExpression(cellFillOpacity(band), spec.latest.paint_fill['fill-opacity'])
      if (parsed.result !== 'success') throw new Error(parsed.value.map((e) => e.message).join('、'))
      for (const m of patterns) {
        const reachable = Math.floor(m / 2 ** band) % 2 === 1
        const opacity = parsed.value.evaluate({ zoom: 10 }, { type: 'Polygon', properties: { m } })
        expect(opacity).toBe(reachable ? REACH_FILL_OPACITY_REACHABLE : REACH_FILL_OPACITY)
      }
    }
    // 時間帯が無い(-1)ときは、どのセルも外れる
    const none = spec.createExpression(cellFillOpacity(-1), spec.latest.paint_fill['fill-opacity'])
    if (none.result !== 'success') throw new Error('式を作れません')
    expect(none.value.evaluate({ zoom: 10 }, { type: 'Polygon', properties: { m: 2 ** 18 - 1 } })).toBe(REACH_FILL_OPACITY)
  })

  it("MapLibre の式の評価で、'diff' の4つの場合を m0 と m から塗り分ける", async () => {
    const spec = await loadSpec()
    const color = spec.createExpression(cellFillColor(1, 'diff'), spec.latest.paint_fill['fill-color'])
    const opacity = spec.createExpression(cellFillOpacity(1, 'diff'), spec.latest.paint_fill['fill-opacity'])
    if (color.result !== 'success' || opacity.result !== 'success') throw new Error('式を作れません')
    // 時間帯 1 のビット(2)。前 m0、後 m の組 → 期待する不透明度
    const cases: [number, number, number][] = [
      [2, 0, REACH_DIFF_OPACITY.lost],
      [0, 0, REACH_DIFF_OPACITY.bothUnreachable],
      [0, 2, REACH_DIFF_OPACITY.gained],
      [2, 2, REACH_DIFF_OPACITY.bothReachable],
      // ほかの時間帯のビットは関係しない
      [2 + 1, 4, REACH_DIFF_OPACITY.lost],
    ]
    for (const [m0, m, expected] of cases) {
      expect(opacity.value.evaluate({ zoom: 10 }, { type: 'Polygon', properties: { m0, m } })).toBe(expected)
      expect(color.value.evaluate({ zoom: 10 }, { type: 'Polygon', properties: { m0, m } })).toBeTruthy()
    }
  })
})
