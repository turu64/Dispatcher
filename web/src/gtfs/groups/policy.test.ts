import { describe, expect, it } from 'vitest'
import type { PolicyKind, PolicySettings } from '../edit/ops'
import { editGroups } from './edit'
import { featuresOf, kyotoLike, svc } from './groups.fixture'
import { policyServicesFor } from './policy'
import { proposeGroups } from './rules'
import type { PolicyServices } from './types'

const SAT: PolicyKind = 'weekdayToSaturday'
const SUN: PolicyKind = 'weekdayToSundayHoliday'

function ok(v: ReturnType<typeof policyServicesFor>): PolicyServices {
  if ('error' in v) throw new Error(v.error.map((p) => p.message).join(' '))
  return v
}

describe('policyServicesFor', () => {
  it('1組・1つの入れ替えに使う service・残すもの無しなら pairs を入れない(今の1組の形)', () => {
    const g = proposeGroups(featuresOf([svc('01', { weekday: 100 }), svc('03', { saturday: 20 }), svc('06', { sundayHoliday: 25 })]))
    expect(policyServicesFor(g, SAT)).toEqual({ kind: SAT, weekdayService: '01', replacementService: '03' })
    expect(policyServicesFor(g, SUN)).toEqual({ kind: SUN, weekdayService: '01', replacementService: '06' })
    expect(Object.keys(ok(policyServicesFor(g, SAT)))).toEqual(['kind', 'weekdayService', 'replacementService'])
  })

  it('主の組が先頭、あとは weekday の昇順。残す service を keptWeekdayServices に入れる(京都の形)', () => {
    const g = proposeGroups(kyotoLike())
    expect(policyServicesFor(g, SAT)).toEqual({
      kind: SAT,
      weekdayService: '01001',
      replacementService: '03001',
      pairs: [
        { weekday: '01001', replacements: ['03001'] },
        { weekday: '01001_A', replacements: ['03001_A'] },
        { weekday: '01001_C', replacements: ['03001_C'] },
        { weekday: '01005_MSN', replacements: [] },
      ],
      keptWeekdayServices: ['01002_RIT'],
    })
    // 日祝には 01001_C の組が無く、01001_C は残す
    expect(ok(policyServicesFor(g, SUN)).keptWeekdayServices).toEqual(['01001_C', '01002_RIT'])
  })

  it('多対1:replacements は主の入れ替えに使う service(regular で便が一番多い)が先頭、あとは昇順', () => {
    const g = proposeGroups(
      featuresOf([
        svc('S000001', { weekday: 98 }, { trips: 4660 }),
        svc('S000002', { saturday: 19 }, { trips: 238 }),
        svc('S000027', { saturday: 19, sundayHoliday: 24 }, { trips: 667 }),
        svc('S000029', { saturday: 20, sundayHoliday: 25 }, { trips: 1197 }),
        svc('S000036', { saturday: 20, sundayHoliday: 25 }, { trips: 2 }),
      ]),
    )
    const p = ok(policyServicesFor(g, SAT))
    expect(p.replacementService).toBe('S000029')
    expect(p.pairs).toEqual([{ weekday: 'S000001', replacements: ['S000029', 'S000002', 'S000027', 'S000036'] }])
    expect(p.keptWeekdayServices).toEqual([])
    // 1つの入れ替えに使う service は1つの組にしか出てこない(M2)
    const all = p.pairs!.flatMap((x) => x.replacements)
    expect(new Set(all).size).toBe(all.length)
  })

  it('主の組に入れ替えに使う service が無ければ replacementService は空(名士バスの形)', () => {
    const g = proposeGroups(featuresOf([svc('S000001', { weekday: 100, saturday: 20, sundayHoliday: 25 }), svc('S000002', { weekday: 100 }, { trips: 1 })]))
    expect(policyServicesFor(g, SAT)).toEqual({
      kind: SAT,
      weekdayService: 'S000002',
      replacementService: '',
      pairs: [{ weekday: 'S000002', replacements: [] }],
      keptWeekdayServices: [],
    })
  })

  it('エラーがあれば { error } を返す。「残す」を選べば値を返す', () => {
    const g = proposeGroups(featuresOf([svc('S1', { weekday: 98 }), svc('S2', { saturday: 19 }), svc('S39', { weekday: 99, sundayHoliday: 24 })]))
    const v = policyServicesFor(g, SAT)
    expect('error' in v && v.error.map((p) => p.code)).toEqual(['unsupportedService'])
    const kept = editGroups(g, { kind: SAT, serviceId: 'S39', treatment: 'keep' })
    expect(policyServicesFor(kept, SAT)).toEqual({
      kind: SAT,
      weekdayService: 'S1',
      replacementService: 'S2',
      pairs: [{ weekday: 'S1', replacements: ['S2'] }],
      keptWeekdayServices: ['S39'],
    })
  })

  it('決まらない割り当てがあれば { error }', () => {
    const g = proposeGroups(featuresOf([svc('01001', { weekday: 98 }), svc('05001_A', { weekday: 97 }), svc('06001_A', { weekday: 97 }), svc('03001_A', { saturday: 19 })]))
    const v = policyServicesFor(g, SAT)
    expect('error' in v && v.error.map((p) => p.code)).toEqual(['undecidedReplacement'])
  })

  it('入れ替える便が無ければ { error }(nothingToChange)', () => {
    const g = proposeGroups(featuresOf([svc('ALL', { weekday: 99, saturday: 19, sundayHoliday: 24 })]))
    const v = policyServicesFor(g, SAT)
    expect('error' in v && v.error.map((p) => p.code)).toEqual(['nothingToChange'])
    const allKept = editGroups(
      proposeGroups(featuresOf([svc('W', { weekday: 98 }), svc('ALL', { weekday: 99, saturday: 19, sundayHoliday: 24 })])),
      { kind: SAT, serviceId: 'W', treatment: 'keep' },
    )
    const v2 = policyServicesFor(allKept, SAT)
    expect('error' in v2 && v2.error.map((p) => p.code)).toEqual(['nothingToChange'])
  })

  it('主の平日の service を「なくす」以外にしたら、erase の組のうち便が一番多いものを主にする', () => {
    const g = proposeGroups(featuresOf([svc('W1', { weekday: 98 }, { trips: 50 }), svc('W2', { weekday: 98 }, { trips: 5 }), svc('W3', { weekday: 98 }, { trips: 9 })]))
    const e = editGroups(g, { kind: SAT, serviceId: 'W1', treatment: 'keep' })
    expect(ok(policyServicesFor(e, SAT))).toMatchObject({
      weekdayService: 'W3',
      replacementService: '',
      pairs: [
        { weekday: 'W3', replacements: [] },
        { weekday: 'W2', replacements: [] },
      ],
      keptWeekdayServices: ['W1'],
    })
  })
})

describe('policyServicesFor の multiService: false(第2段を外したとき)', () => {
  it('主の組だけを pairs 無しで返し、ほかを notApplied に入れる', () => {
    const g = proposeGroups(kyotoLike())
    expect(policyServicesFor(g, SAT, { multiService: false })).toEqual({
      kind: SAT,
      weekdayService: '01001',
      replacementService: '03001',
      notApplied: [
        { weekday: '01001_A', replacements: ['03001_A'] },
        { weekday: '01001_C', replacements: ['03001_C'] },
        { weekday: '01005_MSN', replacements: [] },
        { weekday: '01002_RIT', replacements: [] },
      ],
    })
  })

  it('主の組のほかの入れ替えに使う service も notApplied に入れる', () => {
    const g = proposeGroups(featuresOf([svc('W', { weekday: 98 }, { trips: 100 }), svc('S', { saturday: 19 }, { trips: 50 }), svc('SH', { saturday: 19, sundayHoliday: 24 }, { trips: 10 })]))
    expect(policyServicesFor(g, SAT, { multiService: false })).toEqual({
      kind: SAT,
      weekdayService: 'W',
      replacementService: 'S',
      notApplied: [{ weekday: 'W', replacements: ['SH'] }],
    })
  })

  it('主の組に入れ替えに使う service が無ければ適用できない', () => {
    const g = proposeGroups(featuresOf([svc('S000002', { weekday: 100 })]))
    const v = policyServicesFor(g, SAT, { multiService: false })
    expect('error' in v && v.error.map((p) => p.code)).toEqual(['mainPairWithoutReplacement'])
  })
})

describe('policyServicesFor の値は PolicySettings に入る(A と C の型の取り決め。docs/design-service-groups.md §7.5)', () => {
  it('notApplied を除き、期間と除外する系統を足すと PolicySettings になり', () => {
    const g = proposeGroups(kyotoLike())
    const { notApplied: _notApplied, ...services } = ok(policyServicesFor(g, SAT))
    const settings = { ...services, period: { start: '20261101', end: null }, excludedRoutes: [] } satisfies PolicySettings
    expect(settings.pairs?.[0].weekday).toBe(settings.weekdayService)
    expect(settings.replacementService).toBe(settings.pairs?.[0].replacements[0] ?? '')
    const single = ok(policyServicesFor(g, SAT, { multiService: false }))
    const { notApplied: _rest, ...one } = single
    expect(({ ...one, period: { start: '20261101', end: null }, excludedRoutes: [] } satisfies PolicySettings).pairs).toBeUndefined()
  })
})
