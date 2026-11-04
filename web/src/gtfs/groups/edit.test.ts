import { describe, expect, it } from 'vitest'
import type { PolicyKind } from '../edit/ops'
import { canConfirm, editGroups, resetToProposal } from './edit'
import { featuresOf, kyotoLike, svc } from './groups.fixture'
import { dropJevAnswers, mergeJevAnswers } from './merge'
import { proposeGroups } from './rules'
import type { JevJudgeResponse, KindRow, ServiceGroups } from './types'

const SAT: PolicyKind = 'weekdayToSaturday'
const SUN: PolicyKind = 'weekdayToSundayHoliday'

function row(g: ServiceGroups, kind: PolicyKind, id: string): KindRow {
  const r = g.byKind[kind].rows.find((x) => x.serviceId === id)
  if (!r) throw new Error(`${id} の行がありません`)
  return r
}

function codes(g: ServiceGroups, kind: PolicyKind): string[] {
  return g.byKind[kind].problems.map((p) => p.code)
}

const JEV: JevJudgeResponse = {
  model: 'typesafe-ai/jev',
  results: [
    {
      serviceId: '01005_MSN',
      role: 'weekday',
      provider: 'typesafe-ai',
      sent: { state: {}, questions: {} },
      serviceKind: { choice: 'regular_weekday', probabilities: { regular_weekday: 0.95, limited_weekdays: 0.05 }, confidence: 0.95 },
    },
    {
      serviceId: '03001_C',
      role: 'saturday',
      provider: 'typesafe-ai',
      sent: { state: {}, questions: {} },
      weekdayCounterpart: { choice: '01001_A', probabilities: { '01001_A': 0.9, '01001_C': 0.1 }, confidence: 0.95 },
    },
  ],
  failures: [],
  usage: { inputTokens: 100, costUsd: null },
}

describe('editGroups:扱い', () => {
  const g = proposeGroups(kyotoLike())

  it('「残す」にすると edited になり、Jev の答えを合わせ直しても、捨てても戻らない', () => {
    const e = editGroups(g, { kind: SAT, serviceId: '01005_MSN', treatment: 'keep' })
    expect(row(e, SAT, '01005_MSN')).toMatchObject({ treatment: 'keep', basisMark: 'edited' })
    // ほかの方針の種類は変えない
    expect(row(e, SUN, '01005_MSN')).toMatchObject({ treatment: 'erase', basisMark: 'rule' })
    const m = mergeJevAnswers(e, JEV)
    expect(row(m, SAT, '01005_MSN')).toMatchObject({ treatment: 'keep', basisMark: 'edited' })
    expect(row(m, SUN, '01005_MSN').basisMark).toBe('agreed')
    expect(row(dropJevAnswers(m), SAT, '01005_MSN')).toMatchObject({ treatment: 'keep', basisMark: 'edited' })
  })

  it('入れ替えに使う service が割り当たっている平日の service は残せない(keptHasReplacements)', () => {
    const e = editGroups(g, { kind: SAT, serviceId: '01001_A', treatment: 'keep' })
    expect(row(e, SAT, '01001_A')).toMatchObject({ treatment: 'erase', basisMark: 'rule' })
    expect(e.byKind[SAT].problems).toContainEqual(expect.objectContaining({ code: 'keptHasReplacements', severity: 'error', serviceIds: ['01001_A'] }))
    // 次の直しで消える
    const next = editGroups(e, { kind: SAT, serviceId: '01005_MSN', treatment: 'keep' })
    expect(codes(next, SAT)).not.toContain('keptHasReplacements')
  })

  it('形2で表せない service は「残す」だけを選べ、選ぶとエラーが消える', () => {
    const f = featuresOf([svc('S1', { weekday: 98 }), svc('S2', { saturday: 19 }), svc('S39', { weekday: 99, sundayHoliday: 24 })])
    const p = proposeGroups(f)
    expect(codes(p, SAT)).toEqual(['unsupportedService'])
    expect(editGroups(p, { kind: SAT, serviceId: 'S39', treatment: 'erase' })).toBe(p)
    const kept = editGroups(p, { kind: SAT, serviceId: 'S39', treatment: 'keep' })
    expect(row(kept, SAT, 'S39')).toMatchObject({ treatment: 'keep', basisMark: 'edited' })
    expect(codes(kept, SAT)).toEqual([])
  })

  it('「残す」の既定の service を「なくす」にできる', () => {
    const e = editGroups(g, { kind: SAT, serviceId: '01002_RIT', treatment: 'erase' })
    expect(row(e, SAT, '01002_RIT')).toMatchObject({ treatment: 'erase', basisMark: 'edited' })
    expect(row(e, SAT, '01002_RIT').reasons[0]).toContain('割り当たらないため')
  })
})

describe('editGroups:割り当て', () => {
  const g = proposeGroups(kyotoLike())

  it('割り当てを外すと、その平日の service の既定の扱いを計算し直す', () => {
    const e = editGroups(g, { kind: SAT, serviceId: '03001_A', into: null })
    expect(row(e, SAT, '03001_A')).toMatchObject({ into: null, intoMark: 'edited' })
    // 01001_A は regular なので「なくす」
    expect(row(e, SAT, '01001_A')).toMatchObject({ treatment: 'erase', basisMark: 'rule' })
    expect(row(e, SAT, '01001_A').reasons[0]).toContain('割り当たらないため')
  })

  it('一部の日だけの service に割り当てると入れ替え、外すと「残す」に戻る', () => {
    const a = editGroups(g, { kind: SAT, serviceId: '03001_A', into: '01002_RIT' })
    expect(row(a, SAT, '01002_RIT')).toMatchObject({ treatment: 'erase' })
    expect(row(a, SAT, '01002_RIT').reasons[0]).toContain('03001_A の便に入れ替えます')
    const b = editGroups(a, { kind: SAT, serviceId: '03001_A', into: '01001_A' })
    expect(row(b, SAT, '01002_RIT').treatment).toBe('keep')
    expect(row(b, SAT, '03001_A').intoMark).toBe('edited')
  })

  it('「残す」に直した平日の service に割り当てると、残すの直しは外れて入れ替えになる', () => {
    const kept = editGroups(g, { kind: SAT, serviceId: '01005_MSN', treatment: 'keep' })
    const e = editGroups(kept, { kind: SAT, serviceId: 'SRV_8_10600_01_A', into: '01005_MSN' })
    expect(row(e, SAT, '01005_MSN')).toMatchObject({ treatment: 'erase', basisMark: 'rule' })
  })

  it('受け付けない直しは同じ groups を返す', () => {
    expect(editGroups(g, { kind: SAT, serviceId: 'NONE', into: null })).toBe(g)
    expect(editGroups(g, { kind: SAT, serviceId: '01001', into: '01001_A' })).toBe(g)
    expect(editGroups(g, { kind: SAT, serviceId: '03001', into: '03001_A' })).toBe(g)
    expect(editGroups(g, { kind: SAT, serviceId: '03001', treatment: 'keep' })).toBe(g)
    expect(editGroups(g, { kind: SAT, serviceId: '03001', acceptConflict: true })).toBe(g)
  })
})

describe('食い違いを受け入れる・案に戻す・確定', () => {
  const merged = mergeJevAnswers(proposeGroups(kyotoLike()), JEV)

  it('acceptConflict で今の値のまま edited にし、合わせ直しても変わらない', () => {
    expect(row(merged, SAT, '03001_C').intoMark).toBe('conflict')
    const e = editGroups(merged, { kind: SAT, serviceId: '03001_C', acceptConflict: true })
    expect(row(e, SAT, '03001_C')).toMatchObject({ into: '01001_C', intoMark: 'edited' })
    expect(row(mergeJevAnswers(e, JEV), SAT, '03001_C').intoMark).toBe('edited')
  })

  it('resetToProposal で直しを捨て、規則と Jev の案に戻す(すべての方針の種類で)', () => {
    let e = editGroups(merged, { kind: SAT, serviceId: '03001_C', into: null })
    e = editGroups(e, { kind: SUN, serviceId: '01005_MSN', treatment: 'keep' })
    e = editGroups(e, { kind: SAT, serviceId: '01005_MSN', treatment: 'keep' })
    const r = resetToProposal(e, '01005_MSN')
    expect(row(r, SAT, '01005_MSN')).toMatchObject({ treatment: 'erase', basisMark: 'agreed' })
    expect(row(r, SUN, '01005_MSN')).toMatchObject({ treatment: 'erase', basisMark: 'agreed' })
    expect(row(r, SAT, '03001_C').intoMark).toBe('edited')
    expect(row(resetToProposal(r, '03001_C'), SAT, '03001_C')).toMatchObject({ into: '01001_C', intoMark: 'conflict' })
  })

  it('決まらない行があると確定できない。食い違いは確定を止めない', () => {
    expect(canConfirm(merged)).toBe(true)
    const f = featuresOf([svc('01001', { weekday: 98 }), svc('05001_A', { weekday: 97 }), svc('06001_A', { weekday: 97 }), svc('03001_A', { saturday: 19 })])
    const p = proposeGroups(f)
    expect(canConfirm(p)).toBe(false)
    const e = editGroups(p, { kind: SAT, serviceId: '03001_A', into: '05001_A' })
    expect(canConfirm(e)).toBe(true)
    expect(codes(e, SAT)).not.toContain('undecidedReplacement')
  })
})
