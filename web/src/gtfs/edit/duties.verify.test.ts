// 勤務の数の下限の目安(estimateDuties)と入力の運用番号の数(operatorRunsOf)の、実データでの確かめ。
// 道北バスの 9/17 版(data/raw/gtfs/dohoku_bus_減便前.zip)と 10/29 版(dohoku_bus_減便後.zip)があるときだけ走る
// (ZIP はコミットしない)。日付は平日 2026-11-04(水。service 01)、土曜 2026-11-07(土。service 03)。
// 期待の幅は計画(docs/tasks-1105.md の D02):9/17版 平日 75〜90、土曜 50〜65、10/29版 平日 60〜75、
// 平日→土曜の差 18〜32(試算は 82・57・68)。運用番号の数は 101・72・86。
// 既定の仮定(営業所・休憩施設なし、拘束 13 時間)で、絶対数は仮定で ±20% 動く(§6 の3)。
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { describeServiceDay } from '@/lib/serviceDay'
import { loadGtfsZip, type GtfsFeed } from '../load'
import { BOUND_LIMIT_MIN, DUTY_DEFAULTS, estimateDuties, operatorRunsOf, stopPointsOf, type DutyEstimate } from './duties'
import { tripLegs } from './serviceHours'

const BEFORE_ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const AFTER_ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url))
const WEEKDAY = '20261104'
const SATURDAY = '20261107'

const load = async (path: string) => loadGtfsZip(new Uint8Array(readFileSync(path)).buffer)
const estimateOn = (feed: GtfsFeed, date: string, params = {}): DutyEstimate =>
  estimateDuties(tripLegs(feed, describeServiceDay(feed, date).serviceIds).legs, stopPointsOf(feed), params)

describe.skipIf(!existsSync(BEFORE_ZIP) || !existsSync(AFTER_ZIP))('estimateDuties(道北バス)', () => {
  let base: GtfsFeed
  let edited: GtfsFeed
  let weekday: DutyEstimate
  let saturday: DutyEstimate
  let after: DutyEstimate
  beforeAll(async () => {
    base = await load(BEFORE_ZIP)
    edited = await load(AFTER_ZIP)
    weekday = estimateOn(base, WEEKDAY)
    saturday = estimateOn(base, SATURDAY)
    after = estimateOn(edited, WEEKDAY)
  })

  it('9/17 版の平日は 75〜90、土曜は 50〜65、10/29 版の平日は 60〜75', () => {
    expect(weekday.dutyCount).toBeGreaterThanOrEqual(75)
    expect(weekday.dutyCount).toBeLessThanOrEqual(90)
    expect(saturday.dutyCount).toBeGreaterThanOrEqual(50)
    expect(saturday.dutyCount).toBeLessThanOrEqual(65)
    expect(after.dutyCount).toBeGreaterThanOrEqual(60)
    expect(after.dutyCount).toBeLessThanOrEqual(75)
  })

  it('平日を土曜ダイヤにすると、勤務の数は 18〜32 減る', () => {
    const diff = weekday.dutyCount - saturday.dutyCount
    expect(diff).toBeGreaterThanOrEqual(18)
    expect(diff).toBeLessThanOrEqual(32)
  })

  it('どの勤務も条件の中にあり、全便を1回ずつつなぐ', () => {
    for (const [est, trips] of [
      [weekday, 447],
      [saturday, 361],
      [after, 381],
    ] as const) {
      expect(est.overLimitDuties).toBe(0)
      expect(est.stopsWithoutPoint).toBe(0)
      const ids = est.duties.flatMap((d) => d.tripIds)
      expect(ids.length).toBe(trips)
      expect(new Set(ids).size).toBe(trips)
      for (const d of est.duties) {
        expect(d.boundMin).toBeLessThanOrEqual(DUTY_DEFAULTS.maxBoundMin)
        expect(d.drivingMin).toBeLessThanOrEqual(DUTY_DEFAULTS.maxDrivingMin)
        expect(d.maxContinuousMin).toBeLessThanOrEqual(DUTY_DEFAULTS.maxContinuousMin)
      }
      // 車両の数の下限は勤務の数を超えない。同時に営業運行中の便の最大は、つないだ車両の数を超えない
      expect(est.vehicles.chained).toBeLessThanOrEqual(est.dutyCount)
      expect(est.vehicles.maxConcurrent).toBeLessThanOrEqual(est.vehicles.chained)
    }
  })

  it('拘束を 15 時間にすると、勤務の数は増えない', () => {
    // この ZIP での確かめ(試算は 65)。貪欲につなぐので、上限を緩めて数が増えないことはどのデータでも言えるわけではない
    const extended = estimateOn(base, WEEKDAY, { maxBoundMin: BOUND_LIMIT_MIN.extended })
    expect(extended.dutyCount).toBeLessThanOrEqual(weekday.dutyCount)
  })

  it('入力の運用番号の数は 9/17 版の平日 101・土曜 72、10/29 版の平日 86', () => {
    expect(operatorRunsOf(base, '01')).toBe(101)
    expect(operatorRunsOf(base, '03')).toBe(72)
    expect(operatorRunsOf(edited, '01')).toBe(86)
  })
})
