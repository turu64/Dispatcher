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
// 2026-11-06 につなぎ方を作り直した(どの停留所のすき間も休憩に数え、営業所から遠い停留所で 90 分より長く待つすき間は営業所へ
// 往復して休む。営業所から遠い終点へ行く便は、終点で休んでから入庫するか、営業所の近くへ戻る便をつなぐ)。
// 作り直した後に測った値(既定の仮定。回送 30km/h):9/17 版の平日 82・土曜 60、10/29 版の平日 71(平均の拘束 536・569・544 分、
// 6時間未満の勤務 27・16・21、回送が片道 60 分を超える勤務 9・10・8、上限を超える勤務 0)。運用番号の数 101・72・86 の
// 0.81・0.83・0.83 倍(営業所なしは 0.78・0.76・0.78 倍)。
// 作り直す前は 117・100・104(平均の拘束 約 360 分、6時間未満 83・74・72、上限超え 4・4・4。営業所の近くのすき間だけを休憩に
// 数えたので連続運転 4 時間で勤務が細切れになり、旭川駅前 ↔ 留萌十字街の便は入庫の回送で上限を超えていた)。
// 回送 20km/h では 87・64・72(上限超え 0)
describe.skipIf(!existsSync(BEFORE_ZIP) || !existsSync(AFTER_ZIP))('estimateDuties(道北バス、サンプルの営業所を置いたとき)', () => {
  it('平日 > 10/29 版の平日 > 土曜の順で、運用番号の数に近く、上限を超える勤務は無い', async () => {
    const { DOHOKU_SAMPLE_PLACES } = await import('@/lib/samplePlaces')
    const base = await load(BEFORE_ZIP)
    const edited = await load(AFTER_ZIP)
    const places = DOHOKU_SAMPLE_PLACES.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }))
    const on = (feed: GtfsFeed, date: string, withPlaces: boolean, params = {}) =>
      estimateDuties(tripLegs(feed, describeServiceDay(feed, date).serviceIds).legs, stopPointsOf(feed), params, withPlaces ? places : [])
    const started = performance.now()
    const weekday = on(base, WEEKDAY, true)
    const elapsed = performance.now() - started
    const saturday = on(base, SATURDAY, true)
    const after = on(edited, WEEKDAY, true)
    const all = [weekday, saturday, after]
    const short = (e: DutyEstimate) => e.duties.filter((d) => d.boundMin < 6 * 60).length
    console.info(
      `[道北バス・サンプルの営業所あり] 9/17 版の平日 ${weekday.dutyCount}・土曜 ${saturday.dutyCount}、10/29 版の平日 ${after.dutyCount}` +
        `(6時間未満 ${all.map(short).join('・')}、回送が長い ${all.map((e) => e.longDeadheadDuties).join('・')}、` +
        `上限超え ${all.map((e) => e.overLimitDuties).join('・')}。${Math.round(elapsed)}ms)`,
    )
    expect(all.map((e) => e.dutyCount)).toEqual([82, 60, 71])
    expect(all.map((e) => e.longDeadheadDuties)).toEqual([9, 10, 8])
    expect(all.map(short)).toEqual([27, 16, 21])
    expect(all.map((e) => e.overLimitDuties)).toEqual([0, 0, 0])
    expect(weekday.dutyCount).toBeGreaterThan(after.dutyCount)
    expect(after.dutyCount).toBeGreaterThan(saturday.dutyCount)
    // 営業所を置くと出庫・入庫の回送が加わるので、置かないときより勤務の数は少なくならない
    expect(weekday.dutyCount).toBeGreaterThanOrEqual(on(base, WEEKDAY, false).dutyCount)
    for (const [est, trips] of [
      [weekday, 447],
      [saturday, 361],
      [after, 381],
    ] as const) {
      const ids = est.duties.flatMap((d) => d.tripIds)
      expect(ids.length).toBe(trips)
      expect(new Set(ids).size).toBe(trips)
      for (const d of est.duties) {
        expect(d.boundMin).toBeLessThanOrEqual(DUTY_DEFAULTS.maxBoundMin)
        expect(d.drivingMin).toBeLessThanOrEqual(DUTY_DEFAULTS.maxDrivingMin)
        expect(d.maxContinuousMin).toBeLessThanOrEqual(DUTY_DEFAULTS.maxContinuousMin)
      }
      expect(est.vehicles.chained).toBeLessThanOrEqual(est.dutyCount)
    }
    // 回送 20km/h
    const at20 = [on(base, WEEKDAY, true, { deadheadKmh: 20 }), on(base, SATURDAY, true, { deadheadKmh: 20 }), on(edited, WEEKDAY, true, { deadheadKmh: 20 })]
    expect(at20.map((e) => e.dutyCount)).toEqual([87, 64, 72])
    expect(at20.map((e) => e.overLimitDuties)).toEqual([0, 0, 0])
    // ブラウザで走らせる計算なので、1回が数百ミリ秒に収まる(テストの環境の余裕を見て 1 秒)
    expect(elapsed).toBeLessThan(1000)
  })
})
