import { describe, expect, it } from 'vitest'
import { multiFeed, multiPlan } from '../edit/form2.fixture'
import { computeServiceFeatures } from './features'
import { featuresOf, kyotoLike, svc } from './groups.fixture'
import { proposeGroups } from './rules'
import { choicePairs, droppedPairWeekdays, groupedPolicyServices, groupSettings, sentenceServices, skippedReplacements, splitPairs } from './view'

const PERIOD = { start: '20261103', end: null }

describe('groupedPolicyServices(減便の方針の手順と AI がダイヤ単位で選ぶか)', () => {
  it('グループ分けが無ければ null(今の選び方)', () => {
    expect(groupedPolicyServices(null, false)).toBeNull()
  })

  it('単純な GTFS で1組の形で足りる(道北バス)なら null。確定の印に関わらない', () => {
    const g = proposeGroups(featuresOf([svc('01', { weekday: 100 }), svc('03', { saturday: 20 }), svc('06', { sundayHoliday: 25 })]))
    expect(g.simple).toBe(true)
    expect(groupedPolicyServices(g, true)).toBeNull()
  })

  it('単純な GTFS でも、入れ替えに使う service が無い(名士バスの形)なら組の表で選ぶ', () => {
    const g = proposeGroups(featuresOf([svc('S2', { weekday: 100 }), svc('S1', { weekday: 100, saturday: 20, sundayHoliday: 25 })]))
    expect(g.simple).toBe(true)
    const r = groupedPolicyServices(g, true)
    expect(r?.status).toBe('confirmed')
    if (r?.status !== 'confirmed') return
    expect(r.byKind.weekdayToSaturday).toEqual({
      kind: 'weekdayToSaturday',
      weekdayService: 'S2',
      replacementService: '',
      pairs: [{ weekday: 'S2', replacements: [] }],
      keptWeekdayServices: [],
    })
  })

  it('単純でない GTFS は、確定するまで unconfirmed。確定したら種類ごとの値(作れなければ error)', () => {
    const g = proposeGroups(computeServiceFeatures(multiFeed(), null))
    expect(g.simple).toBe(false)
    expect(groupedPolicyServices(g, false)).toEqual({ status: 'unconfirmed' })
    const r = groupedPolicyServices(g, true)
    if (r?.status !== 'confirmed') throw new Error('confirmed のはず')
    const sat = r.byKind.weekdayToSaturday
    if ('error' in sat) throw new Error('土曜は作れるはず')
    expect(sat.weekdayService).toBe('01001')
    expect(sat.pairs?.map((p) => p.weekday)).toEqual(['01001', '01001_A', '01001_C', '01005_MSN', 'WB'])
    expect(sat.keptWeekdayServices).toEqual(['01002_RIT'])
    expect('notApplied' in sat).toBe(false)
    // 日祝には形2で表せない MS があり、作れない
    const sun = r.byKind.weekdayToSundayHoliday
    expect('error' in sun && sun.error.map((p) => p.code)).toEqual(['unsupportedService'])
  })

  it('京都の形でも、値は policyServicesFor と同じ(notApplied を除く)', () => {
    const r = groupedPolicyServices(proposeGroups(kyotoLike()), true)
    if (r?.status !== 'confirmed') throw new Error('confirmed のはず')
    const sat = r.byKind.weekdayToSaturday
    if ('error' in sat) throw new Error('作れるはず')
    expect(choicePairs(sat)[0]).toEqual({ weekday: '01001', replacements: ['03001'] })
  })
})

describe('groupSettings・splitPairs', () => {
  it('pairs があれば pairs と keptWeekdayServices を写し、期間と除外する系統を入れる', () => {
    const s = groupSettings(
      {
        kind: 'weekdayToSaturday',
        weekdayService: '01001',
        replacementService: '03001',
        pairs: [
          { weekday: '01001', replacements: ['03001'] },
          { weekday: '01005_MSN', replacements: [] },
        ],
        keptWeekdayServices: ['01002_RIT'],
      },
      PERIOD,
      ['R1'],
    )
    expect(s).toEqual({
      kind: 'weekdayToSaturday',
      weekdayService: '01001',
      replacementService: '03001',
      period: PERIOD,
      excludedRoutes: ['R1'],
      pairs: [
        { weekday: '01001', replacements: ['03001'] },
        { weekday: '01005_MSN', replacements: [] },
      ],
      keptWeekdayServices: ['01002_RIT'],
    })
    expect(splitPairs(s)).toEqual({ replaced: [{ weekday: '01001', replacements: ['03001'] }], erased: ['01005_MSN'], kept: ['01002_RIT'] })
  })

  it('pairs が無ければ今の1組の形のまま(項目を足さない)', () => {
    const s = groupSettings({ kind: 'weekdayToSaturday', weekdayService: '01', replacementService: '03' }, PERIOD, [])
    expect(Object.keys(s)).toEqual(['kind', 'weekdayService', 'replacementService', 'period', 'excludedRoutes'])
    expect(splitPairs(s)).toEqual({ replaced: [{ weekday: '01', replacements: ['03'] }], erased: [], kept: [] })
  })
})

describe('droppedPairWeekdays・sentenceServices(承認の前の組の内訳と文の数)', () => {
  it('期間に走らない主でない組の平日の service を、承認の前から除く(checkPolicy の pairWeekdayNotActive と同じ)', () => {
    const feed = multiFeed()
    const plan = multiPlan()
    // 01001_C は 11/2 だけ走る。期間 11/3〜 では走らない
    expect([...droppedPairWeekdays(feed, plan, { start: '20261103', end: '20261130' })]).toEqual(['01001_C'])
    expect(droppedPairWeekdays(feed, plan, { start: '20261101', end: '20261130' }).size).toBe(0)
    // 期間が決まらない・組が無ければ空
    expect(droppedPairWeekdays(feed, plan, null).size).toBe(0)
    expect(droppedPairWeekdays(feed, { pairs: undefined }, { start: '20261103', end: '20261130' }).size).toBe(0)
  })

  it('文の数は、入れ替える組だけ(なくす service と除く組を数えない)', () => {
    const plan = multiPlan()
    expect(sentenceServices(plan, new Set(['01001_C']))).toMatchObject({
      weekdays: ['01001', '01001_A', 'WB'],
      replacements: ['03001', '03001_A', 'SB1', 'SB2'],
      erased: ['01005_MSN'],
    })
    // 入れ替える組が無ければ、なくす平日の service
    expect(sentenceServices({ weekdayService: 'S2', replacementService: '', pairs: [{ weekday: 'S2', replacements: [] }] })).toMatchObject({
      weekdays: ['S2'],
      replacements: [],
    })
  })
  it('期間に走らないため加えない入れ替えに使う service を、承認の前から出す(checkPolicy の replacementNotActiveSkipped と同じ)', () => {
    const feed = multiFeed()
    const plan = multiPlan()
    // 03001_C は 10/31 だけ走る。期間 11/1〜 では走らない
    expect([...skippedReplacements(feed, plan, { start: '20261101', end: '20261130' })]).toEqual(['03001_C'])
    expect(skippedReplacements(feed, plan, { start: '20261031', end: '20261130' }).size).toBe(0)
    expect(skippedReplacements(feed, plan, null).size).toBe(0)
    expect(skippedReplacements(feed, { ...plan, pairs: undefined }, { start: '20261101', end: '20261130' }).size).toBe(0)
  })

  it('文の数は、加えない入れ替えに使う service を数えず、入れ替えに使う service がすべて加わらない組はなくす service に数える', () => {
    expect(sentenceServices(multiPlan(), new Set(), new Set(['03001_C']))).toMatchObject({
      weekdays: ['01001', '01001_A', 'WB'],
      replacements: ['03001', '03001_A', 'SB1', 'SB2'],
      erased: ['01005_MSN', '01001_C'],
    })
  })
})

