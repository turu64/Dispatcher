import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { activeServiceIds } from '../calendar'
import { computeServiceFeatures } from '../groups/features'
import { editGroups } from '../groups/edit'
import { gtfsPath, hasData, loadFeed, loadHolidays } from '../groups/groups.verify.fixture'
import { policyServicesFor } from '../groups/policy'
import { proposeGroups } from '../groups/rules'
import type { PolicyServices } from '../groups/types'
import type { HolidayList } from '../holidays'
import type { GtfsFeed, GtfsRow } from '../load'
import { validateEdit } from '../validate/edit'
import { writeGtfsZip } from '../write'
import { diffWeekdayTrips } from './diff'
import { activeWeekdayServicesOf, applyForm2, type Form2Result } from './form2'
import { checkPolicy, pairsOf, weekdayServicesOf, type Form2Plan, type PolicyKind, type PolicySettings } from './ops'
import { forEachDay } from './services'
import { compareStrings, stopTimesByTrip, tripSignature } from './signature'

// 形2の複数 service 化を実データで確かめる(docs/design-service-groups.md §2.8・§7.6 の受け入れ条件 5・6)。
// data/raw/gtfs/ の ZIP と祝日一覧(data/out/ref/holidays.json)が無ければスキップする(コミットしない)。
// 組の表は、グループ分け(A)の規則の案から policyServicesFor で作り、§2.8 の表と同じことも確かめる。
//
// 北海道中央バスの translations.txt には、平日の便(S000001 ほか)を record_id で指す行がある。今は checkPolicy の
// tripReferences(1104 §5.2)で止まるので、便の数の照合は translations.txt を除いたフィードで行う。tripReferences で止まる
// GTFS の一覧は、末尾の表のテストで確かめる(制限を外したときの回帰にもなる)。
//
// checkEveryDay は、新しい有効期間の毎日について、出力のその日の便の署名の多重集合が
// 「平日の組でない service の入力の便 + 走る平日の組の入れ替えに使う便(除外した系統を除き、新しい有効期間に1日も走らない
// 入れ替えに使う service の便も除く)+ 除外した系統の便 + 平日に戻した便」と同じことを確かめる(組ごと除く組・季節の service・
// 年末の扱いの誤りを、1日の照合では見落とすため)。

const GENERATED_AT = '202611041200'
const KYOTO = 'Kyoto_City_Bus_GTFS-20260930.zip'
const CHUO = 'hokkaido_chuo.zip'
const DOHOKU = 'dohoku_bus_減便前.zip'

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

function settingsOf(services: PolicyServices, start: string): PolicySettings {
  const { notApplied: _notApplied, ...rest } = services
  return { ...rest, period: { start, end: null }, excludedRoutes: [] }
}

function servicesFor(feed: GtfsFeed, holidays: HolidayList, kind: PolicyKind, keep: string[] = []): PolicyServices {
  let groups = proposeGroups(computeServiceFeatures(feed, holidays))
  for (const serviceId of keep) groups = editGroups(groups, { kind, serviceId, treatment: 'keep' })
  const services = policyServicesFor(groups, kind)
  if ('error' in services) throw new Error(services.error.map((e) => e.message).join('\n'))
  return services
}

function apply(feed: GtfsFeed, plan: Form2Plan): Form2Result {
  const outcome = applyForm2(feed, plan, { generatedAt: GENERATED_AT })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result
}

/** その日に走る便(service が activeServiceIds に入る便) */
function tripsOn(feed: GtfsFeed, date: string): GtfsRow[] {
  const active = activeServiceIds(feed, date)
  return (feed.tables.get('trips')?.rows ?? []).filter((t) => active.has(trimmed(t.service_id)))
}

function signaturesOf(feed: GtfsFeed, trips: readonly GtfsRow[]): string[] {
  const groups = stopTimesByTrip(feed.tables.get('stop_times')?.rows ?? [])
  return trips.map((t) => tripSignature(trimmed(t.route_id), groups.get(trimmed(t.trip_id)) ?? [])).sort(compareStrings)
}

/** translations.txt を除いたフィード(tripReferences を避けて便の数を照らすため) */
function withoutTranslations(feed: GtfsFeed): GtfsFeed {
  const tables = new Map(feed.tables)
  tables.delete('translations')
  return { tables, warnings: feed.warnings }
}

/** service → 署名 → 便の数 */
type Counts = Map<string, number>

function add(into: Counts, from: Counts): void {
  for (const [k, n] of from) into.set(k, (into.get(k) ?? 0) + n)
}

function countsByService(feed: GtfsFeed, keep: (trip: GtfsRow) => boolean = () => true): Map<string, Counts> {
  const groups = stopTimesByTrip(feed.tables.get('stop_times')?.rows ?? [])
  const out = new Map<string, Counts>()
  for (const t of feed.tables.get('trips')?.rows ?? []) {
    if (!keep(t)) continue
    const sid = trimmed(t.service_id)
    let c = out.get(sid)
    if (!c) out.set(sid, (c = new Map()))
    const sig = tripSignature(trimmed(t.route_id), groups.get(trimmed(t.trip_id)) ?? [])
    c.set(sig, (c.get(sig) ?? 0) + 1)
  }
  return out
}

/**
 * 新しい有効期間の毎日について、出力のその日の便の署名の多重集合が、入力から組み立てた多重集合と同じか。
 * 違う日を返す(全部同じなら [])。差は最初の 3 日だけ、署名ではなく便の数で書く
 */
function checkEveryDay(base: GtfsFeed, result: Form2Result): string[] {
  const plan = result.plan
  const pairs = pairsOf(plan)
  const pairOf = new Map(pairs.map((p) => [p.weekday, p]))
  const excluded = new Set(plan.excludedRoutes.map((r) => r.trim()))
  const accepted = new Set(result.report.addBack.accepted)
  const all = countsByService(base)
  const notExcluded = countsByService(base, (t) => !excluded.has(trimmed(t.route_id)))
  const keptOfWeekday = countsByService(
    base,
    (t) => pairOf.has(trimmed(t.service_id)) && (excluded.has(trimmed(t.route_id)) || accepted.has(trimmed(t.trip_id))),
  )
  // 新しい有効期間のどこかで走る service(期間に1日も走らない入れ替えに使う service の便は加えない。2026-11-04 の決定)
  const running = new Set<string>()
  forEachDay(result.report.validity.start, result.report.validity.end, (d) => {
    for (const sid of activeServiceIds(base, d)) running.add(sid)
  })
  const expectedOf = new Map<string, Counts>()
  for (const sid of all.keys()) {
    const pair = pairOf.get(sid)
    if (!pair) {
      expectedOf.set(sid, all.get(sid)!)
      continue
    }
    const c: Counts = new Map()
    for (const r of pair.replacements) if (running.has(r)) add(c, notExcluded.get(r) ?? new Map())
    add(c, keptOfWeekday.get(sid) ?? new Map())
    expectedOf.set(sid, c)
  }
  const actualOf = countsByService(result.feed)
  const wrong: string[] = []
  forEachDay(result.report.validity.start, result.report.validity.end, (d) => {
    const expected: Counts = new Map()
    for (const sid of activeServiceIds(base, d)) add(expected, expectedOf.get(sid) ?? new Map())
    const actual: Counts = new Map()
    for (const sid of activeServiceIds(result.feed, d)) add(actual, actualOf.get(sid) ?? new Map())
    let diff = 0
    for (const k of new Set([...expected.keys(), ...actual.keys()])) diff += Math.abs((expected.get(k) ?? 0) - (actual.get(k) ?? 0))
    if (diff > 0) wrong.push(`${d}:${diff} 便`)
  })
  return wrong.slice(0, 3)
}

function errorsOf(base: GtfsFeed, result: Form2Result, holidays: HolidayList) {
  return validateEdit(base, result, holidays).filter((i) => i.severity === 'error')
}

describe.skipIf(!hasData(KYOTO))('京都市営バス:形2の複数 service', () => {
  let feed: GtfsFeed
  let holidays: HolidayList
  let services: PolicyServices
  let from1105: Form2Result

  beforeAll(async () => {
    feed = await loadFeed(KYOTO)
    holidays = loadHolidays()
    services = servicesFor(feed, holidays, 'weekdayToSaturday')
    from1105 = apply(feed, { ...settingsOf(services, '20261105'), addBackTripIds: [] })
  }, 120_000)

  it('グループ分けの組の表が §2.8 と同じ', () => {
    expect(services.weekdayService).toBe('01001')
    expect(services.replacementService).toBe('03001')
    expect(services.pairs).toEqual([
      { weekday: '01001', replacements: ['03001'] },
      { weekday: '01001_A', replacements: ['03001_A'] },
      { weekday: '01001_C', replacements: ['03001_C'] },
      { weekday: '01001_F', replacements: ['03001_F'] },
      { weekday: '01001_GYB', replacements: ['03001_GYB'] },
      { weekday: '01005_MSN', replacements: [] },
    ])
    expect(services.keptWeekdayServices).toEqual(['01002_RIT', '01003_KSU', '01004_BUK'])
  })

  it('土曜に、期間 11/5〜:エラー 0、trip_id のぶつかり 0、主の組は replace-family-part(位置 1)、11/11 に走る便が 5,417', () => {
    const { feed: out, report } = from1105
    expect(errorsOf(feed, from1105, holidays)).toEqual([])
    expect(report.tripIds.collisions).toEqual([])
    expect(report.tripIds.rule).toBe('replace-family-part')
    expect(report.tripIds.servicePartIndex).toBe(1)
    expect(report.tripIds.derived.find((d) => d.from === '00100_03001_9389')?.to).toBe('00100_01001_9389')
    expect(report.tripIds.derived.find((d) => d.from === '05800_03001_11011_A')?.to).toBe('05800_01001_11011_A')
    expect(tripsOn(out, '20261111')).toHaveLength(5417)
    // 01001_C(11/2 だけ走る)と 03001_C(10/31 だけ走る)は出力から除かれる
    expect(report.droppedServices.map((d) => d.serviceId)).toEqual(expect.arrayContaining(['01001_C', '03001_C']))
    expect(report.pairs?.find((p) => p.weekday === '01001_C')?.dropped).toBe(true)
    expect(report.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['weekdayServicesKept', 'weekdayServicesErased']))
    // trip_id は一意
    const ids = (out.tables.get('trips')?.rows ?? []).map((t) => trimmed(t.trip_id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('11/11 の便の署名が、入力の 11/14(土)の便と残した便を足したものと同じ', () => {
    const kept = new Set(services.keptWeekdayServices)
    const expected = [
      ...signaturesOf(feed, tripsOn(feed, '20261114')),
      ...signaturesOf(feed, tripsOn(feed, '20261111').filter((t) => kept.has(trimmed(t.service_id)))),
    ].sort(compareStrings)
    expect(signaturesOf(from1105.feed, tripsOn(from1105.feed, '20261111'))).toEqual(expected)
  })

  it('weekdayNotRunning は主の組(01001)の分だけ出る(大学の便の休みであふれない)', () => {
    const issues = validateEdit(feed, from1105, holidays).filter((i) => i.code === 'weekdayNotRunning')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('平日ダイヤ(01001)')
    expect(issues[0].message).not.toContain('01002_RIT')
  })

  it('平日の service の集合で前後を比べると、なくなる便と加わる便が組ごとに数えられ、組ごと除いた 01001_C の便は入らない', () => {
    const active = activeWeekdayServicesOf(from1105)
    expect(active.has('01001_C')).toBe(false)
    expect(weekdayServicesOf(from1105.plan).has('01001_C')).toBe(true)
    const diff = diffWeekdayTrips(feed, from1105.feed, active)
    const before = (feed.tables.get('trips')?.rows ?? []).filter((t) => active.has(trimmed(t.service_id))).length
    expect(diff.removed.length + diff.same.length).toBe(before)
    expect(diff.added.length + diff.same.length).toBe(
      (from1105.feed.tables.get('trips')?.rows ?? []).filter((t) => active.has(trimmed(t.service_id))).length,
    )
    const serviceOf = new Map((feed.tables.get('trips')?.rows ?? []).map((t) => [trimmed(t.trip_id), trimmed(t.service_id)]))
    expect(diff.removed.filter((b) => serviceOf.get(b.tripId) === '01001_C')).toEqual([])
  })

  it('土曜に、期間 11/5〜:新しい有効期間の毎日、走る便が設計どおり', () => {
    expect(checkEveryDay(feed, from1105)).toEqual([])
    // 照合が誤りを見つけること:加わる便を1つ除くと、その便の走る日が違う日になる
    const trips = from1105.feed.tables.get('trips')!
    const dropOne = new Map(from1105.feed.tables)
    dropOne.set('trips', { ...trips, rows: trips.rows.filter((t) => trimmed(t.trip_id) !== '00100_01001_9389') })
    expect(checkEveryDay(feed, { ...from1105, feed: { ...from1105.feed, tables: dropOne } }).length).toBeGreaterThan(0)
  })

  it('土曜に、期間 11/5〜で平日に戻す便を混ぜる:組ごと除く 01001_C の便は notActive で、出力に無く、毎日の便も設計どおり', () => {
    const trips = feed.tables.get('trips')?.rows ?? []
    const removed = new Set(from1105.report.tripIds.removed)
    const of = (sid: string, pick: (id: string) => boolean = () => true) =>
      trips.map((t) => [trimmed(t.trip_id), trimmed(t.service_id)] as const).filter(([id, s]) => s === sid && pick(id)).map(([id]) => id)
    const cTrip = '08600_01001_1356_C'
    expect(of('01001_C')).toContain(cTrip)
    const back = [...of('01001', (id) => removed.has(id)).slice(0, 3), ...of('01001_A', (id) => removed.has(id)).slice(0, 2)]
    const addBackTripIds = [cTrip, ...back, of('01002_RIT')[0], of('03001')[0]]
    const result = apply(feed, { ...settingsOf(services, '20261105'), addBackTripIds })
    const { addBack } = result.report
    expect(addBack.notActive).toEqual([cTrip])
    // 同じ署名の加わる便がある便は「すでにある」になる。残りは受け付ける
    expect([...addBack.accepted, ...addBack.ignoredAlreadyPresent.map((x) => x.tripId)].sort(compareStrings)).toEqual([...back].sort(compareStrings))
    expect(addBack.accepted.length).toBeGreaterThan(0)
    expect(addBack.alreadyKept).toEqual([of('01002_RIT')[0]])
    expect(addBack.notWeekday).toEqual([of('03001')[0]])
    expect(result.report.tripIds.addedBack).not.toContain(cTrip)
    const outIds = (result.feed.tables.get('trips')?.rows ?? []).map((t) => trimmed(t.trip_id))
    expect(outIds).not.toContain(cTrip)
    for (const id of addBack.accepted) expect(outIds).toContain(id)
    expect(new Set(outIds).size).toBe(outIds.length)
    expect(result.report.tripIds.collisions).toEqual([])
    expect(errorsOf(feed, result, holidays)).toEqual([])
    expect(checkEveryDay(feed, result)).toEqual([])
  })

  it('土曜に、期間 11/1〜:エラー 0、03001_C は期間に走らないため加えない(replacementNotActiveSkipped)、11/2 に走る便が 5,063', () => {
    const settings = settingsOf(services, '20261101')
    const problems = checkPolicy(feed, settings)
    expect(problems.filter((p) => p.severity === 'error')).toEqual([])
    expect(problems.map((p) => p.code)).not.toContain('replacementNotActiveAdded')
    const skipped = problems.filter((p) => p.code === 'replacementNotActiveSkipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].message).toContain('03001_C')
    expect(skipped[0].message).toContain('01001_C に加えません')
    expect(skipped[0].message).toContain('代わりの便なしでなくなります')
    const result = apply(feed, { ...settings, addBackTripIds: [] })
    expect(errorsOf(feed, result, holidays)).toEqual([])
    expect(result.report.tripIds.collisions).toEqual([])
    // 加えていたときの 5,377 便から、03001_C の便(10/31 だけ走る迂回の版。314 便)を引いた数
    const cTrips = (feed.tables.get('trips')?.rows ?? []).filter((t) => trimmed(t.service_id) === '03001_C').length
    expect(cTrips).toBe(314)
    expect(tripsOn(result.feed, '20261102')).toHaveLength(5377 - cTrips)
    // 01001_C の組は残る(11/2 に走る)が、加わる便は無く、01001_C の便は代わりの便なしでなくなる
    const pairC = result.report.pairs?.find((p) => p.weekday === '01001_C')
    expect(pairC?.dropped).toBe(false)
    expect(pairC?.replacements).toEqual([expect.objectContaining({ serviceId: '03001_C', added: 0, notActive: true })])
    expect(pairC?.removed).toBe(310)
    expect(result.report.warnings.find((w) => w.code === 'replacementNotActiveSkipped')?.message).toContain('(03001_C:314 便 → 01001_C)')
    expect(tripsOn(result.feed, '20261102').filter((t) => trimmed(t.service_id) === '01001_C')).toEqual([])
    expect(activeWeekdayServicesOf(result).has('01001_C')).toBe(true)
    expect(checkEveryDay(feed, result)).toEqual([])
  })

  it('日祝に、期間 11/5〜:エラー 0、主の組は 01001 ← 02001', () => {
    const sun = servicesFor(feed, holidays, 'weekdayToSundayHoliday')
    expect(sun.replacementService).toBe('02001')
    const result = apply(feed, { ...settingsOf(sun, '20261105'), addBackTripIds: [] })
    expect(errorsOf(feed, result, holidays)).toEqual([])
    expect(result.report.tripIds.collisions).toEqual([])
    const kept = new Set(sun.keptWeekdayServices)
    const expected = [
      ...signaturesOf(feed, tripsOn(feed, '20261115')),
      ...signaturesOf(feed, tripsOn(feed, '20261111').filter((t) => kept.has(trimmed(t.service_id)))),
    ].sort(compareStrings)
    expect(signaturesOf(result.feed, tripsOn(result.feed, '20261111'))).toEqual(expected)
    expect(checkEveryDay(feed, result)).toEqual([])
  })
})

describe.skipIf(!hasData(CHUO))('北海道中央バス:形2の複数 service', () => {
  let feed: GtfsFeed
  let holidays: HolidayList

  beforeAll(async () => {
    feed = await loadFeed(CHUO)
    holidays = loadHolidays()
  }, 120_000)

  it('土曜に(S000039・S000044 を残す):11/11 に走る便が 3,739 で、署名が入力の 11/14 の便と残した 3 便を足したものと同じ', () => {
    const services = servicesFor(feed, holidays, 'weekdayToSaturday', ['S000039', 'S000044'])
    expect(services.weekdayService).toBe('S000001')
    expect(pairsOf({ ...services }).map((p) => p.weekday)).toEqual(['S000001', 'S000014', 'S000025'])
    expect([...(services.pairs?.[0].replacements ?? [])].sort(compareStrings)).toEqual(
      ['S000002', 'S000027', 'S000028', 'S000029', 'S000036', 'S000038', 'S000041', 'S000042', 'S000049'],
    )
    expect(services.keptWeekdayServices).toEqual(['S000015', 'S000039', 'S000044'])

    const base = withoutTranslations(feed)
    const result = apply(base, { ...settingsOf(services, '20261109'), addBackTripIds: [] })
    expect(errorsOf(base, result, holidays)).toEqual([])
    expect(result.report.tripIds.collisions).toEqual([])
    expect(result.report.tripIds.rule).toBe('append-service')
    const on1111 = tripsOn(result.feed, '20261111')
    expect(on1111).toHaveLength(3739)
    const kept = new Set(services.keptWeekdayServices)
    const keptTrips = tripsOn(base, '20261111').filter((t) => kept.has(trimmed(t.service_id)))
    expect(keptTrips).toHaveLength(3)
    const expected = [...signaturesOf(base, tripsOn(base, '20261114')), ...signaturesOf(base, keptTrips)].sort(compareStrings)
    expect(signaturesOf(result.feed, on1111)).toEqual(expected)
    expect(checkEveryDay(base, result)).toEqual([])
  })

  it('土曜に、期間 11/9〜:replacementPartial は主の組に1つで、土曜の運休がある S000049 の 3 日だけ(年末年始の 1/2 は数えない)', () => {
    const services = servicesFor(feed, holidays, 'weekdayToSaturday', ['S000039', 'S000044'])
    const partial = checkPolicy(withoutTranslations(feed), settingsOf(services, '20261109')).filter((p) => p.code === 'replacementPartial')
    expect(partial).toHaveLength(1)
    expect(partial[0].message).toContain('S000001 に便を加える')
    expect(partial[0].message).toContain('S000049:3 日(12/5・12/12・12/19)')
    expect(partial[0].message).not.toContain('S000002')
  })

  it('土曜に、期間 10/5〜10/31:冬ダイヤの S000041・S000042 は止めずに、期間に走らないため加えない(主の組でも主でない組と同じ扱い)', () => {
    const services = servicesFor(feed, holidays, 'weekdayToSaturday', ['S000039', 'S000044'])
    const settings: PolicySettings = { ...settingsOf(services, '20261005'), period: { start: '20261005', end: '20261031' } }
    const base = withoutTranslations(feed)
    const problems = checkPolicy(base, settings)
    expect(problems.filter((p) => p.severity === 'error')).toEqual([])
    expect(problems.map((p) => p.code)).not.toContain('replacementNotActiveAdded')
    const skipped = problems.filter((p) => p.code === 'replacementNotActiveSkipped').map((p) => p.message)
    expect(skipped).toHaveLength(2)
    expect(skipped.join()).toContain('S000041')
    expect(skipped.join()).toContain('S000042')
    // 主の組にはほかの入れ替えに使う service の便が加わるので、代わりの便なしでなくなるとは書かない
    expect(skipped.join()).not.toContain('代わりの便なし')
    const result = apply(base, { ...settings, addBackTripIds: [] })
    expect(errorsOf(base, result, holidays)).toEqual([])
    const main = result.report.pairs?.[0]
    const notActive = (main?.replacements ?? []).filter((r) => r.notActive)
    expect(notActive.map((r) => r.serviceId).sort(compareStrings)).toEqual(['S000041', 'S000042'])
    expect(notActive.every((r) => r.added === 0)).toBe(true)
    // 冬ダイヤの便は 10 月の平日に加わらない(加わる便の元に S000041・S000042 の便が無い)
    const serviceOf = new Map((base.tables.get('trips')?.rows ?? []).map((t) => [trimmed(t.trip_id), trimmed(t.service_id)]))
    const fromWinter = result.report.tripIds.derived.filter((d) => ['S000041', 'S000042'].includes(serviceOf.get(d.from) ?? ''))
    expect(fromWinter).toEqual([])
    expect(checkEveryDay(base, result)).toEqual([])
  })

  it('日祝に(S000040 を残す):11/11 に走る便が 3,636', () => {
    const services = servicesFor(feed, holidays, 'weekdayToSundayHoliday', ['S000040'])
    const base = withoutTranslations(feed)
    const result = apply(base, { ...settingsOf(services, '20261109'), addBackTripIds: [] })
    expect(errorsOf(base, result, holidays)).toEqual([])
    expect(tripsOn(result.feed, '20261111')).toHaveLength(3636)
    expect(checkEveryDay(base, result)).toEqual([])
  })

  it('translations.txt が平日の便を指すため、そのままでは tripReferences で止まる', () => {
    const services = servicesFor(feed, holidays, 'weekdayToSaturday', ['S000039', 'S000044'])
    const codes = checkPolicy(feed, settingsOf(services, '20261109')).filter((p) => p.severity === 'error').map((p) => p.code)
    expect(codes).toEqual(['tripReferences'])
  })

  it('S000039(月〜金と日祝)を組に入れると weekdayServiceRunsOnWeekend', () => {
    const services = servicesFor(feed, holidays, 'weekdayToSaturday', ['S000039', 'S000044'])
    const settings = settingsOf(services, '20261109')
    const pairs = [...(settings.pairs ?? []), { weekday: 'S000039', replacements: [] }]
    const problems = checkPolicy(withoutTranslations(feed), {
      ...settings,
      pairs,
      keptWeekdayServices: settings.keptWeekdayServices?.filter((s) => s !== 'S000039'),
    })
    expect(problems.filter((p) => p.severity === 'error').map((p) => p.code)).toEqual(['weekdayServiceRunsOnWeekend'])
  })
})

describe.skipIf(!hasData(DOHOKU))('道北バス:1組の pairs は pairs 無しと同じ出力', () => {
  it('pairs: [{01, [03]}]・keptWeekdayServices: [] の ZIP が、pairs 無しの ZIP とバイト単位で同じ', async () => {
    const feed = await loadFeed(DOHOKU)
    const buf = readFileSync(gtfsPath(DOHOKU))
    const original = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    const plain: Form2Plan = {
      kind: 'weekdayToSaturday',
      weekdayService: '01',
      replacementService: '03',
      period: { start: '20261101', end: null },
      excludedRoutes: ['0051', '0151'],
      addBackTripIds: ['0004_01_01_01_0710', '0026_01_01_01_0705', 'nothing'],
    }
    const withPairs: Form2Plan = { ...plain, pairs: [{ weekday: '01', replacements: ['03'] }], keptWeekdayServices: [] }
    const a = apply(feed, plain)
    const b = apply(feed, withPairs)
    const zip = async (r: Form2Result) =>
      new Uint8Array(await (await writeGtfsZip({ original, base: feed, edited: r.feed, generatedAt: GENERATED_AT, attribution: 'x' })).arrayBuffer())
    expect(await zip(b)).toEqual(await zip(a))
    const { pairs, ...reportB } = b.report
    const { alreadyKept, notActive, ...addBackB } = reportB.addBack
    expect({ ...reportB, addBack: addBackB }).toEqual(a.report)
    expect(alreadyKept).toEqual([])
    expect(notActive).toEqual([])
    expect(pairs).toEqual([
      { weekday: '01', dropped: false, removed: a.report.tripIds.removed.length, replacements: [{ serviceId: '03', rule: 'replace-service-part', servicePartIndex: 3, added: a.report.tripIds.derived.length, notActive: false }] },
    ])
  })
})

// translations.txt などで平日の便を指す行があり、checkPolicy の tripReferences で止まる GTFS(1104 §5.2 の制限)。
// グループ分けの規則の案(形2で表せない service は「残す」に直す)で、土曜に・期間 11/9〜。制限を外したら表を直す
const TRIP_REFERENCES: [file: string, stops: boolean][] = [
  [KYOTO, false],
  ['asahikawa_denki.zip', false],
  [DOHOKU, false],
  ['dohoku_bus_減便後.zip', false],
  ['engan_bus.zip', true],
  ['haborocho_com.zip', true],
  [CHUO, true],
  ['hokumon_bus.zip', true],
  ['meishi_bus.zip', true],
  ['shibetsu_kido.zip', true],
  ['sorachi_chuo_bus.zip', true],
]

describe('tripReferences で止まる GTFS の表', () => {
  for (const [file, stops] of TRIP_REFERENCES) {
    it.skipIf(!hasData(file))(`${file}:${stops ? '止まる' : '止まらない'}`, async () => {
      const feed = await loadFeed(file)
      const holidays = loadHolidays()
      let groups = proposeGroups(computeServiceFeatures(feed, holidays))
      let services = policyServicesFor(groups, 'weekdayToSaturday')
      for (let i = 0; i < 3 && 'error' in services; i++) {
        for (const serviceId of services.error.flatMap((e) => e.serviceIds)) {
          groups = editGroups(groups, { kind: 'weekdayToSaturday', serviceId, treatment: 'keep' })
        }
        services = policyServicesFor(groups, 'weekdayToSaturday')
      }
      if ('error' in services) throw new Error(services.error.map((e) => e.message).join('\n'))
      const codes = checkPolicy(feed, settingsOf(services, '20261109')).filter((p) => p.severity === 'error').map((p) => p.code)
      expect(codes.includes('tripReferences')).toBe(stops)
      expect(codes.filter((c) => c !== 'tripReferences')).toEqual([])
    }, 120_000)
  }
})
