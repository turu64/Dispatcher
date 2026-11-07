import { afterEach, describe, expect, it } from 'vitest'
import type { ResearchResult } from '../claude/research'
import { makeBands } from '../gtfs/departures'
import { defaultFacilityWindows, overlapLongBreaks } from '../gtfs/edit/facilityHours'
import { cellAreaKm2, meshCode, parentCode } from '../reach/mesh'
import { DEFAULT_REACH_PARAMS, type RefData } from '../reach/reach'
import type { Facility } from '../ref/facilities'
import { DEFAULT_PRIORITY_ORDER, movePriority, usePriorityStore } from './priority'
import type { ReachSnapshot } from './reach'
import { useResearchStore, type FacilityState } from './research'
import { buildRestoreHintContext, facilityRegionClass, hintFacilities, type ReachStateForHints } from './restoreHintContext'

// 学校・病院の手がかり(docs/tasks-1103.md の T19)の材料を、周辺の施設と到達圏の条件から作る

const P = { lat: 43.77, lon: 142.37 }
const CELL = meshCode(P.lat, P.lon, 11)
const PARENT = parentCode(CELL, 10)
const NO_FALLBACK = { usedFallback: false, classes: [] }

function ref(o: Partial<RefData> = {}): RefData {
  return { pop250: new Map(), did125: new Set(), stations: [], ...o }
}

function fac(o: Partial<Facility> & Pick<Facility, 'targetId' | 'kind'>): Facility {
  return { name: o.targetId, municipality: '旭川市', lat: P.lat, lon: P.lon, ...o }
}

const HIGH = fac({ targetId: 'P29:高校', kind: 'school', name: '東高校', schoolType: '高等学校', openStatus: '開校中' })
const TECH = fac({ targetId: 'P29:高専', kind: 'school', name: '東高専', schoolType: '高等専門学校' })
const COLLEGE = fac({ targetId: 'P29:大学', kind: 'school', name: '東大学', schoolType: '大学', openStatus: '不明' })
const HOSPITAL = fac({ targetId: 'P04:病院', kind: 'hospital', name: '東病院', beds: 120 })
const CLINIC = fac({ targetId: 'P04:診療所', kind: 'clinic', name: '東クリニック', beds: 0 })
/** 種別が分からない学校(優先順位の外) */
const UNKNOWN = fac({ targetId: 'P29:不明', kind: 'school', name: '東学校' })
const CLOSED = fac({ targetId: 'P29:休校', kind: 'school', name: '休校高校', schoolType: '高等学校', openStatus: '休校中' })
const OPERATOR = fac({ targetId: 'P11:事業者', kind: 'operator', name: 'ほかのバス' })

const RESULT: ResearchResult = {
  targetId: HIGH.targetId,
  kind: 'school',
  name: '東高校',
  status: 'found',
  facts: [
    { label: '始業', value: '8時40分', source: 1 },
    { label: '下校', value: '15時30分', source: 2 },
    { label: '休業日', value: '土日祝', source: 9 },
    { label: '4つ目', value: '入らない', source: 1 },
  ],
  sources: [
    { url: 'https://example.jp/a', title: 'A' },
    { url: 'https://example.jp/b', title: 'B' },
  ],
  note: '',
  checkedAt: '2026-11-03T12:00:00+09:00',
  origin: 'demo',
}

describe('施設の位置の区分(facilityRegionClass)', () => {
  it('到達圏と同じ規則:DID の中は都市部、外は 250m セルの人口密度がしきい値以上なら郊外、未満(人口 0 を含む)なら中山間・地方', () => {
    const params = DEFAULT_REACH_PARAMS
    expect(facilityRegionClass(P.lat, P.lon, ref({ did125: new Set([CELL]) }), params, NO_FALLBACK)).toBe('urban')
    const dense = Math.ceil(params.densityThreshold * cellAreaKm2(PARENT))
    expect(facilityRegionClass(P.lat, P.lon, ref({ pop250: new Map([[PARENT, dense]]) }), params, NO_FALLBACK)).toBe('suburban')
    expect(facilityRegionClass(P.lat, P.lon, ref({ pop250: new Map([[PARENT, dense - 2]]) }), params, NO_FALLBACK)).toBe('rural')
    expect(facilityRegionClass(P.lat, P.lon, ref(), params, NO_FALLBACK)).toBe('rural')
  })

  it('参照データが無ければ、到達圏が当てた区分(fallbackClass で計算したとき)。それも無ければ null', () => {
    expect(facilityRegionClass(P.lat, P.lon, null, DEFAULT_REACH_PARAMS, { usedFallback: true, classes: ['suburban', 'suburban'] })).toBe('suburban')
    expect(facilityRegionClass(P.lat, P.lon, null, DEFAULT_REACH_PARAMS, NO_FALLBACK)).toBeNull()
    expect(facilityRegionClass(0, 0, ref(), DEFAULT_REACH_PARAMS, NO_FALLBACK)).toBeNull()
  })
})

describe('手がかりに使う施設(hintFacilities)', () => {
  const base = { results: new Map<string, ResearchResult>(), order: DEFAULT_PRIORITY_ORDER, ref: ref(), params: DEFAULT_REACH_PARAMS, result: NO_FALLBACK }

  it('優先順位にある学校と入院設備のある病院だけを使う(診療所・種別が分からない学校・休校中の学校・事業者は使わない)', () => {
    const got = hintFacilities([HIGH, TECH, COLLEGE, HOSPITAL, CLINIC, UNKNOWN, CLOSED, OPERATOR], base)
    expect(got.map((f) => [f.targetId, f.kind, f.categoryLabel, f.rank])).toEqual([
      ['P29:高校', 'school', '高校・特別支援学校', 3],
      ['P29:高専', 'school', '大学・高専・専修学校', 4],
      ['P29:大学', 'school', '大学・高専・専修学校', 4],
      ['P04:病院', 'hospital', '入院設備のある病院', 1],
    ])
  })

  it('徒歩圏は施設の位置の区分のバス停の分数 × 分速。区分が決められなければ3区分の最大', () => {
    const p = DEFAULT_REACH_PARAMS
    expect(hintFacilities([HIGH], base)[0].radiusM).toBe(p.walkMinutes.rural.bus * p.speedMPerMin)
    expect(hintFacilities([HIGH], { ...base, ref: ref({ did125: new Set([CELL]) }) })[0].radiusM).toBe(p.walkMinutes.urban.bus * p.speedMPerMin)
    expect(hintFacilities([HIGH], { ...base, ref: null })[0].radiusM).toBe(Math.max(...Object.values(p.walkMinutes).map((m) => m.bus)) * p.speedMPerMin)
  })

  it('優先順位は画面の並び(order)の順位。調査の結果があれば要点(事実は3件まで、出典の URL つき)を付ける', () => {
    const order = movePriority(DEFAULT_PRIORITY_ORDER, 'higher_education', 1)
    const got = hintFacilities([HIGH, TECH], { ...base, order, results: new Map([[HIGH.targetId, RESULT]]) })
    expect(got[1].rank).toBe(5)
    expect(got[0].research).toEqual({
      status: 'found',
      checkedAt: '2026-11-03T12:00:00+09:00',
      origin: 'demo',
      facts: [
        { label: '始業', value: '8時40分', url: 'https://example.jp/a' },
        { label: '下校', value: '15時30分', url: 'https://example.jp/b' },
        { label: '休業日', value: '土日祝', url: null },
      ],
    })
    expect(got[1].research).toBeUndefined()
  })
})

describe('調べた結果から施設ごとの窓と長期休業を読む(hintFacilities。T27)', () => {
  const base = { results: new Map<string, ResearchResult>(), order: DEFAULT_PRIORITY_ORDER, ref: ref(), params: DEFAULT_REACH_PARAMS, result: NO_FALLBACK }

  /** data/demo/research_dohoku.json の旭川赤十字病院(受付時間は2件目)を写した結果 */
  const SEKIJUJI: ResearchResult = {
    targetId: HOSPITAL.targetId,
    kind: 'hospital',
    name: '東病院',
    status: 'found',
    facts: [
      { label: '休診日', value: '土・日・祝日、5月1日、12月29日～1月3日(公式ページ)', source: 1 },
      { label: '一般外来受付時間', value: '初診は8：00～11：30、再診は7：50～11：00、午後は13時30分～15時(公式ページ、年度表示なし)', source: 1 },
    ],
    sources: [{ url: 'https://example.jp/sekijuji', title: '外来' }],
    note: '',
    checkedAt: '2026-11-03T18:59:11+09:00',
    origin: 'demo',
  }

  /** data/demo/research_dohoku.json の神楽中学校の結果の事実(休業は1・2件目。始業は5件目に足す)。施設は高専に置き換えた */
  const KAGURA: ResearchResult = {
    targetId: TECH.targetId,
    kind: 'school',
    name: '東高専',
    status: 'partial',
    facts: [
      { label: '夏季休業(市立中学校共通)', value: '令和8年度 7月24日(金曜日)から8月24日(月曜日)まで。最終更新日2026年4月1日', source: 1 },
      { label: '冬季休業(市立中学校共通)', value: '令和8年度 12月25日(金曜日)から1月12日(火曜日)まで', source: 1 },
      { label: 'その他の休業日', value: '市立中学校の休業日等予定表はPDFで掲載。このページの本文からは内容未確認', source: 1 },
      { label: '学校の所在地・電話', value: '〒070-8006 北海道旭川市神楽6条12丁目2 TEL 0166-61-7196', source: 1 },
      { label: '始業(仮)', value: '8時20分', source: 2 },
    ],
    sources: [
      { url: 'https://example.jp/kagura', title: '休業日' },
      { url: 'https://example.jp/kagura2', title: '日課' },
    ],
    note: '',
    checkedAt: '2026-11-03T18:59:15+09:00',
    origin: 'demo',
  }

  it('病院:調べた外来の受付時間から窓を決め、使った事実と出典を持つ。調べていなければ既定', () => {
    const [researched] = hintFacilities([HOSPITAL], { ...base, results: new Map([[HOSPITAL.targetId, SEKIJUJI]]) })
    expect(researched.windows.arrive).toMatchObject({ from: 7 * 60 + 20, to: 11 * 60 + 30, source: 'research', basis: '外来の受付 7:50〜11:00・8:00〜11:30・13:30〜15:00' })
    expect(researched.windows.depart).toMatchObject({ from: 11 * 60 + 30, to: 17 * 60, source: 'research' })
    expect(researched.windows.arrive.fact).toEqual({ label: '一般外来受付時間', value: SEKIJUJI.facts[1].value, url: 'https://example.jp/sekijuji' })
    expect(researched.longBreaks).toEqual([])
    const [plain] = hintFacilities([HOSPITAL], base)
    expect(plain.windows).toEqual(defaultFacilityWindows('hospital'))
    expect(plain.longBreaks).toEqual([])
  })

  it('学校:要点(3件)に入らない事実からも始業と長期休業を読む。休業は減便の期間と重なるかを出せる', () => {
    const [school] = hintFacilities([TECH], { ...base, results: new Map([[TECH.targetId, KAGURA]]) })
    expect(school.research!.facts).toHaveLength(3)
    expect(school.windows.arrive).toMatchObject({ from: 7 * 60 + 20, to: 8 * 60 + 20, source: 'research', basis: '始業 8:20' })
    expect(school.windows.arrive.fact?.url).toBe('https://example.jp/kagura2')
    expect(school.windows.depart).toEqual(defaultFacilityWindows('school').depart)
    expect(school.longBreaks.map((b) => [b.name, b.text])).toEqual([
      ['夏季休業', '7月24日〜8月24日'],
      ['冬季休業', '12月25日〜1月12日'],
    ])
    expect(overlapLongBreaks(school.longBreaks, { start: '20261110', end: '20270331' }).map((b) => [b.name, b.from, b.to])).toEqual([
      ['冬季休業', '20261225', '20270112'],
    ])
  })

  it('見つからなかった(not_found)結果の事実は使わず、既定の窓にする', () => {
    const notFound: ResearchResult = { ...KAGURA, status: 'not_found' }
    const [school] = hintFacilities([TECH], { ...base, results: new Map([[TECH.targetId, notFound]]) })
    expect(school.windows).toEqual(defaultFacilityWindows('school'))
    expect(school.longBreaks).toEqual([])
  })

  it('始業・下校の事実の例(RESULT)からは、着く窓と出る窓の両方を調べた結果にする', () => {
    const [high] = hintFacilities([HIGH], { ...base, results: new Map([[HIGH.targetId, RESULT]]) })
    expect([high.windows.arrive.from, high.windows.arrive.to, high.windows.arrive.source]).toEqual([7 * 60 + 40, 8 * 60 + 40, 'research'])
    expect([high.windows.depart.from, high.windows.depart.to, high.windows.depart.basis]).toEqual([15 * 60 + 30, 17 * 60 + 30, '終業 15:30'])
  })
})

describe('到達圏の ctx に学校・病院を入れる(buildRestoreHintContext)', () => {
  afterEach(() => {
    useResearchStore.getState().reset()
    usePriorityStore.getState().reset()
  })

  /** 前後の比較がある到達圏の store の状態(中身は空) */
  function reachState(): ReachStateForHints {
    const bands = makeBands(3)
    const counts = { counts: new Map<string, number[]>(), skippedBlankTime: 0, skippedBadTime: 0 }
    const result = { cells: [], classes: [], reachable: bands.map(() => []), coverable: [], usedFallback: false, excludedStops: 0, cellPopulation: [] }
    const snapshot = {
      date: '20261104',
      bands,
      departures: counts,
      result,
      params: DEFAULT_REACH_PARAMS,
      baseline: { departures: counts, result },
      comparison: {},
    } as unknown as ReachSnapshot
    return { edited: { feed: { tables: new Map(), warnings: [] }, period: null, draft: false }, origins: { stops: [] } as never, computing: false, error: null, snapshot }
  }

  const ready = (facilities: Facility[]): FacilityState => ({ status: 'ready', key: '6442', facilities, sources: [] })

  it('周辺の施設を読めていなければ ctx.facilities は無い。読めていれば学校・病院を入れる', () => {
    const state = reachState()
    const order = DEFAULT_PRIORITY_ORDER
    expect(buildRestoreHintContext(state, undefined, { facilities: { status: 'idle' }, results: new Map(), order })!.facilities).toBeUndefined()
    expect(buildRestoreHintContext(state, undefined, { facilities: { status: 'loading', key: '6442' }, results: new Map(), order })!.facilities).toBeUndefined()
    const ctx = buildRestoreHintContext(state, undefined, { facilities: ready([HIGH, CLINIC]), results: new Map(), order })!
    expect(ctx.facilities!.map((f) => f.targetId)).toEqual(['P29:高校'])
  })

  it('同じ材料なら同じ ctx。施設・調査の結果・優先順位が変わると作り直す', () => {
    const state = reachState()
    const facilities = ready([HIGH, TECH])
    const results = new Map<string, ResearchResult>()
    const source = { facilities, results, order: DEFAULT_PRIORITY_ORDER }
    const ctx = buildRestoreHintContext(state, undefined, source)
    expect(buildRestoreHintContext(state, undefined, { ...source })).toBe(ctx)
    const reordered = buildRestoreHintContext(state, undefined, { ...source, order: movePriority(DEFAULT_PRIORITY_ORDER, 'higher_education', 1) })
    expect(reordered).not.toBe(ctx)
    expect(reordered!.facilities!.find((f) => f.targetId === TECH.targetId)!.rank).toBe(5)
    const researched = buildRestoreHintContext(state, undefined, { ...source, results: new Map([[HIGH.targetId, RESULT]]) })
    expect(researched!.facilities![0].research?.facts[0].value).toBe('8時40分')
    // 調べた結果が変わると、窓も作り直す
    expect(ctx!.facilities![0].windows.arrive.source).toBe('default')
    expect(researched!.facilities![0].windows.arrive.source).toBe('research')
  })

  it('渡さなければ、周辺の施設の調査の store と優先順位の store の今の状態を使う', () => {
    const state = reachState()
    expect(buildRestoreHintContext(state)!.facilities).toBeUndefined()
    useResearchStore.setState({ facilities: ready([HOSPITAL]) })
    expect(buildRestoreHintContext(state)!.facilities!.map((f) => [f.targetId, f.rank])).toEqual([['P04:病院', 1]])
    usePriorityStore.getState().move('inpatient_hospital', 1)
    expect(buildRestoreHintContext(state)!.facilities!.map((f) => [f.targetId, f.rank])).toEqual([['P04:病院', 2]])
  })
})
