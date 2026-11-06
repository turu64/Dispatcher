// 勤務の数の下限の目安(estimateDuties)と入力の運用番号の数(operatorRunsOf)の、実データでの確かめ。
// 道北バスの 9/17 版(data/raw/gtfs/dohoku_bus_減便前.zip)と 10/29 版(dohoku_bus_減便後.zip)があるときだけ走る
// (ZIP はコミットしない)。日付は平日 2026-11-04(水。service 01)、土曜 2026-11-07(土。service 03)。
// 期待の幅は計画(docs/tasks-1105.md の D02):9/17版 平日 75〜90、土曜 50〜65、10/29版 平日 60〜75、
// 平日→土曜の差 18〜32(試算は回送 20km/h で 82・57・68。11/6 に回送の既定を 30km/h にして 79・55・67)。運用番号の数は 101・72・86。
// 既定の仮定(営業所なし、拘束 13 時間、回送 30km/h)で、絶対数は仮定で ±20% 動く(§6 の3)。
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
    // 2026-11-06 に測った値(回送 30km/h)。回送 20km/h では 82・57・68 で、場所の種類を営業所1つにまとめても変わらない
    console.info(`[道北バス・営業所なし] 9/17 版の平日 ${weekday.dutyCount}・土曜 ${saturday.dutyCount}、10/29 版の平日 ${after.dutyCount}`)
    expect([weekday.dutyCount, saturday.dutyCount, after.dutyCount]).toEqual([79, 55, 67])
    const at20 = [estimateOn(base, WEEKDAY, { deadheadKmh: 20 }), estimateOn(base, SATURDAY, { deadheadKmh: 20 }), estimateOn(edited, WEEKDAY, { deadheadKmh: 20 })]
    expect(at20.map((e) => e.dutyCount)).toEqual([82, 57, 68])
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
    // この ZIP での確かめ。貪欲につなぐので、上限を緩めて数が増えないことはどのデータでも言えるわけではない
    const extended = estimateOn(base, WEEKDAY, { maxBoundMin: BOUND_LIMIT_MIN.extended })
    expect(extended.dutyCount).toBeLessThanOrEqual(weekday.dutyCount)
  })

  it('入力の運用番号の数は 9/17 版の平日 101・土曜 72、10/29 版の平日 86', () => {
    expect(operatorRunsOf(base, '01')).toBe(101)
    expect(operatorRunsOf(base, '03')).toBe(72)
    expect(operatorRunsOf(edited, '01')).toBe(86)
  })
})

// 道北バスのサンプルの営業所(lib/samplePlaces.ts。2026-11-06 に利用者が入力した5か所)を置いたときの数。
// 2026-11-06 に測った値(既定の仮定。回送 30km/h):平日 117(回送が片道 60 分を超える勤務 11・上限を超える勤務 4)、土曜 100、差 17。
// どの勤務も最初と最後の停留所から最寄りの営業所へ回送するとみなすので、営業所から遠い終点の便は回送が長くなり、勤務の数が増える。
// 回送 20km/h では平日 140(回送が長い 32・上限超え 32)・土曜 118、40km/h で平日 115(上限超え 4)・土曜 91。
// 11/6 に種類を営業所1つにまとめた後も、回送 20km/h で前と同じ数(平日 140・土曜 118。前の版は種類「営業所・車庫・休憩施設」で置いた)になることを確かめる
describe.skipIf(!existsSync(BEFORE_ZIP))('estimateDuties(道北バス、サンプルの営業所を置いたとき)', () => {
  it('平日を土曜ダイヤにすると勤務の数が減り、置かないときより勤務の数は多い', async () => {
    const { DOHOKU_SAMPLE_PLACES } = await import('@/lib/samplePlaces')
    const base = await load(BEFORE_ZIP)
    const places = DOHOKU_SAMPLE_PLACES.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }))
    const on = (date: string, withPlaces: boolean, params = {}) =>
      estimateDuties(tripLegs(base, describeServiceDay(base, date).serviceIds).legs, stopPointsOf(base), params, withPlaces ? places : [])
    const weekday = on(WEEKDAY, true)
    const saturday = on(SATURDAY, true)
    console.info(
      `[道北バス・サンプルの営業所あり] 平日 ${weekday.dutyCount}(回送が長い ${weekday.longDeadheadDuties}・上限超え ${weekday.overLimitDuties})、` +
        `土曜 ${saturday.dutyCount}、差 ${weekday.dutyCount - saturday.dutyCount}`,
    )
    expect([weekday.dutyCount, weekday.longDeadheadDuties, weekday.overLimitDuties]).toEqual([117, 11, 4])
    expect(saturday.dutyCount).toBe(100)
    expect([on(WEEKDAY, true, { deadheadKmh: 20 }).dutyCount, on(SATURDAY, true, { deadheadKmh: 20 }).dutyCount]).toEqual([140, 118])
    expect(weekday.dutyCount).toBeGreaterThan(saturday.dutyCount)
    expect(weekday.dutyCount).toBeGreaterThan(on(WEEKDAY, false).dutyCount)
  })
})
