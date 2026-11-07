// 往復の確かめ(roundTripCheck。指摘 18.2、docs/tasks-1105.md の A04)の、実データでの確かめ。
// 道北バスの 9/17 版(data/raw/gtfs/dohoku_bus_減便前.zip)と、平日を土曜ダイヤにするだけの方針
// (data/tools/policies/replaceOnly.json。外す系統も平日に戻す便も無い)があるときだけ走る(ZIP はコミットしない)。
// 減便後は applyForm2 で作り、比較する日付は 2026-11-04(水)。系統の分け方と問題の数を出力する。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadGtfsZip, type GtfsFeed } from '../load'
import { applyForm2 } from './form2'
import type { Form2Plan } from './ops'
import { ROUND_TRIP_PROBLEM_KINDS, roundTripCheck, type RoundTripResult } from './roundTrip'

const ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const POLICY = fileURLToPath(new URL('../../../../data/tools/policies/replaceOnly.json', import.meta.url))
const ready = existsSync(ZIP) && existsSync(POLICY)
const DATE = '20261104'

/**
 * 9/17 版の ZIP と replaceOnly.json の SHA-256。系統の分け方は減便前だけで決まるので ZIP だけ、問題の数は方針も同じときだけ照合する
 * (問題の数は applyForm2 の出力にもよる。form2.ts を変えて数が動いたら、下の固定値を直す)
 */
const ZIP_SHA = 'd81998880e2141d0f405c65fd2b2e5e2c9516842b94d61dd59f1cc54cf451abb'
const POLICY_SHA = '69f5af8e9a6cea89d8f38184ee2bbd324245fded220fea15b75b6aedcb0d4422'
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const pinnedZip = ready && sha(ZIP) === ZIP_SHA
const pinnedInputs = pinnedZip && sha(POLICY) === POLICY_SHA

describe.skipIf(!ready)('roundTripCheck(道北バスの 9/17 版、平日を土曜ダイヤに、2026-11-04)', () => {
  let base: GtfsFeed
  let edited: GtfsFeed
  let weekdays: Set<string>
  let result: RoundTripResult
  let elapsedMs = 0

  beforeAll(async () => {
    base = await loadGtfsZip(new Uint8Array(readFileSync(ZIP)).buffer)
    const policy = JSON.parse(readFileSync(POLICY, 'utf8')) as Omit<Form2Plan, 'kind'>
    const outcome = applyForm2(base, { kind: 'weekdayToSaturday', ...policy }, { generatedAt: '202611051200' })
    if (!outcome.ok) throw new Error(outcome.message)
    edited = outcome.result.feed
    weekdays = new Set([policy.weekdayService ?? '01'])
    const t0 = performance.now()
    result = roundTripCheck(base, edited, DATE, { weekdayServices: weekdays })
    elapsedMs = performance.now() - t0
  })

  it('系統の分け方と問題の数を出す', () => {
    const top = result.problems.slice(0, 10).map((p) => ({
      kind: p.kind,
      route: p.routeName,
      from: p.fromName,
      to: p.toName,
      before: `${p.before.trips}便 ${p.before.first}〜${p.before.last}`,
      after: `${p.after.trips}便 ${p.after.first}〜${p.after.last}`,
      shiftMin: p.shiftMin,
      returnTrips: p.returnTrips,
    }))
    console.log(
      '往復の確かめ',
      JSON.stringify({ routes: result.routes, directions: result.directions.length, counts: result.counts, elapsedMs: Math.round(elapsedMs) }),
    )
    console.log('問題の先頭 10 件', JSON.stringify(top, null, 1))

    expect(result.emptyReason).toBeNull()
    expect(result.directions.length).toBeGreaterThan(0)
    for (const kind of ROUND_TRIP_PROBLEM_KINDS) expect(result.counts[kind]).toBe(result.problems.filter((p) => p.kind === kind).length)
    // 平日を土曜ダイヤにすると、平日だけの便がなくなるので、何かしらの問題が出る
    expect(result.problems.length).toBeGreaterThan(0)
  })

  it.skipIf(!pinnedZip)('逆向きのある系統 49(同じ系統 42、ほかの系統 7)、noReverse 16', () => {
    expect(result.routes).toMatchObject({ withReverse: 49, sameRoute: 42, otherRoute: 7, noReverse: 16 })
  })

  it.skipIf(!pinnedInputs)('問題の数が 11/5 に数えた値と同じ', () => {
    // 11/5 にこの実装で数えた問題の数(回帰の確かめ)。afterOnly 1 は、土曜にだけ走る系統が平日に入ったもの
    expect(result.routes.afterOnly).toBe(1)
    expect(result.directions).toHaveLength(85)
    expect(result.counts).toEqual({ directionVanishes: 18, noReturn: 1, lastEarlier: 13, firstLater: 12 })
  })

  it('系統の分け方は減便前だけで決まる(減便前どうしを比べても同じ数で、問題は出ない)', () => {
    const same = roundTripCheck(base, base, DATE, { weekdayServices: weekdays })
    expect(same.routes).toEqual({ ...result.routes, afterOnly: 0 })
    expect(same.problems).toEqual([])
  })

  it('問題の行の数は方向の一覧と合う', () => {
    for (const p of result.problems) {
      const dir = result.directions.find((d) => d.routeId === p.routeId && d.fromName === p.fromName && d.toName === p.toName)
      expect(dir).toBeDefined()
      expect(dir!.before).toEqual(p.before)
      expect(dir!.after).toEqual(p.after)
      if (p.kind === 'directionVanishes') expect(p.after.trips).toBe(0)
      if (p.kind === 'noReturn') {
        expect(p.after.morning).toBeGreaterThan(0)
        expect(p.returnTrips!.eveningBefore).toBeGreaterThan(0)
        expect(p.returnTrips!.eveningAfter).toBe(0)
      }
      if (p.kind === 'lastEarlier' || p.kind === 'firstLater') expect(p.shiftMin!).toBeGreaterThanOrEqual(30)
    }
  })

  it('土曜(2026-11-07)は平日ダイヤが走らないので、理由つきの空の結果', () => {
    const sat = roundTripCheck(base, edited, '20261107', { weekdayServices: weekdays })
    expect(sat.emptyReason?.code).toBe('noWeekdayService')
    expect(sat.directions).toEqual([])
    expect(sat.problems).toEqual([])
  })
})
