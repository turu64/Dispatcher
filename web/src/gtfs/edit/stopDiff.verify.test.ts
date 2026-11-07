// 停留所ごとの前後の発車(stopDiff)と系統 × 方向の並び(routeDirectionTimeline)の、実データでの確かめ。
// 道北バスの 9/17 版(data/raw/gtfs/dohoku_bus_減便前.zip)と形2の方針(data/tools/policies/main.json)があるときだけ走る
// (ZIP はコミットしない。方針はリポジトリにある)。
// 編集後は applyForm2 で作り、比較の日付は 2026-11-04(水)。件数を出力し、到達圏の出発の数(departureCountsByBand)と
// 停留所ごとの本数が一致することを確かめる。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { activeServiceIds } from '../calendar'
import { departureCountsByBand } from '../departures'
import { loadGtfsZip, type GtfsFeed } from '../load'
import { applyForm2 } from './form2'
import type { Form2Plan } from './ops'
import { createRouteDirectionTimeline, stopDiff, type StopDiffResult } from './stopDiff'

const ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const POLICY = fileURLToPath(new URL('../../../../data/tools/policies/main.json', import.meta.url))
const ready = existsSync(ZIP) && existsSync(POLICY)
const DATE = '20261104'

/**
 * 11/3 に、この実装で数えた件数(回帰の確かめ)。ZIP と方針が同じときだけ照合する。
 * 編集後の stop_times に無い停留所 90 は、取り決め 1104 §13 の「main で 90 停留所が stop_times から消え」と一致する。
 * 停留所 1,450 は、到達圏の起点の数(restore.verify.test.ts の Python の手順 1)と一致する
 */
const PINNED_INPUTS = {
  zipSha: 'd81998880e2141d0f405c65fd2b2e5e2c9516842b94d61dd59f1cc54cf451abb',
  policySha: '83c39e850385b516a81f63b71444c966677ee0c34e0a86e021e96408811536c1',
}
const PINNED = {
  stops: 1450,
  repostCount: 690,
  stopsWithAdded: 526,
  stopsWithRemoved: 682,
  stopsLosingAll: 91,
  vanished: 90,
  departuresBefore: 16819,
  departuresAfter: 15047,
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const pinnedInputs = ready && sha(ZIP) === PINNED_INPUTS.zipSha && sha(POLICY) === PINNED_INPUTS.policySha

describe.skipIf(!ready)('stopDiff(道北バスの 9/17 版、main の方針、2026-11-04)', () => {
  let base: GtfsFeed
  let edited: GtfsFeed
  let result: StopDiffResult
  let elapsedMs = 0

  beforeAll(async () => {
    base = await loadGtfsZip(new Uint8Array(readFileSync(ZIP)).buffer)
    const policy = JSON.parse(readFileSync(POLICY, 'utf8')) as Omit<Form2Plan, 'kind'>
    const outcome = applyForm2(base, { kind: 'weekdayToSaturday', ...policy }, { generatedAt: '202611041200' })
    if (!outcome.ok) throw new Error(outcome.message)
    edited = outcome.result.feed
    const t0 = performance.now()
    result = stopDiff(base, edited, DATE)
    elapsedMs = performance.now() - t0
  })

  it('件数を出す', () => {
    const sum = (f: (s: StopDiffResult['stops'][number]) => number) => result.stops.reduce((n, s) => n + f(s), 0)
    const summary = {
      stops: result.stops.length,
      repostCount: result.repostCount,
      stopsWithAdded: result.stopsWithAdded,
      stopsWithRemoved: result.stopsWithRemoved,
      stopsLosingAll: result.stopsLosingAll,
      departuresBefore: sum((s) => s.before.count),
      departuresAfter: sum((s) => s.after.count),
      added: sum((s) => s.added.length),
      removed: sum((s) => s.removed.length),
      skippedBlankTime: result.skippedBlankTime,
      skippedInvalidTime: result.skippedInvalidTime,
      elapsedMs: Math.round(elapsedMs),
    }
    console.log('stopDiff の件数', JSON.stringify(summary))

    expect(result.stops.length).toBeGreaterThan(0)
    expect(result.repostCount).toBeGreaterThan(0)
    expect(result.repostCount).toBeLessThanOrEqual(result.stops.length)
    expect(result.repostCount).toBe(result.stops.filter((s) => s.added.length + s.removed.length > 0).length)
    // 前の本数 − 無くなる + 新しく生じる = 後の本数
    for (const s of result.stops) expect(s.before.count - s.removed.length + s.added.length).toBe(s.after.count)
    // 減便なので、全体の本数は減る
    expect(summary.departuresAfter).toBeLessThan(summary.departuresBefore)
  })

  it('編集後に stop_times から消えた停留所も、基準の側から数える', () => {
    const editedStops = new Set((edited.tables.get('stop_times')?.rows ?? []).map((r) => (r.stop_id ?? '').trim()))
    const vanished = result.stops.filter((s) => !editedStops.has(s.stopId))
    console.log('編集後の stop_times に無い停留所(その日に発車があったもの)', vanished.length)
    for (const s of vanished) {
      expect(s.before.count).toBeGreaterThan(0)
      expect(s.after.count).toBe(0)
      expect(s.removed.length).toBe(s.before.count)
      expect(s.needsRepost).toBe(true)
    }
    expect(result.stopsLosingAll).toBeGreaterThanOrEqual(vanished.length)
  })

  it.skipIf(!pinnedInputs)('件数が 11/3 に数えた値と同じ', () => {
    const editedStops = new Set((edited.tables.get('stop_times')?.rows ?? []).map((r) => (r.stop_id ?? '').trim()))
    expect({
      stops: result.stops.length,
      repostCount: result.repostCount,
      stopsWithAdded: result.stopsWithAdded,
      stopsWithRemoved: result.stopsWithRemoved,
      stopsLosingAll: result.stopsLosingAll,
      vanished: result.stops.filter((s) => !editedStops.has(s.stopId)).length,
      departuresBefore: result.stops.reduce((n, s) => n + s.before.count, 0),
      departuresAfter: result.stops.reduce((n, s) => n + s.after.count, 0),
    }).toEqual(PINNED)
  })

  it('停留所ごとの本数は、到達圏の出発の数(当日の便、0〜48時の1つの時間帯)と一致する', () => {
    const band = [{ startHour: 0, endHour: 48, label: '終日' }]
    for (const [feed, side] of [
      [base, 'before'],
      [edited, 'after'],
    ] as const) {
      const counted = departureCountsByBand(feed, { today: activeServiceIds(feed, DATE), yesterday: new Set() }, band)
      const fromDiff = new Map(result.stops.filter((s) => s[side].count > 0).map((s) => [s.stopId, s[side].count]))
      expect(fromDiff).toEqual(new Map([...counted.counts].map(([id, [n]]) => [id, n])))
      expect(counted.skippedBlankTime).toBe(side === 'before' ? result.skippedBlankTime.base : result.skippedBlankTime.edited)
    }
  })

  it('最大間隔は始発から最終便までの間に収まる', () => {
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
    for (const s of result.stops) {
      for (const side of [s.before, s.after]) {
        if (side.count < 2) {
          expect(side.maxGapMin).toBeNull()
          continue
        }
        expect(side.maxGapMin).not.toBeNull()
        expect(side.maxGapMin!).toBeLessThanOrEqual(minutes(side.last!) - minutes(side.first!) + 1)
      }
    }
  })

  it('系統 × 方向の並びが、その日に走る便をすべて並べる', () => {
    const t0 = performance.now()
    const timeline = createRouteDirectionTimeline(edited, DATE)
    const services = activeServiceIds(edited, DATE)
    const trips = (edited.tables.get('trips')?.rows ?? []).filter((t) => services.has((t.service_id ?? '').trim()))
    const routeIds = [...new Set(trips.map((t) => (t.route_id ?? '').trim()))]
    let placed = 0
    let directions = 0
    let widest = { routeId: '', from: '', to: '', maxGapMin: 0 }
    for (const routeId of routeIds) {
      for (const dir of timeline(routeId)) {
        directions++
        placed += dir.trips.length
        if ((dir.maxGapMin ?? 0) > widest.maxGapMin) {
          widest = { routeId, from: dir.firstStopName, to: dir.lastStopName, maxGapMin: dir.maxGapMin ?? 0 }
        }
        const secs = dir.trips.map((t) => t.seconds).filter((v): v is number => v !== null)
        expect(secs).toEqual([...secs].sort((a, b) => a - b))
      }
    }
    console.log(
      '系統 × 方向の並び',
      JSON.stringify({ routes: routeIds.length, directions, trips: placed, widest, elapsedMs: Math.round(performance.now() - t0) }),
    )
    expect(placed).toBe(trips.length)
    expect(directions).toBeGreaterThanOrEqual(routeIds.length)
  })
})
