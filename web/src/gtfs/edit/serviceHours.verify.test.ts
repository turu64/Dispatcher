// 営業運行時間の総量(serviceHours)の、実データでの確かめ。
// 道北バスの 9/17 版(data/raw/gtfs/dohoku_bus_減便前.zip)と 10/29 版(dohoku_bus_減便後.zip)があるときだけ走る
// (ZIP はコミットしない)。日付は平日 2026-11-04(水)、土曜 2026-11-07(土)。どちらの版の運行期間にも入る。
// 期待値は計画(docs/tasks-1105.md の D01)の試算:9/17版 平日 447 便 400.7h(06:10〜22:37)、土曜 361 便 337.2h、
// 10/29版 平日 381 便 351.8h(±0.1h)。
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { describeServiceDay } from '@/lib/serviceDay'
import { loadGtfsZip, type GtfsFeed } from '../load'
import { compareServiceHours, serviceHours, tripLegs } from './serviceHours'

const BEFORE_ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const AFTER_ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url))
const WEEKDAY = '20261104'
const SATURDAY = '20261107'

const hours = (minutes: number) => minutes / 60
const load = async (path: string) => loadGtfsZip(new Uint8Array(readFileSync(path)).buffer)
const onDate = (feed: GtfsFeed, date: string) => serviceHours(feed, describeServiceDay(feed, date).serviceIds)

describe.skipIf(!existsSync(BEFORE_ZIP))('serviceHours(道北バスの 9/17 版)', () => {
  let base: GtfsFeed
  beforeAll(async () => {
    base = await load(BEFORE_ZIP)
  })

  it('平日は 447 便・400.7 時間(06:10〜22:37)', () => {
    const h = onDate(base, WEEKDAY)
    expect(h.trips).toBe(447)
    expect(Math.abs(hours(h.serviceMinutes) - 400.7)).toBeLessThanOrEqual(0.1)
    expect(h.unknownDuration).toBe(0)
    expect(h.firstDeparture).toBe('06:10')
    expect(h.lastArrival).toBe('22:37')
  })

  it('土曜は 361 便・337.2 時間', () => {
    const h = onDate(base, SATURDAY)
    expect(h.trips).toBe(361)
    expect(Math.abs(hours(h.serviceMinutes) - 337.2)).toBeLessThanOrEqual(0.1)
  })

  it('平日の便の区間は便の数と同じで、出発の順に並ぶ', () => {
    const { legs, unknownTrips } = tripLegs(base, describeServiceDay(base, WEEKDAY).serviceIds)
    expect(legs.length + unknownTrips).toBe(447)
    expect(legs.every((l, i) => i === 0 || legs[i - 1].dep <= l.dep)).toBe(true)
    expect(legs.every((l) => l.firstStopId !== '' && l.lastStopId !== '' && l.arr >= l.dep)).toBe(true)
  })
})

describe.skipIf(!existsSync(BEFORE_ZIP) || !existsSync(AFTER_ZIP))('serviceHours(道北バスの 10/29 版と前後の比較)', () => {
  let base: GtfsFeed
  let edited: GtfsFeed
  beforeAll(async () => {
    base = await load(BEFORE_ZIP)
    edited = await load(AFTER_ZIP)
  })

  it('10/29 版の平日は 381 便・351.8 時間', () => {
    const h = onDate(edited, WEEKDAY)
    expect(h.trips).toBe(381)
    expect(Math.abs(hours(h.serviceMinutes) - 351.8)).toBeLessThanOrEqual(0.1)
  })

  it('9/17 版から 10/29 版への平日の削減量は 66 便・約 48.9 時間(約 12%)', () => {
    const c = compareServiceHours(onDate(base, WEEKDAY), onDate(edited, WEEKDAY))
    expect(c.reduction.trips).toBe(66)
    expect(c.reduction.serviceMinutes).toBe(c.before.serviceMinutes - c.after.serviceMinutes)
    expect(Math.abs(hours(c.reduction.serviceMinutes) - 48.9)).toBeLessThanOrEqual(0.2)
    expect(c.reduction.ratio).toBeCloseTo(c.reduction.serviceMinutes / c.before.serviceMinutes, 10)
    expect(c.reduction.ratio!).toBeGreaterThan(0.11)
    expect(c.reduction.ratio!).toBeLessThan(0.13)
  })
})
