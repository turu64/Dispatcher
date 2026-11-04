import { beforeAll, describe, expect, it } from 'vitest'
import { diffWeekdayTrips } from '../edit/diff'
import { activeWeekdayServicesOf, applyForm2, type Form2Result } from '../edit/form2'
import { pickNoticeDate } from '../edit/notice'
import { checkPolicy, type PolicyKind, type PolicySettings } from '../edit/ops'
import { describeServices, feedValidity, guessServiceChoice, policyValidity } from '../edit/services'
import type { HolidayList } from '../holidays'
import type { GtfsFeed } from '../load'
import { computeServiceFeatures } from './features'
import { hasData, loadFeed, loadHolidays } from './groups.verify.fixture'
import { policyServicesFor } from './policy'
import { proposeGroups } from './rules'
import { groupedPolicyServices, groupSettings, type GroupChoice } from './view'

// 画面と AI のツールが通る経路(groupedPolicyServices → groupSettings → checkPolicy → applyForm2 → activeWeekdayServicesOf で前後を比べる)を
// 実データで確かめる(docs/design-service-groups.md §5.2・§5.3)。data/raw/gtfs/ の ZIP と祝日一覧が無ければスキップする

const GENERATED_AT = '202611041200'
const KYOTO = 'Kyoto_City_Bus_GTFS-20260930.zip'
const DOHOKU = 'dohoku_bus_減便前.zip'

function confirmedChoice(feed: GtfsFeed, holidays: HolidayList, kind: PolicyKind): Exclude<GroupChoice, { error: unknown }> {
  const g = groupedPolicyServices(proposeGroups(computeServiceFeatures(feed, holidays)), true)
  if (g?.status !== 'confirmed') throw new Error('確定したグループ分けのはず')
  const c = g.byKind[kind]
  if ('error' in c) throw new Error(c.error.map((e) => e.message).join('\n'))
  return c
}

function apply(feed: GtfsFeed, settings: PolicySettings): Form2Result {
  const outcome = applyForm2(feed, { ...settings, addBackTripIds: [] }, { generatedAt: GENERATED_AT })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result
}

describe.skipIf(!hasData(DOHOKU))('道北バス:ダイヤ単位で選ばず、今の推定と同じ', () => {
  it('groupedPolicyServices は null で、policyServicesFor の値は今の service の推定と同じ(01/03、01/06)', async () => {
    const feed = await loadFeed(DOHOKU)
    const holidays = loadHolidays()
    const groups = proposeGroups(computeServiceFeatures(feed, holidays))
    expect(groups.simple).toBe(true)
    expect(groupedPolicyServices(groups, true)).toBeNull()
    const input = feedValidity(feed)!
    const guess = guessServiceChoice(feed, describeServices(feed, holidays), policyValidity(input, { start: '20261101', end: null })!)
    const sat = policyServicesFor(groups, 'weekdayToSaturday')
    const sun = policyServicesFor(groups, 'weekdayToSundayHoliday')
    if ('error' in sat || 'error' in sun) throw new Error('作れるはず')
    expect([sat.weekdayService, sat.replacementService]).toEqual([guess?.weekday, guess?.saturday])
    expect([sun.weekdayService, sun.replacementService]).toEqual([guess?.weekday, guess?.sundayHoliday])
    expect(sat.pairs).toBeUndefined()
  })
})

describe.skipIf(!hasData(KYOTO))('京都市営バス:画面の経路(groupSettings)で作った方針', () => {
  let feed: GtfsFeed
  let holidays: HolidayList
  let choice: Exclude<GroupChoice, { error: unknown }>

  beforeAll(async () => {
    feed = await loadFeed(KYOTO)
    holidays = loadHolidays()
    choice = confirmedChoice(feed, holidays, 'weekdayToSaturday')
  }, 120_000)

  it('主の組が weekdayService・replacementService とそろう', () => {
    expect(choice.pairs?.[0].weekday).toBe(choice.weekdayService)
    expect(choice.pairs?.[0].replacements[0] ?? '').toBe(choice.replacementService)
  })

  it('期間 11/5〜:checkPolicy のエラーが 0 で、前後の比較のなくなる便に、組ごと除いた 01001_C の便が入らない', () => {
    const settings = groupSettings(choice, { start: '20261105', end: null }, [])
    expect(checkPolicy(feed, settings).filter((p) => p.severity === 'error')).toEqual([])
    const result = apply(feed, settings)
    expect(result.report.droppedServices.map((d) => d.serviceId)).toContain('01001_C')
    const active = activeWeekdayServicesOf(result)
    expect(active.has('01001_C')).toBe(false)
    const diff = diffWeekdayTrips(feed, result.feed, active, settings.excludedRoutes)
    const cTrips = new Set((feed.tables.get('trips')?.rows ?? []).filter((t) => t.service_id?.trim() === '01001_C').map((t) => t.trip_id!.trim()))
    expect(cTrips.size).toBeGreaterThan(0)
    expect(diff.removed.filter((t) => cTrips.has(t.tripId))).toEqual([])
  })

  it('期間 11/1〜:周知文・変更指示書の比較する日付は、01001_A が運休して 01001_C だけが走る 11/2 ではない', () => {
    const result = apply(feed, groupSettings(choice, { start: '20261101', end: null }, []))
    const date = pickNoticeDate(feed, result)
    expect(date).not.toBeNull()
    expect(date).not.toBe('20261102')
  })
})
