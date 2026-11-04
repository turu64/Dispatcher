import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { featuresOf, kyotoLike, svc } from './groups.fixture'
import { buildJevRequest, JEV_LIMITS } from './jevRequest'
import { proposeGroups } from './rules'
import type { FeedFeatures, JevJudgeRequest } from './types'

function build(features: FeedFeatures) {
  return buildJevRequest(features, proposeGroups(features))
}

function bytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length
}

function expectConsistent(req: JevJudgeRequest) {
  const ids = new Set(req.services.map((s) => s.serviceId))
  for (const t of req.targets) {
    expect(ids.has(t.serviceId)).toBe(true)
    for (const c of t.candidates) expect(ids.has(c.serviceId)).toBe(true)
  }
  const keys = req.targets.map((t) => `${t.serviceId}/${t.role}`)
  expect(new Set(keys).size).toBe(keys.length)
  expect(req.services.length).toBeLessThanOrEqual(JEV_LIMITS.services)
  expect(req.targets.length).toBeLessThanOrEqual(JEV_LIMITS.targets)
  expect(bytes(req)).toBeLessThanOrEqual(256 * 1024)
}

describe('buildJevRequest', () => {
  it('単純な GTFS では null', () => {
    expect(build(featuresOf([svc('01', { weekday: 100 }), svc('03', { saturday: 20 }), svc('06', { sundayHoliday: 25 })]))).toBeNull()
  })

  it('平日だけの側を weekday で1回、割り当てのある入れ替えに使う service を方針の種類ごとに問う(使わない service は問わない)', () => {
    const r = build(kyotoLike())!
    expect(r.omitted).toEqual([])
    expectConsistent(r.request)
    const keys = r.request.targets.map((t) => `${t.serviceId}/${t.role}`).sort()
    expect(keys).toEqual(
      [
        '01001/weekday',
        '01001_A/weekday',
        '01001_C/weekday',
        '01002_RIT/weekday',
        '01005_MSN/weekday',
        '02001/sundayHoliday',
        '02001_A/sundayHoliday',
        '03001/saturday',
        '03001_A/saturday',
        '03001_C/saturday',
      ].sort(),
    )
    expect(r.request.targets.find((t) => t.role === 'weekday')!.candidates).toEqual([])
    // 候補:接尾辞の合うもの → 主の平日の service → 重なりの大きい順(5 つまで)
    const c = r.request.targets.find((t) => t.serviceId === '03001_A')!.candidates
    expect(c.map((x) => x.serviceId)).toEqual(['01001_A', '01001', '01001_C', '01005_MSN', '01002_RIT'])
    expect(c[0].routeOverlap).toBe(1)
    expect(r.request.feed).toEqual({
      agency: 'テストバス',
      period: { start: '20261001', end: '20270228' },
      daysInPeriod: { weekday: 100, saturday: 20, sundayHoliday: 25 },
    })
  })

  it('判断材料を送る形にする(網羅率は小数2桁、系統 20・行き先 5・文字列 100 字まで)', () => {
    const longName = 'あ'.repeat(150)
    const f = featuresOf(
      [
        svc('W', { weekday: 66 }, { routes: Array.from({ length: 30 }, (_, i) => `R${i}`), headsigns: ['a', 'b', 'c', 'd', 'e'] }),
        svc('W2', { weekday: 98 }),
      ],
      'い'.repeat(250),
    )
    f.services[0].routes[0].name = longName
    f.services[0].headsigns[0] = longName
    const r = build(f)!
    const w = r.request.services.find((s) => s.serviceId === 'W')!
    expect(w.coverage).toEqual({ weekday: 0.66, saturday: 0, sundayHoliday: 0 })
    expect(w.routes).toHaveLength(20)
    expect([...w.routes[0].name]).toHaveLength(100)
    expect([...w.headsigns[0]]).toHaveLength(100)
    expect([...r.request.feed.agency!]).toHaveLength(200)
    expect(Object.keys(w)).not.toContain('routeIds')
  })

  it('target が 40 を超えたら、境目に近いもの → 便の多い順で選び、残りを omitted に入れる', () => {
    const services = Array.from({ length: 45 }, (_, i) => svc(`W${String(i).padStart(2, '0')}`, { weekday: 98 }, { trips: 100 + i }))
    // 便は少ないが境目に近い
    services.push(svc('NEAR', { weekday: 66 }, { trips: 1 }))
    const r = build(featuresOf(services))!
    expectConsistent(r.request)
    expect(r.request.targets).toHaveLength(40)
    expect(r.request.targets[0].serviceId).toBe('NEAR')
    expect(r.omitted).toEqual(['W00', 'W01', 'W02', 'W03', 'W04', 'W05'])
  })

  it('service が 60 を超えないよう、候補の多い target を省く', () => {
    const services = [
      ...Array.from({ length: 30 }, (_, i) => svc(`W${String(i).padStart(2, '0')}_X${i}`, { weekday: 98 }, { trips: 1000 - i })),
      ...Array.from({ length: 30 }, (_, i) => svc(`V${String(i).padStart(2, '0')}_Y${i}`, { weekday: 98 }, { trips: 10 })),
      ...Array.from({ length: 30 }, (_, i) => svc(`S${String(i).padStart(2, '0')}_Y${i}`, { saturday: 19 }, { trips: 500 })),
    ]
    const r = build(featuresOf(services))!
    expectConsistent(r.request)
    expect(r.omitted.length).toBeGreaterThan(0)
  })

  it('本文が上限を超えるときは、後ろの target から省く', () => {
    const name = (i: number) => `${'系'.repeat(95)}${String(i).padStart(5, '0')}`
    const services = Array.from({ length: 50 }, (_, i) =>
      svc(`W${String(i).padStart(2, '0')}`, { weekday: 98 }, { trips: 100 - i, routes: Array.from({ length: 20 }, (_, j) => `R${i}_${j}`) }),
    )
    for (const s of services) s.routes = s.routes.map((r, j) => ({ ...r, name: name(j) }))
    const r = build(featuresOf(services))!
    expectConsistent(r.request)
    expect(bytes(r.request)).toBeLessThanOrEqual(JEV_LIMITS.bodyBytes)
    expect(r.request.targets.length).toBeLessThan(40)
    expect(r.omitted.length).toBe(50 - r.request.targets.length)
  })

  it('service_id が 100 字を超える service は問わない', () => {
    const long = `W_${'x'.repeat(120)}`
    const r = build(featuresOf([svc('W', { weekday: 98 }), svc(long, { weekday: 50 })]))!
    expect(r.request.targets.map((t) => t.serviceId)).toEqual(['W'])
    expect(r.omitted).toEqual([long])
  })
})

// B の固定のデータ(server/tests/fixtures/jev_judge_request.json)と、項目の名前が段ごとに同じか。
// B より先に入ったときは、ファイルが無ければスキップする
const FIXTURE = fileURLToPath(new URL('../../../../server/tests/fixtures/jev_judge_request.json', import.meta.url))

describe.skipIf(!existsSync(FIXTURE))('B の固定のデータとの照合', () => {
  const keys = (v: unknown) => Object.keys(v as object).sort()

  it('項目の名前が段ごとに同じ', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as JevJudgeRequest
    const ours = build(kyotoLike())!.request
    expect(keys(ours)).toEqual(keys(fixture))
    expect(keys(ours.feed)).toEqual(keys(fixture.feed))
    expect(keys(ours.feed.period)).toEqual(keys(fixture.feed.period))
    expect(keys(ours.feed.daysInPeriod)).toEqual(keys(fixture.feed.daysInPeriod))
    const s = ours.services[0]
    const fs = fixture.services[0]
    expect(keys(s)).toEqual(keys(fs))
    expect(keys(s.runningDays)).toEqual(keys(fs.runningDays))
    expect(keys(s.coverage)).toEqual(keys(fs.coverage))
    expect(keys(s.routes[0])).toEqual(keys(fs.routes[0]))
    const rt = ours.targets.find((t) => t.role !== 'weekday')!
    const frt = fixture.targets.find((t) => t.role !== 'weekday')!
    expect(keys(rt)).toEqual(keys(frt))
    expect(keys(rt.candidates[0])).toEqual(keys(frt.candidates[0]))
    expect(fixture.targets.map((t) => t.role).every((r) => ['weekday', 'saturday', 'sundayHoliday'].includes(r))).toBe(true)
  })
})
