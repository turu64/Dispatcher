import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PRIORITY, DEFAULT_PRIORITY_ORDER, movePriority, priorityRank } from '@/store/priority'
import type { OperatorOverlap } from './busstops'
import {
  compareOperators,
  defaultSelection,
  EXCLUDED_SCHOOL_TYPES,
  facilitiesInBounds,
  facilityCategory,
  fetchFacilities,
  groupCandidates,
  initialShownCount,
  isOwnOperator,
  mergeFacilityFiles,
  OPERATOR_GROUP,
  operatorMovementFacts,
  OTHER_GROUP,
  parseFacility,
  researchBounds,
  researchCandidates,
  type Facility,
  type ResearchCandidate,
} from './facilities'

// 停留所は旭川の近く(北緯 43.77 度)の3つ。外接矩形は 43.76〜43.78、142.35〜142.37
const STOPS = [
  { lat: 43.76, lon: 142.35 },
  { lat: 43.77, lon: 142.36 },
  { lat: 43.78, lon: 142.37 },
]
// 緯度 0.01 度 ≒ 1.11km
const NORTH_EDGE = 43.78

function item(targetId: string, kind: string, name: string, lat: number, lon: number, detail: Record<string, unknown> = {}) {
  return { target_id: targetId, kind, name, municipality: '旭川市', lat, lon, detail }
}

const FILE_A = {
  mesh1: '6442',
  facilities: [
    item('P04:hosp-small', 'hospital', '小さい病院', 43.77, 142.36, { beds: 40 }),
    item('P04:hosp-big', 'hospital', '大きい病院', 43.771, 142.361, { beds: 300, emergency: true }),
    item('P04:clinic', 'clinic', '内科クリニック', 43.765, 142.355, { beds: 0 }),
    item('P29:high', 'school', '第一高等学校', 43.775, 142.36, { school_type: '高等学校', open_status: '開校中' }),
    item('P29:closed', 'school', '休校の高校', 43.775, 142.365, { school_type: '高等学校', open_status: '休校中' }),
    // 種別が分からない学校(優先順位の外)
    item('P29:other', 'school', '種別の無い学校', 43.77, 142.355),
    item('P29:univ', 'school', '大学', 43.773, 142.359, { school_type: '大学' }),
    // 北に 1.9km(範囲の中)と 2.5km(範囲の外)
    item('P29:near', 'school', '近くの高校', NORTH_EDGE + 0.017, 142.36, { school_type: '高等学校' }),
    item('P29:far', 'school', '遠くの高校', NORTH_EDGE + 0.0225, 142.36, { school_type: '高等学校' }),
    item('P11:道北バス(株)', 'operator', '道北バス(株)', 43.77, 142.36, { stops: 500, bbox: [43.7, 142.3, 43.8, 142.4] }),
    item('P11:ほかのバス', 'operator', 'ほかのバス', 44.5, 143.0, { stops: 20, bbox: [44.4, 142.9, 44.6, 143.1] }),
    { target_id: 'X:形が違う', kind: 'school', name: 'x', lat: 43.77, lon: 142.36 },
  ],
  sources: ['国土数値情報を加工して作成'],
}

// 「ほかのバス」は別の1次メッシュにも停留所があり、そちらの範囲が停留所の近くにかかる
const FILE_B = {
  mesh1: '6542',
  facilities: [item('P11:ほかのバス', 'operator', 'ほかのバス(後のファイル)', 43.0, 142.0, { stops: 20, bbox: [43.75, 142.34, 43.79, 142.38] })],
  sources: ['国土数値情報を加工して作成', '別の出典'],
}

function merged(): Facility[] {
  return mergeFacilityFiles([FILE_A, FILE_B]).facilities
}

describe('parseFacility', () => {
  it('調査の対象外の学校(幼稚園・認定こども園・小学校・中学校・義務教育学校)は読み飛ばす(中等教育学校は読む)', () => {
    for (const t of ['幼稚園', '幼保連携型認定こども園', '小学校', '中学校', '義務教育学校']) {
      expect(parseFacility(item('P29:x', 'school', t, 43, 142, { school_type: t }))).toBeNull()
    }
    expect([...EXCLUDED_SCHOOL_TYPES].sort()).toEqual(['中学校', '小学校', '幼保連携型認定こども園', '幼稚園', '義務教育学校'].sort())
    expect(parseFacility(item('P29:s', 'school', '中等教育学校', 43, 142, { school_type: '中等教育学校' }))).not.toBeNull()
    expect(parseFacility(item('P29:u', 'school', '種別の無い学校', 43, 142))).not.toBeNull()
  })

  it('学校・病院・事業者の詳しいことを読む', () => {
    expect(parseFacility(item('P29:x', 'school', ' 高校 ', 43, 142, { school_type: '高等学校', open_status: '開校中' }))).toEqual({
      targetId: 'P29:x',
      kind: 'school',
      name: '高校',
      municipality: '旭川市',
      lat: 43,
      lon: 142,
      schoolType: '高等学校',
      openStatus: '開校中',
    })
    expect(parseFacility(item('P04:y', 'hospital', '病院', 43, 142, { beds: 120, emergency: true }))).toMatchObject({ beds: 120, emergency: true })
    expect(parseFacility(item('P11:z', 'operator', 'バス', 43, 142, { stops: 3, bbox: [43, 142, 43.1, 142.1] }))).toMatchObject({
      operatorStops: 3,
      operatorBounds: { south: 43, west: 142, north: 43.1, east: 142.1 },
    })
  })

  it('形の合わないものは null(ID の形、種類、名前、位置)', () => {
    expect(parseFacility(item('P99:x', 'school', 'a', 43, 142))).toBeNull()
    expect(parseFacility(item('P29:x\n', 'school', 'a', 43, 142))).toBeNull()
    expect(parseFacility(item('P29:x', 'airport', 'a', 43, 142))).toBeNull()
    expect(parseFacility(item('P29:x', 'school', ' ', 43, 142))).toBeNull()
    expect(parseFacility(item('P29:x', 'school', 'a', 91, 142))).toBeNull()
    expect(parseFacility({ ...item('P29:x', 'school', 'a', 43, 142), lat: '43' })).toBeNull()
    expect(parseFacility(null)).toBeNull()
  })

  it('市町村が空なら null にする', () => {
    expect(parseFacility({ ...item('P11:x', 'operator', 'a', 43, 142), municipality: '' })?.municipality).toBeNull()
  })
})

describe('mergeFacilityFiles', () => {
  it('同じ target_id の事業者は1つにまとめ、位置は最初のファイル、範囲は和にする。形の合わない要素は数える', () => {
    const { facilities, sources, skipped } = mergeFacilityFiles([FILE_A, FILE_B])
    const other = facilities.filter((f) => f.targetId === 'P11:ほかのバス')
    expect(other).toHaveLength(1)
    expect(other[0].name).toBe('ほかのバス')
    expect(other[0].lat).toBe(44.5)
    expect(other[0].operatorBounds).toEqual({ south: 43.75, west: 142.34, north: 44.6, east: 143.1 })
    expect(sources).toEqual(['国土数値情報を加工して作成', '別の出典'])
    expect(skipped).toBe(1)
  })
})

describe('範囲と候補', () => {
  it('範囲は停留所の外接矩形に 2km 以上を足したもの', () => {
    const b = researchBounds(STOPS)!
    expect(b.north - NORTH_EDGE).toBeGreaterThan(2000 / 111_300)
    expect(b.north - NORTH_EDGE).toBeLessThan(2100 / 110_000)
    expect(researchBounds([])).toBeNull()
  })

  it('範囲の中の施設だけ。事業者は停留所の範囲(bbox)が重なれば入る', () => {
    const ids = facilitiesInBounds(merged(), researchBounds(STOPS)!).map((f) => f.targetId)
    expect(ids).toContain('P29:near')
    expect(ids).not.toContain('P29:far')
    // 位置(重心)は遠いが、停留所の範囲が重なる
    expect(ids).toContain('P11:ほかのバス')
  })

  it('読み込んだ GTFS の事業者と、休校中の学校に印を付ける', () => {
    const cands = researchCandidates(merged(), STOPS, ['道北バス株式会社'])
    expect(cands.find((c) => c.facility.targetId === 'P11:道北バス(株)')?.ownOperator).toBe(true)
    expect(cands.find((c) => c.facility.targetId === 'P11:ほかのバス')?.ownOperator).toBe(false)
    expect(cands.find((c) => c.facility.targetId === 'P29:closed')?.closed).toBe(true)
    expect(cands.find((c) => c.facility.targetId === 'P29:high')?.closed).toBe(false)
    // 停留所までの距離
    const near = cands.find((c) => c.facility.targetId === 'P29:near')!
    expect(near.nearestStopM).toBeGreaterThan(1800)
    expect(near.nearestStopM).toBeLessThan(2100)
  })

  it('事業者名は書き方の違い(株式会社・(株)・全角)をそろえて比べる', () => {
    expect(isOwnOperator('道北バス(株)', ['道北バス株式会社'])).toBe(true)
    expect(isOwnOperator('道北バス', ['道北バス(株)'])).toBe(true)
    expect(isOwnOperator('旭川電気軌道(株)', ['道北バス株式会社'])).toBe(false)
    expect(isOwnOperator('道北バス', [])).toBe(false)
  })

  it('重要拠点の種類:病院は入院設備のある病院、高校・特別支援、大学など、診療所。種別が分からない学校と事業者は優先順位の外', () => {
    const cat = (id: string) => facilityCategory(merged().find((f) => f.targetId === id)!)
    expect(cat('P04:hosp-big')).toBe('inpatient_hospital')
    expect(cat('P04:clinic')).toBe('clinic')
    expect(cat('P29:high')).toBe('high_school')
    expect(cat('P29:univ')).toBe('higher_education')
    expect(cat('P29:other')).toBeNull()
    expect(cat('P11:ほかのバス')).toBeNull()
  })
})

describe('defaultSelection', () => {
  const cands = () => researchCandidates(merged(), STOPS, ['道北バス株式会社'])

  it('優先順位の高い種類から1件ずつ巡回して取り、周辺の事業者(自社を除く)は最後の列。病院は病床の多い順', () => {
    expect(defaultSelection(cands(), DEFAULT_PRIORITY_ORDER, 30)).toEqual([
      // 1巡目:病院・高校・大学・診療所・事業者
      'P04:hosp-big',
      'P29:high',
      'P29:univ',
      'P04:clinic',
      'P11:ほかのバス',
      // 2巡目
      'P04:hosp-small',
    ])
  })

  it('休校中、優先順位の外(種別が分からない学校)、停留所から 1,200m より遠い施設は選ばない', () => {
    const picked = defaultSelection(cands(), DEFAULT_PRIORITY_ORDER, 30)
    expect(picked).not.toContain('P29:closed')
    expect(picked).not.toContain('P29:other')
    expect(picked).not.toContain('P29:near')
    expect(picked).not.toContain('P11:道北バス(株)')
  })

  it('上限で切る', () => {
    expect(defaultSelection(cands(), DEFAULT_PRIORITY_ORDER, 3)).toEqual(['P04:hosp-big', 'P29:high', 'P29:univ'])
  })

  it('優先順位を並べ替えると、既定の選び方も変わる', () => {
    let order = DEFAULT_PRIORITY_ORDER
    order = movePriority(order, 'high_school', -1)
    order = movePriority(order, 'high_school', -1)
    expect(order.slice(0, 3)).toEqual(['high_school', 'inpatient_hospital', 'station_airport'])
    expect(defaultSelection(cands(), order, 2)).toEqual(['P29:high', 'P04:hosp-big'])
  })

  it('同じ入力ならいつも同じ並び(候補の並びに左右されない)', () => {
    const a = defaultSelection(cands(), DEFAULT_PRIORITY_ORDER, 30)
    const b = defaultSelection([...cands()].reverse(), DEFAULT_PRIORITY_ORDER, 30)
    expect(b).toEqual(a)
  })
})

describe('groupCandidates', () => {
  it('周辺の事業者 → 優先順位の種類の順 → 優先順位の外、にまとめる(データの無い種類のまとまりは無い)', () => {
    const groups = groupCandidates(researchCandidates(merged(), STOPS, []), DEFAULT_PRIORITY_ORDER)
    expect(groups.map((g) => g.label)).toEqual([OPERATOR_GROUP, '入院設備のある病院', '高校・特別支援学校', '大学・高専・専修学校', '診療所', OTHER_GROUP])
    expect(groups[1].items.map((c) => c.facility.targetId)).toEqual(['P04:hosp-big', 'P04:hosp-small'])
  })
})

describe('重要拠点の優先順位', () => {
  it('既定は CLAUDE.md の9段階(中学校は 2026-11-06 に外した)。データの無い種類は none', () => {
    expect(DEFAULT_PRIORITY.map((c) => c.label)).toEqual([
      '入院設備のある病院',
      '鉄道駅・空港',
      '高校・特別支援学校',
      '大学・高専・専修学校',
      '介護・福祉施設',
      '役所',
      '診療所',
      '商業施設・郵便局',
      '観光地',
    ])
    expect(DEFAULT_PRIORITY.filter((c) => c.data === 'none').map((c) => c.key)).toEqual(['welfare', 'government', 'commerce_post', 'tourism'])
  })

  it('順位と並べ替え(端では動かない)', () => {
    expect(priorityRank(DEFAULT_PRIORITY_ORDER, 'clinic')).toBe(7)
    expect(movePriority(DEFAULT_PRIORITY_ORDER, 'inpatient_hospital', -1)).toBe(DEFAULT_PRIORITY_ORDER)
    expect(movePriority(DEFAULT_PRIORITY_ORDER, 'tourism', 1)).toBe(DEFAULT_PRIORITY_ORDER)
    expect(movePriority(DEFAULT_PRIORITY_ORDER, 'clinic', 1).indexOf('clinic')).toBe(7)
  })
})

describe('fetchFacilities', () => {
  function res(status: number, body?: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }

  it('404 はその1次メッシュに施設が無いとして扱い、ほかのファイルをまとめる。取れたものは使い回す', async () => {
    const fetchFn = vi.fn(async (url: string) => (url.endsWith('6442') ? res(200, FILE_A) : url.endsWith('6542') ? res(200, FILE_B) : res(404)))
    const cache = new Map()
    const r = await fetchFacilities(['6542', '6442', '6443'], fetchFn, cache)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.missing).toEqual(['6443'])
    // 1次メッシュの順に読む(事業者の位置は 6442 のもの)
    expect(r.facilities.find((f) => f.targetId === 'P11:ほかのバス')?.lat).toBe(44.5)
    expect(fetchFn).toHaveBeenCalledWith('/api/ref/facilities/6442')
    await fetchFacilities(['6542', '6442', '6443'], fetchFn, cache)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('全部が 404 なら、参照データが無いと出す', async () => {
    const r = await fetchFacilities(['6442'], async () => res(404), new Map())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('data/out/ref/facilities')
  })

  it('404 以外のエラーやつながらないときは、読み込めなかったと出す(取れなかったものは使い回さない)', async () => {
    const cache = new Map()
    const r = await fetchFacilities(['6442'], async () => res(500), cache)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('500')
    expect(cache.has('6442')).toBe(false)
    const r2 = await fetchFacilities(
      ['6442'],
      async () => {
        throw new Error('x')
      },
      cache,
    )
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.message).toContain('サーバーにつながりません')
  })

  it('範囲が決まらない(1次メッシュが無い)ときは読まない', async () => {
    const fetchFn = vi.fn()
    const r = await fetchFacilities([], fetchFn, new Map())
    expect(r.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('fetchFacilities の停留所(busstops)', () => {
  function res(status: number, body?: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }

  it('同じファイルの busstops を読み、1次メッシュのファイルをつなぐ(取得の回数は増えない)', async () => {
    const a = { ...FILE_A, busstops: [{ name: '停1', lat: 43.77, lon: 142.36, operators: ['P11:ほかのバス'], routes: ['1番'] }] }
    const b = { ...FILE_B, busstops: [{ name: '停2', lat: 44.5, lon: 142.5, operators: ['P11:ほかのバス'], routes: [] }, { name: '', lat: 0, lon: 0, operators: [] }] }
    const fetchFn = vi.fn(async (url: string) => (url.endsWith('6442') ? res(200, a) : res(200, b)))
    const r = await fetchFacilities(['6442', '6542'], fetchFn, new Map())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.busstops?.map((s) => s.name)).toEqual(['停1', '停2'])
  })

  it('どのファイルにも busstops の鍵が無ければ null(古い加工。重なりを数えない)', async () => {
    const r = await fetchFacilities(['6442'], async () => res(200, FILE_A), new Map())
    expect(r.ok && r.busstops).toBeNull()
  })
})

describe('周辺の事業者の並び(重なり)', () => {
  function op(id: string, nearestStopM: number, overlap: Pick<OperatorOverlap, 'ownStopIds' | 'otherStops'> | null | undefined): ResearchCandidate {
    const facility: Facility = { targetId: id, kind: 'operator', name: id, municipality: null, lat: 43.77, lon: 142.36 }
    return {
      facility,
      category: null,
      nearestStopM,
      ownOperator: false,
      closed: false,
      overlap: overlap === undefined ? undefined : overlap && { targetId: id, routes: [], ...overlap },
    }
  }
  const stopsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, lat: 43, lon: 142, operators: ['P11:x'], routes: [] }))

  it('重なりのある事業者を、重なる自社の停留所の多い順(同じなら他社の停留所の多い順)に先にし、重なりの無い事業者は後ろ', () => {
    const list = [
      op('P11:none', 10, null),
      op('P11:one', 500, { ownStopIds: ['A'], otherStops: stopsOf(5) }),
      op('P11:three', 900, { ownStopIds: ['A', 'B', 'C'], otherStops: stopsOf(1) }),
      op('P11:one-more', 800, { ownStopIds: ['B'], otherStops: stopsOf(6) }),
    ]
    const order = [...list].sort(compareOperators).map((c) => c.facility.targetId)
    expect(order).toEqual(['P11:three', 'P11:one-more', 'P11:one', 'P11:none'])
    expect(groupCandidates(list, DEFAULT_PRIORITY_ORDER)[0].items.map((c) => c.facility.targetId)).toEqual(order)
    expect(defaultSelection(list, DEFAULT_PRIORITY_ORDER, 2)).toEqual(['P11:three', 'P11:one-more'])
  })

  it('読み込んだ GTFS の事業者は、重なりや距離にかかわらずいちばん上に置く(既定の選び方には入れない)', () => {
    const own = { ...op('P11:own', 5000, null), ownOperator: true }
    const list = [op('P11:three', 100, { ownStopIds: ['A', 'B', 'C'], otherStops: stopsOf(1) }), own, op('P11:none', 10, null)]
    expect(groupCandidates(list, DEFAULT_PRIORITY_ORDER)[0].items.map((c) => c.facility.targetId)).toEqual(['P11:own', 'P11:three', 'P11:none'])
    expect(defaultSelection(list, DEFAULT_PRIORITY_ORDER, 3)).not.toContain('P11:own')
  })

  it('重なりを数えていない(停留所の参照データが無い)ときは、今までどおり停留所に近い順', () => {
    const list = [op('P11:far', 900, undefined), op('P11:near', 100, undefined)]
    expect([...list].sort(compareOperators).map((c) => c.facility.targetId)).toEqual(['P11:near', 'P11:far'])
  })
})

describe('initialShownCount', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ facility: { targetId: `id${i}` } }) as ResearchCandidate)

  it('選んだ対象が無ければ最初の5件まで', () => {
    expect(initialShownCount(items, new Set())).toBe(5)
    expect(initialShownCount(items.slice(0, 3), new Set())).toBe(3)
  })

  it('選んだ対象のうち最後のものの後ろ3件まで(件数より多くしない)', () => {
    expect(initialShownCount(items, new Set(['id0']))).toBe(4)
    expect(initialShownCount(items, new Set(['id0', 'id6']))).toBe(10)
    expect(initialShownCount(items, new Set(['id10']))).toBe(12)
  })
})

describe('operatorMovementFacts', () => {
  it('label に廃止・休止を含む事実も返す(周知文で廃止された系統を案内しないため)', () => {
    const facts = [
      { label: '路線の廃止', value: 'x' },
      { label: '運行区間', value: 'y' },
      { label: '一部区間の休止', value: 'z' },
    ]
    expect(operatorMovementFacts(facts).map((f) => f.value)).toEqual(['x', 'z'])
  })

  it('label に減便・ダイヤ改正・運休・特別ダイヤを含む事実だけを、並びのまま返す', () => {
    const facts = [
      { label: '会社の概要', value: 'x' },
      { label: '朝日線の減便(報道)', value: 'a' },
      { label: '直近のダイヤ改正', value: 'b' },
      { label: '災害時の運休', value: 'c' },
      { label: '年末年始の特別ダイヤ', value: 'd' },
      { label: '問い合わせ先', value: '減便のお知らせ' },
    ]
    expect(operatorMovementFacts(facts).map((f) => f.value)).toEqual(['a', 'b', 'c', 'd'])
  })
})
