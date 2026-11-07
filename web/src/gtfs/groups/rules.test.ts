import { describe, expect, it } from 'vitest'
import type { PolicyKind } from '../edit/ops'
import { featuresOf, kyotoLike, svc } from './groups.fixture'
import { JEV_CONFIDENCE } from './merge'
import { proposeGroups, sideOf, THRESHOLDS } from './rules'
import type { KindRow, ServiceGroups } from './types'

function row(g: ServiceGroups, kind: PolicyKind, id: string): KindRow {
  const r = g.byKind[kind].rows.find((x) => x.serviceId === id)
  if (!r) throw new Error(`${id} の行がありません`)
  return r
}

const SAT: PolicyKind = 'weekdayToSaturday'
const SUN: PolicyKind = 'weekdayToSundayHoliday'

describe('役割(§2.3)', () => {
  it('runs と方針の種類から決める', () => {
    const w = svc('W', { weekday: 98 })
    const sh = svc('SH', { saturday: 19, sundayHoliday: 24 })
    const all = svc('ALL', { weekday: 99, saturday: 19, sundayHoliday: 24 })
    const ws = svc('WS', { weekday: 99, saturday: 19 })
    const wh = svc('WH', { weekday: 99, sundayHoliday: 24 })
    const h = svc('H', { sundayHoliday: 24 })
    expect([w, sh, all, ws, wh, h].map((s) => sideOf(s, SAT))).toEqual(['weekdayOnly', 'replacement', 'both', 'both', 'unsupported', 'unrelated'])
    expect([w, sh, all, ws, wh, h].map((s) => sideOf(s, SUN))).toEqual(['weekdayOnly', 'replacement', 'both', 'unsupported', 'both', 'replacement'])
  })
})

describe('proposeGroups(京都市営バスの形)', () => {
  const g = proposeGroups(kyotoLike())

  it('主の平日の service は便の一番多い regular の平日だけの service', () => {
    expect(g.byKind[SAT].mainWeekday).toBe('01001')
    expect(g.byKind[SUN].mainWeekday).toBe('01001')
    expect(g.simple).toBe(false)
  })

  it('接尾辞 → 主の平日の service → 使わない の順に割り当てる(§2.4)', () => {
    expect(row(g, SAT, '03001')).toMatchObject({ side: 'replacement', into: '01001', intoMark: 'rule' })
    expect(row(g, SAT, '03001_A')).toMatchObject({ into: '01001_A', intoMark: 'rule' })
    // どちらも regular でないので接尾辞で対応させる
    expect(row(g, SAT, '03001_C')).toMatchObject({ into: '01001_C', intoMark: 'rule' })
    expect(row(g, SAT, 'SRV_8_10600_01_A')).toMatchObject({ side: 'replacement', into: null, intoMark: 'rule' })
    expect(row(g, SUN, '02001')).toMatchObject({ into: '01001' })
    expect(row(g, SUN, '02001_A')).toMatchObject({ into: '01001_A' })
  })

  it('扱いの既定(§2.5):割り当てがあれば入れ替える、regular はなくす、partial・special は残す', () => {
    expect(row(g, SAT, '01001')).toMatchObject({ side: 'weekdayOnly', treatment: 'erase', basisMark: 'rule', intoMark: null })
    expect(row(g, SAT, '01001_C').treatment).toBe('erase')
    expect(row(g, SAT, '01005_MSN').treatment).toBe('erase')
    expect(row(g, SAT, '01005_MSN').reasons[0]).toContain('割り当たらないため')
    expect(row(g, SAT, '01002_RIT').treatment).toBe('keep')
    // 日祝には 01001_C の迂回の版が無いので、特定の日だけの 01001_C は残す
    expect(row(g, SUN, '01001_C').treatment).toBe('keep')
    expect(row(g, SUN, '01001_C').reasons[0]).toContain('11/2')
  })

  it('規則の案は byKind と proposal が同じで、Jev は null', () => {
    expect(g.proposal).toEqual(g.byKind)
    expect(g.jev).toBeNull()
    expect(g.byKind[SAT].problems).toEqual([])
  })
})

describe('接尾辞の規則の細かいところ', () => {
  it('basis が regular と regular でない組は接尾辞で対応させない', () => {
    const g = proposeGroups(
      featuresOf([
        svc('01001', { weekday: 98 }, { trips: 100 }),
        svc('01001_C', { weekday: 1 }, { trips: 5 }),
        // regular の土曜の _C は、特定の日だけの 01001_C に入れず、主の平日の service に入れる
        svc('03001_C', { saturday: 19 }, { trips: 5 }),
        // 特定の日だけの _D は、regular の 01001_D に入れず、使わない
        svc('01001_D', { weekday: 97 }, { trips: 5 }),
        svc('03001_D', { saturday: 1 }, { trips: 5 }),
      ]),
    )
    expect(row(g, SAT, '03001_C')).toMatchObject({ into: '01001', intoMark: 'rule' })
    expect(row(g, SAT, '03001_D')).toMatchObject({ into: null, intoMark: 'rule' })
  })

  it('接尾辞の合う service が2つ以上なら、頭が主の平日の service と同じものに絞る', () => {
    const g = proposeGroups(
      featuresOf([
        svc('01001', { weekday: 98 }, { trips: 100 }),
        svc('01001_A', { weekday: 97 }),
        svc('05001_A', { weekday: 97 }),
        svc('03001_A', { saturday: 19 }),
      ]),
    )
    expect(row(g, SAT, '03001_A')).toMatchObject({ into: '01001_A', intoMark: 'rule' })
  })

  it('絞っても決まらなければ undecided にし、エラー undecidedReplacement を出す', () => {
    const g = proposeGroups(
      featuresOf([
        svc('01001', { weekday: 98 }, { trips: 100 }),
        svc('05001_A', { weekday: 97 }),
        svc('06001_A', { weekday: 97 }),
        svc('03001_A', { saturday: 19 }),
      ]),
    )
    const r = row(g, SAT, '03001_A')
    expect(r).toMatchObject({ into: null, intoMark: 'undecided' })
    expect(r.reasons[0]).toContain('05001_A、06001_A')
    expect(g.byKind[SAT].problems.map((p) => [p.code, p.severity, p.serviceIds])).toContainEqual(['undecidedReplacement', 'error', ['03001_A']])
    // 割り当たらないので、05001_A・06001_A は regular のためなくす
    expect(row(g, SAT, '05001_A').treatment).toBe('erase')
    expect(g.simple).toBe(false)
  })
})

describe('形2で表せない service(§2.6)', () => {
  const g = proposeGroups(
    featuresOf([
      svc('S1', { weekday: 98 }, { trips: 100 }),
      svc('S2', { saturday: 19, sundayHoliday: 24 }),
      svc('S39', { weekday: 99, sundayHoliday: 24 }, { trips: 1 }),
      svc('S40', { weekday: 99, saturday: 19 }, { trips: 15 }),
    ]),
  )

  it('扱いを未決にしてエラーにする。ほかの種類では両方に走る', () => {
    expect(row(g, SAT, 'S39')).toMatchObject({ side: 'unsupported', treatment: null, basisMark: 'rule' })
    expect(row(g, SAT, 'S40').side).toBe('both')
    expect(row(g, SUN, 'S40')).toMatchObject({ side: 'unsupported', treatment: null })
    expect(row(g, SUN, 'S39').side).toBe('both')
    expect(g.byKind[SAT].problems).toEqual([expect.objectContaining({ code: 'unsupportedService', severity: 'error', serviceIds: ['S39'] })])
    expect(g.byKind[SUN].problems).toEqual([expect.objectContaining({ code: 'unsupportedService', serviceIds: ['S40'] })])
    expect(g.simple).toBe(false)
  })
})

describe('単純な GTFS(§2.7)', () => {
  it('平日・土曜・日祝が1つずつなら単純', () => {
    const g = proposeGroups(
      featuresOf([svc('01', { weekday: 100 }), svc('03', { saturday: 20 }), svc('06', { sundayHoliday: 25 })]),
    )
    expect(g.simple).toBe(true)
  })

  it('毎日運行・使わない特別の service はいくつあってもよい', () => {
    const g = proposeGroups(
      featuresOf([
        svc('01', { weekday: 95, sundayHoliday: 3 }),
        svc('03', { saturday: 19, sundayHoliday: 20 }),
        svc('0770-1', { weekday: 3, saturday: 1, sundayHoliday: 1 }),
        svc('ALL', { weekday: 99, saturday: 19, sundayHoliday: 24 }),
      ]),
    )
    expect(g.simple).toBe(true)
    expect(row(g, SAT, '0770-1').side).toBe('both')
  })

  it('平日だけの service が無ければ単純で、nothingToChange を出す', () => {
    const g = proposeGroups(featuresOf([svc('ALL', { weekday: 99, saturday: 19, sundayHoliday: 24 })]))
    expect(g.simple).toBe(true)
    expect(g.byKind[SAT].mainWeekday).toBeNull()
    expect(g.byKind[SAT].problems).toEqual([expect.objectContaining({ code: 'nothingToChange', severity: 'info' })])
  })

  it('平日だけの service が regular でない、または2つ以上なら単純でない', () => {
    expect(proposeGroups(featuresOf([svc('W', { weekday: 50 }), svc('S', { saturday: 19 })])).simple).toBe(false)
    expect(proposeGroups(featuresOf([svc('W', { weekday: 98 }), svc('W2', { weekday: 30 })])).simple).toBe(false)
  })

  it('入れ替えに使う service が2つ割り当たれば単純でない', () => {
    const g = proposeGroups(featuresOf([svc('W', { weekday: 98 }), svc('S', { saturday: 19 }), svc('SH', { saturday: 19, sundayHoliday: 24 })]))
    expect(row(g, SAT, 'S').into).toBe('W')
    expect(row(g, SAT, 'SH').into).toBe('W')
    expect(g.simple).toBe(false)
  })
})

describe('系統の重なり', () => {
  it('主の平日の service に入れた service の重なりが 0.2 未満なら注意を出す', () => {
    const g = proposeGroups(
      featuresOf([
        svc('W', { weekday: 98 }, { routes: ['1', '2', '3'] }),
        svc('S', { saturday: 19 }, { routes: ['1', '2'] }),
        svc('SX', { saturday: 19 }, { routes: ['7', '8', '9', '10', '11', '1'] }),
      ]),
    )
    expect(g.byKind[SAT].problems).toEqual([expect.objectContaining({ code: 'lowRouteOverlap', severity: 'warning', serviceIds: ['SX'] })])
    expect(row(g, SAT, 'SX').reasons.join('')).toContain('系統の重なりが小さい')
    expect(row(g, SAT, 'S').reasons.join('')).toContain('S の系統 2 のうち 2 が W にもあります')
  })
})

describe('しきい値', () => {
  it('1か所の定数にまとめる', () => {
    expect(THRESHOLDS.regular).toBe(0.7)
    expect(THRESHOLDS.partial).toBe(0.15)
    expect(THRESHOLDS.lowOverlap).toBe(0.2)
    expect(THRESHOLDS.jev).toBe(JEV_CONFIDENCE)
  })
})
