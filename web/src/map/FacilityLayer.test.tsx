// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import type { Stop } from '@/gtfs/parse'
import { mergeBusstopFiles, type OperatorOverlap } from '@/ref/busstops'
import { facilityCategory, facilityMeshes, mergeFacilityFiles, researchCandidates, type Facility } from '@/ref/facilities'
import { useDriversStore } from '@/store/drivers'
import { useGtfsStore } from '@/store/gtfs'
import { useMapStore } from '@/store/map'
import { useReachStore } from '@/store/reach'
import { useResearchStore } from '@/store/research'
import { useStepStore } from '@/store/steps'
import MapOverlays, { FacilityLayer, MAP_OVERLAY_COLUMN_CLASS, OTHER_STOPS_LEGEND, OTHER_STOPS_LEGEND_NOTE } from './FacilityLayer'
import {
  FACILITIES_HIGHLIGHT_LAYER,
  FACILITIES_HIGHLIGHT_RING,
  FACILITIES_LAYER,
  FACILITIES_SOURCE,
  FACILITY_LAYER_IDS,
  addFacilityImages,
  distinctOtherStops,
  facilitiesToGeoJson,
  highlightFilter,
} from './facilityLayers'
import {
  FACILITY_COLORS,
  FACILITY_SYMBOL_IS_GSI,
  FACILITY_SYMBOL_KINDS,
  FACILITY_SYMBOL_LABELS,
  facilitySymbolId,
  facilitySymbolKind,
  facilitySymbolParts,
  facilitySymbolSvg,
} from './facilitySymbols'

// MapOverlays の手順ごとの出し分けだけを見るため、到達圏の重ねは描かない
vi.mock('./ReachLayers', () => ({ default: () => null }))

const STOPS: Stop[] = [
  { id: 'S1', name: '停留所1', lat: 43.76, lon: 142.35, locationType: 0, parentStation: '' },
  { id: 'S2', name: '停留所2', lat: 43.78, lon: 142.37, locationType: 0, parentStation: '' },
  { id: 'S3', name: '停留所3', lat: 43.77, lon: 142.36, locationType: 0, parentStation: '' },
]

const FILE = {
  facilities: [
    { target_id: 'P04:hosp', kind: 'hospital', name: '病院', municipality: '旭川市', lat: 43.77, lon: 142.36, detail: { beds: 100 } },
    // 種別が分からない学校(優先順位の外。小学校・中学校などは読み込まない)
    { target_id: 'P29:elem', kind: 'school', name: '学校', municipality: '旭川市', lat: 43.771, lon: 142.36, detail: {} },
  ],
}

/** MapLibre の Map の偽物(足したものを記録する) */
function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()
  const layers = new Map<string, object>()
  const images = new Set<string>()
  const imageArgs = new Map<string, { image: unknown; options: unknown }>()
  const layout: Record<string, unknown> = {}
  const filters: Record<string, unknown> = {}
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => void sources.set(id, { setData: vi.fn() }),
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: { id: string }) => void layers.set(layer.id, layer),
    removeLayer: (id: string) => void layers.delete(id),
    removeSource: (id: string) => void sources.delete(id),
    hasImage: (id: string) => images.has(id),
    addImage: (id: string, image: unknown, options: unknown) => {
      images.add(id)
      imageArgs.set(id, { image, options })
    },
    removeImage: (id: string) => void images.delete(id),
    setLayoutProperty: (layerId: string, name: string, value: unknown) => void (layout[`${layerId}.${name}`] = value),
    setFilter: (layerId: string, filter: unknown) => void (filters[layerId] = filter),
    // 地図を動かす操作(強調では呼ばないことを確かめる)
    flyTo: vi.fn(),
    easeTo: vi.fn(),
    jumpTo: vi.fn(),
    panTo: vi.fn(),
    fitBounds: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getCanvas: () => ({ style: {} }),
  }
  act(() => useMapStore.getState().setMap(map as unknown as MapLibreMap))
  return { map, sources, layers, images, imageArgs, layout, filters }
}

/** Image の偽物:src を入れると読み込めたことにする(jsdom には画像を読む仕組みが無い) */
class FakeImage {
  static created: FakeImage[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width: number
  height: number
  constructor(width = 0, height = 0) {
    this.width = width
    this.height = height
    FakeImage.created.push(this)
  }
  private _src = ''
  get src() {
    return this._src
  }
  set src(v: string) {
    this._src = v
    queueMicrotask(() => this.onload?.())
  }
}

beforeEach(() => {
  FakeImage.created = []
  vi.stubGlobal('Image', FakeImage)
  act(() => {
    useGtfsStore.setState({ feed: smallFeed(), stops: STOPS })
    useReachStore.setState({ origins: { stops: STOPS, unused: 0, nonStop: 0, noBoarding: 0 } })
    const { facilities, sources } = mergeFacilityFiles([FILE])
    useResearchStore.setState({ facilities: { status: 'ready', key: facilityMeshes(STOPS).join(','), facilities, sources } })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  act(() => {
    useMapStore.getState().setMap(null)
    useGtfsStore.getState().clear()
    useReachStore.setState({ origins: null })
    useResearchStore.getState().reset()
    useMapStore.getState().setHighlighted(null)
  })
})

describe('facilitySymbolKind', () => {
  it('施設の種類と学校の種別から記号の種類を決める', () => {
    expect(facilitySymbolKind('hospital')).toBe('hospital')
    expect(facilitySymbolKind('clinic')).toBe('clinic')
    expect(facilitySymbolKind('operator')).toBe('busstop')
    expect(facilitySymbolKind('school', '小学校')).toBe('school-basic')
    expect(facilitySymbolKind('school', '中学校')).toBe('school-basic')
    expect(facilitySymbolKind('school', '義務教育学校')).toBe('school-basic')
    expect(facilitySymbolKind('school', '幼稚園')).toBe('school-basic')
    expect(facilitySymbolKind('school')).toBe('school-basic')
    for (const t of ['高等学校', '特別支援学校', '中等教育学校']) expect(facilitySymbolKind('school', t)).toBe('school-high')
    for (const t of ['大学', '短期大学', '高等専門学校', '専修学校', '各種学校']) expect(facilitySymbolKind('school', t)).toBe('school-higher')
  })

  it('重要拠点の種類(facilityCategory)と食い違わない', () => {
    const types = ['小学校', '中学校', '義務教育学校', '中等教育学校', '高等学校', '特別支援学校', '大学', '短期大学', '高等専門学校', '専修学校', '各種学校', '幼稚園', '幼保連携型認定こども園']
    for (const schoolType of types) {
      const f = { kind: 'school', schoolType } as Facility
      const category = facilityCategory(f)
      const symbol = facilitySymbolKind('school', schoolType)
      // 高校・特別支援学校の記号 ⇔ high_school、大学・高専・専修学校の記号 ⇔ higher_education
      expect(symbol === 'school-high', schoolType).toBe(category === 'high_school')
      expect(symbol === 'school-higher', schoolType).toBe(category === 'higher_education')
    }
  })
})

describe('施設の記号', () => {
  it('記号の種類ごとに SVG の文字列がある(自分で描いた path。画像を埋め込まない)', () => {
    const svgs = FACILITY_SYMBOL_KINDS.map((k) => facilitySymbolSvg(k))
    expect(new Set(svgs).size).toBe(FACILITY_SYMBOL_KINDS.length)
    for (const svg of svgs) {
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      expect(svg).toContain('<path ')
      expect(svg).not.toMatch(/<image|href=|data:/)
    }
  })

  it('形でも区別する(図形が1つずつ違い、色だけに頼らない)', () => {
    const shapes = FACILITY_SYMBOL_KINDS.map((k) => facilitySymbolParts(k).map((p) => p.d).join('|'))
    expect(new Set(shapes).size).toBe(FACILITY_SYMBOL_KINDS.length)
  })

  it('病院は下がとがった盾形の枠の中に十字(国土地理院の病院の記号)。診療所は丸を使わない(丸に十字は保健所の記号)', () => {
    const hospital = facilitySymbolParts('hospital')
    // 1つ目が盾形の枠(白地に種類の色の縁。上の角から下のとがった点 12,22 へ)、2つ目が種類の色で塗った十字
    expect(hospital).toHaveLength(2)
    expect(hospital[0]).toMatchObject({ fill: '#ffffff', stroke: '#D55E00' })
    expect(hospital[0].d).toContain('L12 22')
    expect(hospital[1]).toMatchObject({ fill: '#D55E00' })
    // 診療所の図形には円弧(a)が無い
    for (const p of facilitySymbolParts('clinic')) expect(p.d).not.toMatch(/a/i)
  })

  it('色は Okabe-Ito の配色を施設の種類ごとに残す。学校の3種類は同じ緑で形が違う', () => {
    expect(FACILITY_COLORS).toEqual({ hospital: '#D55E00', clinic: '#CC79A7', school: '#009E73', operator: '#56B4E9' })
    for (const k of ['school-basic', 'school-high', 'school-higher'] as const) expect(facilitySymbolSvg(k)).toContain('#009E73')
    expect(facilitySymbolSvg('hospital')).toContain('#D55E00')
    expect(facilitySymbolSvg('clinic')).toContain('#CC79A7')
    expect(facilitySymbolSvg('busstop')).toContain('#56B4E9')
  })

  it('独自の記号は凡例の名前に「(独自の記号)」が付き、国土地理院の記号にある種類には付かない', () => {
    for (const k of FACILITY_SYMBOL_KINDS) expect(FACILITY_SYMBOL_LABELS[k].includes('(独自の記号)'), k).toBe(!FACILITY_SYMBOL_IS_GSI[k])
    expect(FACILITY_SYMBOL_IS_GSI).toMatchObject({ 'school-basic': true, 'school-high': true, hospital: true, 'school-higher': false, clinic: false, busstop: false })
  })
})

describe('addFacilityImages', () => {
  it('記号の種類ごとに SVG から Image を作り、addImage を1回ずつ呼ぶ。足し済みなら作らない', async () => {
    const { map, imageArgs } = fakeMap()
    await addFacilityImages(map as never)
    expect([...imageArgs.keys()].sort()).toEqual(FACILITY_SYMBOL_KINDS.map(facilitySymbolId).sort())
    expect(FakeImage.created).toHaveLength(FACILITY_SYMBOL_KINDS.length)
    for (const { image, options } of imageArgs.values()) {
      expect(image).toBeInstanceOf(FakeImage)
      expect(options).toEqual({ pixelRatio: 3 })
    }
    // data URL は SVG
    expect(decodeURIComponent((imageArgs.get(facilitySymbolId('hospital'))!.image as FakeImage).src)).toContain(facilitySymbolSvg('hospital'))
    await addFacilityImages(map as never)
    expect(FakeImage.created).toHaveLength(FACILITY_SYMBOL_KINDS.length)
  })

  it('待っている間に中止されたら、足さない', async () => {
    const { map, images } = fakeMap()
    const abort = new AbortController()
    const p = addFacilityImages(map as never, abort.signal)
    abort.abort()
    await p
    expect(images.size).toBe(0)
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
    expect(fc.features.map((f) => f.properties.symbol)).toEqual(['hospital', 'school-basic'])
    expect(fc.features[0].geometry.coordinates).toEqual([142.36, 43.77])
  })
})

describe('FacilityLayer', () => {
  it('平日便を戻す手順を開くまではレイヤーを足さない', () => {
    const { layers, images } = fakeMap()
    render(<FacilityLayer visible={false} />)
    expect(layers.size).toBe(0)
    expect(images.size).toBe(0)
  })

  it('開いたら記号の画像を足し終えてからレイヤーを足し、点・凡例を出す。閉じたら隠すだけ(消さない)。外れたら片付ける', async () => {
    const { layers, images, sources, layout } = fakeMap()
    const { rerender, unmount } = render(<FacilityLayer visible />)
    // 画像は非同期。足し終えるまでレイヤーは足さない
    expect(layers.size).toBe(0)
    await waitFor(() => expect(layers.has(FACILITIES_LAYER)).toBe(true))
    expect(images.size).toBe(FACILITY_SYMBOL_KINDS.length)
    expect(images.has(facilitySymbolId('hospital'))).toBe(true)
    await waitFor(() => expect(sources.get(FACILITIES_SOURCE)!.setData).toHaveBeenCalled())
    const data = sources.get(FACILITIES_SOURCE)!.setData.mock.calls.at(-1)![0] as { features: { properties: { selected: number } }[] }
    // 既定の選び方:病院は選び、種別が分からない学校(優先順位の外)は選ばない
    expect(data.features.map((f) => f.properties.selected)).toEqual([1, 0])
    expect(layout[`${FACILITIES_LAYER}.visibility`]).toBe('visible')
    const legend = screen.getByRole('group', { name: '施設の凡例' })
    expect(legend.textContent).toContain('病院 1 件')
    expect(legend.textContent).toContain('学校(種別が分からないもの) 1 件')
    expect(legend.textContent).toContain('選んだ対象(1 件)')
    // 凡例の記号は種類ごとに別の形(path)
    const paths = [...legend.querySelectorAll('svg')].map((svg) => [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|'))
    expect(paths).toHaveLength(2)
    expect(new Set(paths).size).toBe(2)

    rerender(<FacilityLayer visible={false} />)
    expect(layout[`${FACILITIES_LAYER}.visibility`]).toBe('none')
    expect(layers.has(FACILITIES_LAYER)).toBe(true)
    expect(screen.queryByRole('group', { name: '施設の凡例' })).toBeNull()

    unmount()
    expect(layers.size).toBe(0)
    expect(sources.size).toBe(0)
    expect(images.size).toBe(0)
  })
  it('画像を作っている間に外れたら、画像もレイヤーも足さない', async () => {
    const { layers, images } = fakeMap()
    const { unmount } = render(<FacilityLayer visible />)
    unmount()
    await new Promise((r) => setTimeout(r, 0))
    expect(layers.size).toBe(0)
    expect(images.size).toBe(0)
  })

  it('凡例と押した記号の名前は右上の列に縦に積み、下の端(時間帯の切り替え)には置かない', async () => {
    const { map, layers } = fakeMap()
    render(<FacilityLayer visible />)
    await waitFor(() => expect(layers.has(FACILITIES_LAYER)).toBe(true))
    const legend = screen.getByRole('group', { name: '施設の凡例' })
    const column = screen.getByTestId('facility-overlay')
    expect(legend.parentElement).toBe(column)
    // 列そのものは、地図の右上の列(MapOverlays。利用者が置いた場所の凡例と共通)の中に入る
    expect(MAP_OVERLAY_COLUMN_CLASS).toContain('top-24')
    expect(MAP_OVERLAY_COLUMN_CLASS).toContain('right-3')
    expect(column.className).not.toContain('absolute')
    for (const el of [column, legend]) expect(el.className).not.toMatch(/(^|\s)bottom-/)

    // 記号を押すと、名前を凡例の下(同じ列)に出す
    const onClick = map.on.mock.calls.find((c) => c[0] === 'click')![2] as (e: unknown) => void
    act(() => onClick({ features: [{ properties: { name: '病院', kind: 'hospital', symbol: 'hospital' } }] }))
    const picked = screen.getByRole('status')
    expect(picked.textContent).toContain('病院')
    expect(picked.parentElement).toBe(column)
    expect([...column.children].indexOf(picked)).toBeGreaterThan([...column.children].indexOf(legend))
    expect(picked.className).not.toMatch(/(^|\s)(absolute|bottom-)/)
  })

  it('営業所などを地図で置いている途中は、施設の記号を押しても名前を出さない', async () => {
    const { map, layers } = fakeMap()
    render(<FacilityLayer visible />)
    await waitFor(() => expect(layers.has(FACILITIES_LAYER)).toBe(true))
    const onClick = map.on.mock.calls.find((c) => c[0] === 'click')![2] as (e: unknown) => void
    act(() => useDriversStore.getState().startPlacing('office'))
    act(() => onClick({ features: [{ properties: { name: '病院', kind: 'hospital', symbol: 'hospital' } }] }))
    expect(screen.queryByRole('status')).toBeNull()
    act(() => useDriversStore.getState().cancelPlacing())
    act(() => onClick({ features: [{ properties: { name: '病院', kind: 'hospital', symbol: 'hospital' } }] }))
    expect(screen.getByRole('status').textContent).toContain('病院')
  })

  it('GTFS を削除・読み込み直したら、押した記号の名前を消す(次の GTFS で平日便を戻す手順を開いても出さない)', async () => {
    const { map, layers } = fakeMap()
    const { rerender } = render(<FacilityLayer visible />)
    await waitFor(() => expect(layers.has(FACILITIES_LAYER)).toBe(true))
    const onClick = map.on.mock.calls.find((c) => c[0] === 'click')![2] as (e: unknown) => void
    act(() => onClick({ features: [{ properties: { name: '前の病院', kind: 'hospital', symbol: 'hospital' } }] }))
    expect(screen.getByRole('status').textContent).toContain('前の病院')

    // 手順「読み込み」に戻って削除し(部品は外れず、隠れるだけ)、次の GTFS を読み込んで平日便を戻す手順を開き直す
    rerender(<FacilityLayer visible={false} />)
    act(() => useGtfsStore.getState().clear())
    act(() => {
      useGtfsStore.setState({ feed: smallFeed(), stops: STOPS })
      const { facilities, sources } = mergeFacilityFiles([FILE])
      useResearchStore.setState({ facilities: { status: 'ready', key: facilityMeshes(STOPS).join(','), facilities, sources } })
    })
    rerender(<FacilityLayer visible />)
    expect(screen.getByRole('group', { name: '施設の凡例' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('地図の store の強調', () => {
  it('強調する施設の target_id を持ち、null で解く', () => {
    expect(useMapStore.getState().highlightedTargetId).toBeNull()
    act(() => useMapStore.getState().setHighlighted('P04:hosp'))
    expect(useMapStore.getState().highlightedTargetId).toBe('P04:hosp')
    act(() => useMapStore.getState().setHighlighted(null))
    expect(useMapStore.getState().highlightedTargetId).toBeNull()
  })
})

// ---- 周辺の事業者の停留所と、一覧からの強調 ----

const OPERATOR_FILE = {
  facilities: [
    ...FILE.facilities,
    { target_id: 'P11:となりバス', kind: 'operator', name: 'となりバス', municipality: null, lat: 43.775, lon: 142.365, detail: { stops: 9, bbox: [43.7, 142.3, 43.8, 142.4] } },
    { target_id: 'P11:テストバス', kind: 'operator', name: 'テストバス', municipality: null, lat: 43.77, lon: 142.36, detail: { stops: 9, bbox: [43.7, 142.3, 43.8, 142.4] } },
  ],
  busstops: [
    { name: 'となり1', lat: 43.761, lon: 142.35, operators: ['P11:となりバス'], routes: ['1番', '2番'] },
    { name: 'となり2', lat: 43.7801, lon: 142.3701, operators: ['P11:となりバス'], routes: [] },
    // 遠い停留所は出さない
    { name: 'となり遠く', lat: 43.7, lon: 142.3, operators: ['P11:となりバス'], routes: ['9番'] },
    // 読み込んだ GTFS の事業者(テストバス)の停留所は出さない
    { name: '自社', lat: 43.7601, lon: 142.3501, operators: ['P11:テストバス'], routes: [] },
  ],
}

function loadOperatorFile() {
  act(() => {
    const { facilities, sources } = mergeFacilityFiles([OPERATOR_FILE])
    useResearchStore.setState({
      facilities: { status: 'ready', key: facilityMeshes(STOPS).join(','), facilities, sources, busstops: mergeBusstopFiles([OPERATOR_FILE]).stops },
    })
  })
}

describe('facilitiesToGeoJson(事業者)', () => {
  it('事業者の点(重心)は出さず、重なる停留所を事業者の target_id で出す(押したときの事業者名・系統名つき)', () => {
    const { facilities } = mergeFacilityFiles([OPERATOR_FILE])
    const candidates = researchCandidates(facilities, STOPS, [])
    const overlap: OperatorOverlap = {
      targetId: 'P11:となりバス',
      ownStopIds: ['S1'],
      otherStops: [{ name: 'となり1', lat: 43.761, lon: 142.35, operators: ['P11:となりバス'], routes: ['1番', '2番'] }],
      routes: ['1番', '2番'],
    }
    const fc = facilitiesToGeoJson(candidates, new Set(['P11:となりバス']), [overlap])
    expect(fc.features.some((f) => f.properties.symbol === 'busstop' && f.properties.name === 'となりバス')).toBe(false)
    const stops = fc.features.filter((f) => f.properties.symbol === 'busstop')
    expect(stops).toHaveLength(1)
    expect(stops[0].properties).toMatchObject({ id: 'P11:となりバス', kind: 'operator', name: 'となり1', detail: 'となりバス・系統:1番、2番', selected: 1 })
    expect(stops[0].geometry.coordinates).toEqual([142.35, 43.761])
  })

  it('同じ停留所に2つの事業者が入るときは、地図の停留所の数を1か所と数える', () => {
    const shared = { name: '共同', lat: 43.76, lon: 142.35, operators: ['P11:a', 'P11:b'], routes: [] }
    const overlaps: OperatorOverlap[] = [
      { targetId: 'P11:a', ownStopIds: ['S1'], otherStops: [shared], routes: [] },
      { targetId: 'P11:b', ownStopIds: ['S1'], otherStops: [shared, { ...shared, name: '別' }], routes: [] },
    ]
    expect(distinctOtherStops(overlaps)).toBe(2)
  })
})

describe('FacilityLayer の事業者と強調', () => {
  it('重なるほかの事業者の停留所を出し、凡例に「ほかの事業者の停留所 N か所(こちらの停留所から 300m 以内・独自の記号)」を出す', async () => {
    loadOperatorFile()
    const { layers, sources } = fakeMap()
    render(<FacilityLayer visible />)
    await waitFor(() => expect(layers.has(FACILITIES_LAYER)).toBe(true))
    await waitFor(() => expect(sources.get(FACILITIES_SOURCE)!.setData).toHaveBeenCalled())
    const data = sources.get(FACILITIES_SOURCE)!.setData.mock.calls.at(-1)![0] as { features: { properties: { id: string; name: string; symbol: string } }[] }
    expect(data.features.filter((f) => f.properties.symbol === 'busstop').map((f) => [f.properties.id, f.properties.name])).toEqual([
      ['P11:となりバス', 'となり1'],
      ['P11:となりバス', 'となり2'],
    ])
    const legend = screen.getByRole('group', { name: '施設の凡例' })
    expect(legend.textContent).toContain(`${OTHER_STOPS_LEGEND} 2 か所`)
    expect(legend.textContent).toContain(OTHER_STOPS_LEGEND_NOTE)
    expect(OTHER_STOPS_LEGEND).toBe('ほかの事業者の停留所')
    expect(OTHER_STOPS_LEGEND_NOTE).toBe('(こちらの停留所から 300m 以内・独自の記号)')
    // 事業者そのものは施設の種類として数えない
    expect(legend.textContent).not.toContain('バス事業者')
  })

  it('強調する対象(highlightedTargetId)で、輪と大きい記号のレイヤーを絞る。地図は動かさない', async () => {
    loadOperatorFile()
    const { map, layers, filters } = fakeMap()
    render(<FacilityLayer visible />)
    await waitFor(() => expect(layers.has(FACILITIES_HIGHLIGHT_LAYER)).toBe(true))
    expect(layers.has(FACILITIES_HIGHLIGHT_RING)).toBe(true)
    // 輪は記号の下、大きい記号は上に描く(足す順)
    expect([...layers.keys()]).toEqual([FACILITIES_HIGHLIGHT_RING, FACILITIES_LAYER, FACILITIES_HIGHLIGHT_LAYER])
    expect(filters[FACILITIES_HIGHLIGHT_LAYER]).toEqual(highlightFilter(null))

    act(() => useMapStore.getState().setHighlighted('P04:hosp'))
    expect(filters[FACILITIES_HIGHLIGHT_RING]).toEqual(['==', ['get', 'id'], 'P04:hosp'])
    expect(filters[FACILITIES_HIGHLIGHT_LAYER]).toEqual(['==', ['get', 'id'], 'P04:hosp'])
    // 事業者の行の強調は、その事業者の停留所(id が事業者の target_id)に当たる
    act(() => useMapStore.getState().setHighlighted('P11:となりバス'))
    expect(filters[FACILITIES_HIGHLIGHT_LAYER]).toEqual(['==', ['get', 'id'], 'P11:となりバス'])
    act(() => useMapStore.getState().setHighlighted(null))
    expect(filters[FACILITIES_HIGHLIGHT_LAYER]).toEqual(['==', ['get', 'id'], ''])
    for (const fn of [map.flyTo, map.easeTo, map.jumpTo, map.panTo, map.fitBounds]) expect(fn).not.toHaveBeenCalled()
  })

  it('地図を隠す手順では、強調のレイヤーも隠す。外れたら強調のレイヤーも片付ける', async () => {
    const { layers, layout } = fakeMap()
    const { rerender, unmount } = render(<FacilityLayer visible />)
    await waitFor(() => expect(layers.has(FACILITIES_HIGHLIGHT_LAYER)).toBe(true))
    for (const id of FACILITY_LAYER_IDS) expect(layout[`${id}.visibility`]).toBe('visible')
    rerender(<FacilityLayer visible={false} />)
    for (const id of FACILITY_LAYER_IDS) expect(layout[`${id}.visibility`]).toBe('none')
    unmount()
    expect(layers.size).toBe(0)
  })
})

describe('MapOverlays の手順ごとの出し分け', () => {
  afterEach(() => {
    act(() => {
      useStepStore.setState({ current: useStepStore.getState().order[0] })
      useDriversStore.getState().reset()
    })
  })

  it('施設は平日便を戻す手順だけ。利用者が置いた場所は運行の前提・影響・平日便を戻す手順で見せ、置けるのは運行の前提の手順だけ', async () => {
    const { layers, layout } = fakeMap()
    act(() => {
      useDriversStore.getState().addPlace({ name: '営業所A', lat: 43.77, lon: 142.36, type: 'office' })
      useStepStore.setState({ current: 'premise' })
    })
    render(<MapOverlays />)
    const facilityLegend = () => screen.queryByRole('group', { name: '施設の凡例' })
    const placesLegend = () => screen.queryByRole('group', { name: '利用者が置いた場所の凡例' })
    expect(facilityLegend()).toBeNull()
    expect(layers.has(FACILITIES_LAYER)).toBe(false)
    expect(placesLegend()).not.toBeNull()

    // 運行の前提の手順では地図で置ける。影響の手順に移ると、置いている途中ならやめる(場所は見せたまま)
    act(() => useDriversStore.getState().startPlacing('office'))
    expect(useDriversStore.getState().placing).toBe('office')
    act(() => useStepStore.setState({ current: 'reach' }))
    expect(useDriversStore.getState().placing).toBeNull()
    expect(placesLegend()).not.toBeNull()
    expect(facilityLegend()).toBeNull()

    act(() => useStepStore.setState({ current: 'restore' }))
    await waitFor(() => expect(layers.has(FACILITIES_LAYER)).toBe(true))
    expect(layout[`${FACILITIES_LAYER}.visibility`]).toBe('visible')
    expect(facilityLegend()).not.toBeNull()
    expect(placesLegend()).not.toBeNull()
    // 平日便を戻す手順でも置けない
    act(() => useDriversStore.getState().startPlacing('office'))
    expect(useDriversStore.getState().placing).toBeNull()

    for (const step of ['load', 'policy', 'output'] as const) {
      act(() => useStepStore.setState({ current: step }))
      expect(facilityLegend()).toBeNull()
      expect(placesLegend()).toBeNull()
      expect(layout[`${FACILITIES_LAYER}.visibility`]).toBe('none')
    }
  })
})
