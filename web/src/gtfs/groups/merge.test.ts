import { describe, expect, it } from 'vitest'
import type { PolicyKind } from '../edit/ops'
import { featuresOf, kyotoLike, svc } from './groups.fixture'
import { dropJevAnswers, isConfident, JEV_CONFIDENCE, mergeJevAnswers } from './merge'
import { proposeGroups } from './rules'
import type { JevJudgeResponse, JevRole, JevTargetResult, KindRow, ServiceGroups } from './types'

// 試しの1回の答え(data/out/jev_playground/)ではなく、ここに写した固定のデータで §3.4 の表を確かめる

const SAT: PolicyKind = 'weekdayToSaturday'
const SUN: PolicyKind = 'weekdayToSundayHoliday'

function row(g: ServiceGroups, kind: PolicyKind, id: string): KindRow {
  const r = g.byKind[kind].rows.find((x) => x.serviceId === id)
  if (!r) throw new Error(`${id} の行がありません`)
  return r
}

type Answer = [choice: string, probability: number, confidence: number | null]

function result(
  serviceId: string,
  role: JevRole,
  a: { kind?: Answer; school?: number; counterpart?: Answer } = {},
): JevTargetResult {
  const choice = ([c, p, conf]: Answer) => ({ choice: c, probabilities: { [c]: p, other: Math.max(0, 1 - p) }, confidence: conf })
  return {
    serviceId,
    role,
    provider: 'typesafe-ai',
    sent: { state: { target: { service_id: serviceId } }, questions: {} },
    ...(a.kind ? { serviceKind: choice(a.kind) } : {}),
    ...(a.school !== undefined ? { schoolService: { probability: a.school } } : {}),
    ...(a.counterpart ? { weekdayCounterpart: choice(a.counterpart) } : {}),
  }
}

function response(results: JevTargetResult[]): JevJudgeResponse {
  return { model: 'typesafe-ai/jev', results, failures: [], usage: { inputTokens: 1000, costUsd: 0.0004 } }
}

describe('isConfident', () => {
  it('確信度 0.9 以上で、選んだ値の確率 0.8 以上', () => {
    const c = (p: number, conf: number | null) => ({ choice: 'x', probabilities: { x: p }, confidence: conf })
    expect(isConfident(c(0.8, 0.9))).toBe(true)
    expect(isConfident(c(0.79, 0.95))).toBe(false)
    expect(isConfident(c(0.95, 0.89))).toBe(false)
    expect(isConfident(c(0.95, null))).toBe(false)
    // 試しの1回の saturday_counterpart(確率 0.88、確信度 0.86)は低い
    expect(isConfident(c(0.88, 0.86))).toBe(false)
    expect(JEV_CONFIDENCE).toEqual({ confidence: 0.9, probability: 0.8, school: 0.7 })
  })
})

describe('mergeJevAnswers:規則で決まった割り当て(§3.4)', () => {
  const g = proposeGroups(kyotoLike())
  const merged = mergeJevAnswers(
    g,
    response([
      result('03001_A', 'saturday', { counterpart: ['01001_A', 0.95, 0.93] }),
      result('03001', 'saturday', { counterpart: ['01001', 0.95, 0.5] }),
      result('03001_C', 'saturday', { counterpart: ['01001_A', 0.88, 0.91] }),
      result('02001', 'sundayHoliday', { counterpart: ['none', 0.6, 0.95] }),
      result('02001_A', 'sundayHoliday', { counterpart: ['none', 0.85, 0.92] }),
      // 候補に無い値は答えが無いのと同じ
      result('SRV_8_10600_01_A', 'saturday', { counterpart: ['XYZ', 0.99, 0.99] }),
    ]),
  )

  it('同じ値で確信が高い → agreed', () => {
    expect(row(merged, SAT, '03001_A')).toMatchObject({ into: '01001_A', intoMark: 'agreed' })
  })
  it('同じ値で確信が低い → rule', () => {
    expect(row(merged, SAT, '03001')).toMatchObject({ into: '01001', intoMark: 'rule' })
  })
  it('違う値で確信が高い → conflict(値は規則のまま)', () => {
    const r = row(merged, SAT, '03001_C')
    expect(r).toMatchObject({ into: '01001_C', intoMark: 'conflict' })
    expect(r.reasons.join('')).toContain('食い違っています')
  })
  it('違う値で確信が低い → rule', () => {
    expect(row(merged, SUN, '02001')).toMatchObject({ into: '01001', intoMark: 'rule' })
  })
  it('「使わない」との食い違いも conflict', () => {
    expect(row(merged, SUN, '02001_A')).toMatchObject({ into: '01001_A', intoMark: 'conflict' })
  })
  it('答えが無い・候補に無い値 → rule', () => {
    expect(row(merged, SAT, 'SRV_8_10600_01_A')).toMatchObject({ into: null, intoMark: 'rule' })
    // 答えの無い平日だけの service
    expect(row(merged, SAT, '01001').basisMark).toBe('rule')
  })
  it('答えを jev に持ち、規則の案(proposal)は変えない', () => {
    expect(merged.jev).toHaveLength(6)
    expect(merged.proposal).toBe(g.proposal)
    expect(row({ ...merged, byKind: merged.proposal }, SAT, '03001_C').intoMark).toBe('rule')
  })
})

describe('mergeJevAnswers:規則で決まらない割り当て', () => {
  const features = featuresOf([
    svc('01001', { weekday: 98 }, { trips: 100 }),
    svc('05001_A', { weekday: 97 }),
    svc('06001_A', { weekday: 97 }),
    svc('03001_A', { saturday: 19 }),
  ])
  const g = proposeGroups(features)

  it('確信が高い → Jev の値で jev。割り当てた平日の service の扱いも計算し直す', () => {
    const m = mergeJevAnswers(g, response([result('03001_A', 'saturday', { counterpart: ['06001_A', 0.9, 0.95] })]))
    expect(row(m, SAT, '03001_A')).toMatchObject({ into: '06001_A', intoMark: 'jev' })
    expect(row(m, SAT, '06001_A').reasons[0]).toContain('03001_A の便に入れ替えます')
    expect(m.byKind[SAT].problems.map((p) => p.code)).not.toContain('undecidedReplacement')
  })
  it('確信が低い → 空のまま undecided', () => {
    const m = mergeJevAnswers(g, response([result('03001_A', 'saturday', { counterpart: ['06001_A', 0.9, 0.7] })]))
    expect(row(m, SAT, '03001_A')).toMatchObject({ into: null, intoMark: 'undecided' })
  })
  it('失敗(答えが無い) → undecided', () => {
    const m = mergeJevAnswers(g, { ...response([]), failures: [{ serviceId: '03001_A', role: 'saturday', error: 'timeout' }] })
    expect(row(m, SAT, '03001_A')).toMatchObject({ into: null, intoMark: 'undecided' })
  })
})

describe('mergeJevAnswers:平日だけの service の basis', () => {
  const g = proposeGroups(kyotoLike())
  const merged = mergeJevAnswers(
    g,
    response([
      result('01001', 'weekday', { kind: ['regular_weekday', 0.97, 0.96], school: 0.05 }),
      result('01002_RIT', 'weekday', { kind: ['regular_weekday', 0.9, 0.95], school: 0.83 }),
      result('01005_MSN', 'weekday', { kind: ['specific_dates', 0.6, 0.95] }),
      result('01001_A', 'weekday', { kind: ['regular_weekday', 0.9, null] }),
    ]),
  )

  it('同じ basis で確信が高い → agreed(両方の方針の種類に当てる)', () => {
    expect(row(merged, SAT, '01001').basisMark).toBe('agreed')
    expect(row(merged, SUN, '01001').basisMark).toBe('agreed')
  })
  it('違う basis で確信が高い → conflict。扱いは規則の basis で決める', () => {
    expect(row(merged, SAT, '01002_RIT')).toMatchObject({ basisMark: 'conflict', treatment: 'keep' })
  })
  it('確信が低い・確信度が無い → rule', () => {
    expect(row(merged, SAT, '01005_MSN').basisMark).toBe('rule')
    expect(row(merged, SAT, '01001_A').basisMark).toBe('rule')
  })
  it('学校の便の確率が 0.7 以上なら理由の文を足す(扱いは変えない)', () => {
    expect(row(merged, SAT, '01002_RIT').reasons.join('')).toContain('学校を指している')
    expect(row(merged, SAT, '01001').reasons.join('')).not.toContain('学校を指している')
  })
})

describe('合わせ直しと捨てること', () => {
  const g = proposeGroups(kyotoLike())
  const res = response([result('03001_C', 'saturday', { counterpart: ['01001_A', 0.88, 0.91] })])

  it('同じ答えを何回合わせても同じ', () => {
    const once = mergeJevAnswers(g, res)
    expect(mergeJevAnswers(once, res)).toEqual(once)
  })
  it('dropJevAnswers で規則の案に戻る', () => {
    const dropped = dropJevAnswers(mergeJevAnswers(g, res))
    expect(dropped.jev).toBeNull()
    expect(dropped.byKind).toEqual(g.byKind)
  })
})
