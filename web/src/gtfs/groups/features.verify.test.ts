import { describe, expect, it } from 'vitest'
import { computeServiceFeatures } from './features'
import { hasData, loadFeed, loadHolidays } from './groups.verify.fixture'
import { proposeGroups } from './rules'

// 京都市営バス(data/raw/gtfs/。コミットしない)の判断材料(docs/design-service-groups.md §7.3 の受け入れ条件 2・9)。
// ファイルと祝日一覧が無ければスキップする

const KYOTO = 'Kyoto_City_Bus_GTFS-20260930.zip'

describe.skipIf(!hasData(KYOTO))('京都市営バスの判断材料', () => {
  it('有効期間の区分ごとの日数と、01001_A・01001_C の運行日', async () => {
    const f = computeServiceFeatures(await loadFeed(KYOTO), loadHolidays())
    expect(f.validity).toEqual({ start: '20260928', end: '20270331' })
    expect(f.daysInPeriod).toEqual({ weekday: 125, saturday: 26, sundayHoliday: 34 })
    expect(f.services).toHaveLength(30)
    const by = new Map(f.services.map((s) => [s.serviceId, s]))
    const a = by.get('01001_A')!
    expect(a.runningDays.weekday).toBe(121)
    expect(a.coverage.weekday).toBeCloseTo(0.97, 2)
    expect(a.basis).toBe('regular')
    const c = by.get('01001_C')!
    expect(c.runningDates).toEqual(['20261102'])
    expect(c.basis).toBe('special')
    expect(by.get('01004_BUK')!.nearThreshold).toEqual(['weekday'])
    expect(by.get('SRV_8_10600_01_C')!.basis).toBe('noDays')
    expect(by.get('01001')!.tripCount).toBe(5924)
  })

  it('computeServiceFeatures と proposeGroups の合計が 1,000 ms 以内(300 ms を超えたら Web Worker に移す)', async () => {
    const feed = await loadFeed(KYOTO)
    const holidays = loadHolidays()
    // 画面で読み込んだ直後に1回だけ計算するので、1回目(JIT の暖まりを含む)で判定する。2回目は参考に出す
    const times: number[] = []
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now()
      proposeGroups(computeServiceFeatures(feed, holidays))
      times.push(performance.now() - t0)
    }
    console.info(
      `[グループ分けの計算時間] 京都市営バス(便 17,835 本):1回目 ${times[0].toFixed(0)} ms、2回目 ${times[1].toFixed(0)} ms(Web Worker に移す目安 300 ms)`,
    )
    expect(times[0]).toBeLessThan(1000)
  }, 30_000)
})
