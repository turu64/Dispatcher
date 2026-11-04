import { describe, expect, it } from 'vitest'
import type { HolidayList } from '../holidays'
import type { GtfsFeed, GtfsRow } from '../load'
import { validateEdit } from '../validate/edit'
import { serializeTable } from '../write'
import { diffWeekdayTrips } from './diff'
import { activeWeekdayServicesOf, applyForm2, applyRevert, tripIdRuleFor, type Form2Result } from './form2'
import { basePlan, MULTI_CALENDAR_DATES, multiFeed, multiPlan, rowsOf, smallFeed, withRows } from './form2.fixture'
import { checkPolicy, planOf, weekdayServicesOf, type Form2Plan } from './ops'
import { restoreHints } from './restore'

// 形2の複数 service 化(docs/design-service-groups.md §4・§7.6 の受け入れ条件 2〜4)。手で作るフィードで確かめる

const OPTS = { generatedAt: '202611041200' }

function apply(feed: GtfsFeed, plan: Form2Plan): Form2Result {
  const outcome = applyForm2(feed, plan, OPTS)
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result
}

function rows(feed: GtfsFeed, name: string): GtfsRow[] {
  return feed.tables.get(name)?.rows ?? []
}

function tripsOf(feed: GtfsFeed, service: string): string[] {
  return rows(feed, 'trips')
    .filter((t) => t.service_id === service)
    .map((t) => t.trip_id ?? '')
}

function codes(result: Form2Result): string[] {
  return result.report.warnings.map((w) => w.code)
}

function warning(result: Form2Result, code: string): string {
  return result.report.warnings.find((w) => w.code === code)?.message ?? ''
}

const HOLIDAYS: HolidayList = {
  names: new Map([
    ['20261103', '文化の日'],
    ['20261123', '勤労感謝の日'],
  ]),
  first: '20260101',
  coveredUntil: '20271231',
} as HolidayList

describe('tripIdRuleFor(加わる便の trip_id の規則。S1)', () => {
  const r = (trip_id: string, service_id: string): GtfsRow => ({ trip_id, service_id })

  it('部分の数がそろい、service_id と等しい部分があれば replace-service-part', () => {
    expect(tripIdRuleFor([r('R2_0900_WB', 'WB'), r('R2_1000_SB1', 'SB1')], 'WB', 'SB1')).toEqual({ rule: 'replace-service-part', index: 2 })
  })

  it('部分の数がそろわなくても、すべての便で頭と等しい位置があれば replace-family-part', () => {
    expect(
      tripIdRuleFor([r('00100_01001_9389', '01001'), r('05800_01001_11011_A', '01001'), r('00100_03001_9389', '03001')], '01001', '03001'),
    ).toEqual({ rule: 'replace-family-part', index: 1 })
  })

  it('共通の位置が2つあれば一番右', () => {
    expect(
      tripIdRuleFor([r('01001_01001_1_A', '01001_A'), r('03001_03001_2_A', '03001_A'), r('03001_03001_3', '03001_A')], '01001_A', '03001_A'),
    ).toEqual({ rule: 'replace-family-part', index: 1 })
  })

  it('すべての便に共通しない位置は使わない', () => {
    expect(tripIdRuleFor([r('01001_x_1', '01001'), r('y_03001_2', '03001')], '01001', '03001')).toEqual({ rule: 'append-service', index: null })
  })

  it('部分が足りない便があればその位置は使わず、部分が1つしかない便があれば規則 2 を使わない', () => {
    expect(tripIdRuleFor([r('a_b_01001', '01001'), r('c_03001', '03001')], '01001', '03001')).toEqual({ rule: 'append-service', index: null })
    expect(tripIdRuleFor([r('a_01001', '01001'), r('03001', '03001')], '01001', '03001')).toEqual({ rule: 'append-service', index: null })
  })

  it('2つの頭が同じなら規則 2 を使わない(置き換えても trip_id が変わらないため)', () => {
    expect(tripIdRuleFor([r('a_WK_1', 'WK_1'), r('b_WK_2_x', 'WK_2')], 'WK_1', 'WK_2')).toEqual({ rule: 'append-service', index: null })
  })
})

describe('1組の pairs は pairs 無しと同じ(受け入れ条件 2)', () => {
  it('小さなフィード:表のバイト列と report が同じ(report は pairs と addBack.alreadyKept・notActive だけが増える)', () => {
    const feed = smallFeed()
    const plain = basePlan({ excludedRoutes: ['R2'], addBackTripIds: ['R3_0730_WK', 'R1_0700_WK', 'R1_0700_WK', 'X'] })
    const a = apply(feed, plain)
    const b = apply(feed, { ...plain, pairs: [{ weekday: 'WK', replacements: ['SA'] }], keptWeekdayServices: [] })
    for (const name of feed.tables.keys()) {
      expect(serializeTable(b.feed.tables.get(name)!)).toEqual(serializeTable(a.feed.tables.get(name)!))
    }
    const { pairs, ...reportB } = b.report
    const { alreadyKept, notActive, ...addBackB } = reportB.addBack
    expect({ ...reportB, addBack: addBackB }).toEqual(a.report)
    expect(alreadyKept).toEqual([])
    expect(notActive).toEqual([])
    expect(pairs).toEqual([
      {
        weekday: 'WK',
        dropped: false,
        removed: a.report.tripIds.removed.length,
        replacements: [{ serviceId: 'SA', rule: 'replace-service-part', servicePartIndex: 2, added: a.report.tripIds.derived.length, notActive: false }],
      },
    ])
    expect('pairs' in a.report).toBe(false)
    expect('alreadyKept' in a.report.addBack).toBe(false)
    expect('notActive' in a.report.addBack).toBe(false)
  })

  it('planOf は pairs・keptWeekdayServices が無ければ項目を作らず、あれば写す', () => {
    const settings = { kind: 'weekdayToSaturday' as const, weekdayService: 'WK', replacementService: 'SA', period: { start: '20261101', end: null }, excludedRoutes: [] }
    const reason = { category: null, note: '' }
    const at = '2026-11-04T09:00:00+09:00'
    const plain = planOf([{ op: { type: 'applyPolicy', settings, reason }, by: 'user', at }])
    expect(plain).not.toHaveProperty('pairs')
    expect(plain).not.toHaveProperty('keptWeekdayServices')
    const pairs = [{ weekday: 'WK', replacements: ['SA'] }]
    const multi = planOf([{ op: { type: 'applyPolicy', settings: { ...settings, pairs, keptWeekdayServices: ['K'] }, reason }, by: 'user', at }])
    expect(multi?.pairs).toEqual(pairs)
    expect(multi?.pairs).not.toBe(pairs)
    expect(multi?.keptWeekdayServices).toEqual(['K'])
  })
})

describe('applyForm2(組が複数)', () => {
  it('組ごとに平日の便をなくし、入れ替えに使う service の便をその組の平日の service に加える', () => {
    const { feed, report } = apply(multiFeed(), multiPlan())
    expect(tripsOf(feed, '01001')).toEqual(['R1_01001_0700', 'R1_01001_0805_K', 'R1_01001_0900'])
    expect(tripsOf(feed, '01001_A')).toEqual(['R1_01001_0800_A'])
    expect(tripsOf(feed, '01005_MSN')).toEqual([])
    expect(tripsOf(feed, 'WB')).toEqual(['R2_1000_WB', 'X1100_WB'])
    // 入れ替えに使う service・残す service・月〜土の service の便はそのまま
    expect(tripsOf(feed, '03001')).toEqual(['R1_03001_0700', 'R1_03001_0805_K', 'R1_03001_0900'])
    expect(tripsOf(feed, '01002_RIT')).toEqual(['R4_01002_1300_RIT'])
    expect(tripsOf(feed, 'MS')).toEqual(['R1_MS_1400'])
    // 加わる便の stop_times は入れ替えに使う便の行の写し
    const st = rows(feed, 'stop_times').filter((r) => r.trip_id === 'X1100_WB')
    expect(st.map((r) => r.departure_time)).toEqual(['11:00:00', '11:10:00'])
    // 主の組の規則
    expect(report.tripIds.rule).toBe('replace-family-part')
    expect(report.tripIds.servicePartIndex).toBe(1)
    expect(report.tripIds.removed).toEqual(['R1_01001_0700', 'R1_01001_0800_K', 'R1_01001_0900_A', 'R1_01005_1200_MSN', 'R2_0900_WB', 'R3_01001_0730'])
    expect(report.tripIds.derived.map((d) => d.from)).toEqual([...report.tripIds.derived.map((d) => d.from)].sort())
    expect(report.pairs).toEqual([
      { weekday: '01001', dropped: false, removed: 3, replacements: [{ serviceId: '03001', rule: 'replace-family-part', servicePartIndex: 1, added: 3, notActive: false }] },
      { weekday: '01001_A', dropped: false, removed: 1, replacements: [{ serviceId: '03001_A', rule: 'replace-family-part', servicePartIndex: 1, added: 1, notActive: false }] },
      { weekday: '01001_C', dropped: true, removed: 0, replacements: [{ serviceId: '03001_C', rule: 'replace-family-part', servicePartIndex: 1, added: 0, notActive: true }] },
      { weekday: '01005_MSN', dropped: false, removed: 1, replacements: [] },
      {
        weekday: 'WB',
        dropped: false,
        removed: 1,
        replacements: [
          { serviceId: 'SB1', rule: 'replace-service-part', servicePartIndex: 2, added: 1, notActive: false },
          { serviceId: 'SB2', rule: 'append-service', servicePartIndex: null, added: 1, notActive: false },
        ],
      },
    ])
    // 新しい有効期間に走らない 01001_C の組は組ごと除く(03001_C も 10/31 だけなので除かれる)
    expect(report.droppedServices).toEqual([
      { serviceId: '01001_C', trips: 1 },
      { serviceId: '03001_C', trips: 1 },
    ])
    expect(tripsOf(feed, '01001_C')).toEqual([])
  })

  it('組を足した警告:残す service、なくす service、ほかの平日の service の扱い', () => {
    const result = apply(multiFeed(), multiPlan())
    expect(codes(result)).toEqual(['servicesDropped', 'weekdayServicesKept', 'weekdayServicesErased'])
    expect(warning(result, 'weekdayServicesKept')).toContain('01002_RIT:1 便、11/5・11/6')
    expect(warning(result, 'weekdayServicesErased')).toContain('01005_MSN 1 便')
    // 残すと決めた 01002_RIT は calendar_dates だけなので otherWeekdayServices の対象でもなく、出ない
    expect(codes(result)).not.toContain('otherWeekdayServices')
    expect(codes(result)).not.toContain('replacementRunsWithWeekday')
  })

  it('残すと決めていない月〜金の service があれば otherWeekdayServices に、選んだ平日の service を並べる', () => {
    const plan = multiPlan({ pairs: multiPlan().pairs!.filter((p) => p.weekday !== '01005_MSN') })
    const result = apply(multiFeed(), plan)
    expect(warning(result, 'otherWeekdayServices')).toContain('01005_MSN')
    expect(warning(result, 'otherWeekdayServices')).toContain('選んだ 01001・01001_A・01001_C・WB 以外')
  })

  it('入れ替えに使う service が平日の service と同じ日に走れば replacementRunsWithWeekday', () => {
    const base = multiFeed()
    const feed = withRows(base, 'calendar_dates', [...rows(base, 'calendar_dates'), ...rowsOf(`
service_id,date,exception_type
03001,20261104,1`)])
    const result = apply(feed, multiPlan())
    expect(warning(result, 'replacementRunsWithWeekday')).toContain('03001 と 01001:11/4')
  })

  it('期間 11/1〜:01001_C は 11/2 に走るので組を残すが、10/31 だけ走る 03001_C の便は期間に走らないため加えない(2026-11-04 の決定)', () => {
    const plan = multiPlan({ period: { start: '20261101', end: null } })
    const problems = checkPolicy(multiFeed(), plan)
    expect(problems.filter((p) => p.severity === 'error')).toEqual([])
    expect(problems.map((p) => p.code)).not.toContain('replacementNotActiveAdded')
    const skipped = problems.filter((p) => p.code === 'replacementNotActiveSkipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].severity).toBe('warning')
    expect(skipped[0].message).toContain('03001_C')
    expect(skipped[0].message).toContain('01001_C に加えません')
    // 組の入れ替えに使う service がすべて加わらないので、平日の便が代わりの便なしでなくなることを添える
    expect(skipped[0].message).toContain('01001_C の便は走る日(11/2)に代わりの便なしでなくなります')
    const result = apply(multiFeed(), plan)
    const { feed, report } = result
    expect(tripsOf(feed, '01001_C')).toEqual([])
    expect(tripsOf(feed, '03001_C')).toEqual([])
    expect(report.tripIds.derived.map((d) => d.from)).not.toContain('R1_03001_1005_C')
    expect(report.tripIds.removed).toContain('R1_01001_1000_C')
    expect(report.pairs?.[2]).toEqual({
      weekday: '01001_C',
      dropped: false,
      removed: 1,
      replacements: [{ serviceId: '03001_C', rule: 'replace-family-part', servicePartIndex: 1, added: 0, notActive: true }],
    })
    expect(warning(result, 'replacementNotActiveSkipped')).toBe(
      '新しい有効期間に1日も走らない入れ替えに使う service の便は、期間に走らないため加えませんでした(03001_C:1 便 → 01001_C)。加わる便がないため、代わりの便なしでなくなる平日の便があります(01001_C 1 便)。',
    )
    // 確かめることの一覧(validateEdit)にも出る
    expect(validateEdit(multiFeed(), result, HOLIDAYS).find((i) => i.code === 'form2.replacementNotActiveSkipped')?.file).toBe('trips.txt')
  })

  it('加えない入れ替えに使う service の便と同じ署名の平日の便は、平日に戻せる(「すでにある」にしない)', () => {
    // 03001_C の便を 01001_C の便と同じ時刻・停車にする
    const base = multiFeed()
    const cRows = rows(base, 'stop_times').filter((r) => r.trip_id === 'R1_01001_1000_C')
    const same = rows(base, 'stop_times').map((r) =>
      r.trip_id === 'R1_03001_1005_C' ? { ...cRows[Number(r.stop_sequence) - 1], trip_id: 'R1_03001_1005_C' } : r,
    )
    const feed = withRows(base, 'stop_times', same)
    const plan = { ...multiPlan({ period: { start: '20261101', end: null } }), addBackTripIds: ['R1_01001_1000_C'] }
    const { report, feed: out } = apply(feed, plan)
    expect(report.addBack.accepted).toEqual(['R1_01001_1000_C'])
    expect(report.addBack.ignoredAlreadyPresent).toEqual([])
    expect(tripsOf(out, '01001_C')).toEqual(['R1_01001_1000_C'])
  })

  it('期間 11/3〜:01001_C の組は pairWeekdayNotActive(止めない)', () => {
    const problems = checkPolicy(multiFeed(), multiPlan())
    expect(problems.filter((p) => p.severity === 'error')).toEqual([])
    const p = problems.find((x) => x.code === 'pairWeekdayNotActive')
    expect(p?.severity).toBe('warning')
    expect(p?.message).toContain('01001_C')
  })

  it('平日に戻す便の分類:組をまたぐ署名と走る日の包含(S2)、残す service の便(S3)', () => {
    const { report, feed } = apply(
      multiFeed(),
      multiPlan({
        addBackTripIds: ['R1_01001_0700', 'R1_01001_0800_K', 'R1_01001_0900_A', 'R4_01002_1300_RIT', 'R1_MS_1400', 'R1_03001_0700'],
      }),
    )
    // R1_01001_0700 は同じ組の R1_03001_0700 と同じ署名 → すでにある
    // R1_01001_0900_A は 01001 の組の R1_03001_0900 と同じ署名で、01001 は 01001_A の走る日をすべて含む → すでにある
    expect(report.addBack.ignoredAlreadyPresent).toEqual([
      { tripId: 'R1_01001_0700', sameAs: 'R1_03001_0700' },
      { tripId: 'R1_01001_0900_A', sameAs: 'R1_03001_0900' },
    ])
    // R1_01001_0800_K は 01001_A の組の R1_03001_0800_A と同じ署名だが、01001_A は 11/10 に運休するので含まない → 受け付ける
    expect(report.addBack.accepted).toEqual(['R1_01001_0800_K'])
    expect(report.addBack.alreadyKept).toEqual(['R4_01002_1300_RIT'])
    expect(report.addBack.notWeekday).toEqual(['R1_03001_0700', 'R1_MS_1400'])
    expect(tripsOf(feed, '01001')).toContain('R1_01001_0800_K')
  })

  it('除外した系統の平日便はどの組でも残し、その系統の入れ替えに使う便は加えない', () => {
    const { feed, report } = apply(multiFeed(), multiPlan({ excludedRoutes: ['R2'] }))
    expect(tripsOf(feed, 'WB')).toEqual(['R2_0900_WB'])
    expect(report.tripIds.kept).toEqual(['R2_0900_WB'])
    expect(report.pairs?.[4].replacements.map((r) => r.added)).toEqual([0, 0])
  })

  it('主の組に入れ替えに使う service が無い(名士バスの形):平日の便がなくなり、加わる便は 0', () => {
    const plan = multiPlan({
      weekdayService: '01005_MSN',
      replacementService: '',
      pairs: [{ weekday: '01005_MSN', replacements: [] }],
      keptWeekdayServices: [],
    })
    expect(checkPolicy(multiFeed(), plan).filter((p) => p.severity === 'error')).toEqual([])
    const { feed, report } = apply(multiFeed(), plan)
    expect(tripsOf(feed, '01005_MSN')).toEqual([])
    expect(report.tripIds.rule).toBe('append-service')
    expect(report.tripIds.servicePartIndex).toBeNull()
    expect(report.tripIds.derived).toEqual([])
    expect(report.tripIds.removed).toEqual(['R1_01005_1200_MSN'])
  })

  it('pairs が無いときに replacementService が空なら、今と同じく止める', () => {
    const plan = multiPlan({ weekdayService: '01005_MSN', replacementService: '', pairs: undefined, keptWeekdayServices: undefined })
    expect(checkPolicy(multiFeed(), plan).map((p) => p.code)).toContain('noReplacementTrips')
  })

  it('trip_id が重なれば全部の組で1つの集合として _2 を付ける', () => {
    // WB の組に加わる R2_1000_WB を、残す service の便の trip_id にしておく
    const base = multiFeed()
    const feed = withRows(
      withRows(base, 'trips', rows(base, 'trips').map((t) => (t.trip_id === 'R4_01002_1300_RIT' ? { ...t, trip_id: 'R2_1000_WB' } : t))),
      'stop_times',
      rows(base, 'stop_times').map((r) => (r.trip_id === 'R4_01002_1300_RIT' ? { ...r, trip_id: 'R2_1000_WB' } : r)),
    )
    const { report } = apply(feed, multiPlan())
    expect(report.tripIds.collisions).toEqual([
      { from: 'R2_1000_SB1', candidate: 'R2_1000_WB', assigned: 'R2_1000_WB_2', collidedWithService: '01002_RIT' },
    ])
  })

  it('検証:エラーが無く、祝日の確かめは便の残る平日の service で見る', () => {
    const base = multiFeed()
    const result = apply(base, multiPlan())
    const issues = validateEdit(base, result, HOLIDAYS)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    const holiday = issues.find((i) => i.code === 'holidayWithoutException')
    expect(holiday?.message).toContain('減便後の平日ダイヤ(01001・01001_A・WB)')
    // weekdayNotRunning は主の組で見る
    expect(issues.filter((i) => i.code === 'weekdayNotRunning')).toEqual([])
  })

  it('前後の比較(diffWeekdayTrips)は平日の service の集合を受け取り、組ごと除いた service の便は数えない', () => {
    const base = multiFeed()
    const result = apply(base, multiPlan())
    expect([...activeWeekdayServicesOf(result)].sort()).toEqual(['01001', '01001_A', '01005_MSN', 'WB'])
    const diff = diffWeekdayTrips(base, result.feed, activeWeekdayServicesOf(result))
    // 01001_C(期間に走らない)は組ごと除かれ、その便はなくなる便に入らない。署名は組をまたいで突き合わせる(08:00 の便は 01001 と 01001_A で同じ)
    expect(diff.removed.map((b) => b.tripId).sort()).toEqual(['R1_01005_1200_MSN', 'R2_0900_WB', 'R3_01001_0730'])
    expect(diff.added.map((b) => b.tripId).sort()).toEqual(['R1_01001_0805_K', 'R2_1000_WB', 'X1100_WB'])
    expect(diff.same.map((b) => b.tripId).sort()).toEqual(['R1_01001_0700', 'R1_01001_0800_A', 'R1_01001_0900'])
    // weekdayServicesOf(plan) をそのまま渡すと、除いた 01001_C の便までなくなる便に数える
    expect(diffWeekdayTrips(base, result.feed, weekdayServicesOf(result.plan)).removed.map((b) => b.tripId)).toContain('R1_01001_1000_C')
    // 1つの service_id を渡すと今と同じ
    expect(diffWeekdayTrips(base, result.feed, '01001').removed.map((b) => b.tripId)).toEqual(
      diffWeekdayTrips(base, result.feed, ['01001']).removed.map((b) => b.tripId),
    )
  })

  it('期間 11/1〜:01001_C の組が残れば activeWeekdayServicesOf にも入る', () => {
    const result = apply(multiFeed(), multiPlan({ period: { start: '20261101', end: null } }))
    expect(activeWeekdayServicesOf(result).has('01001_C')).toBe(true)
  })

  it('組ごと除く平日の service の便は平日に戻さない(notActive。出力に無く、trip_id も押さえない)', () => {
    // 01001_C の便の trip_id を、WB の組に加わる便の候補(X1100 → X1100_WB)と同じにしておく
    const base = multiFeed()
    const feed = withRows(
      withRows(base, 'trips', rows(base, 'trips').map((t) => (t.trip_id === 'R1_01001_1000_C' ? { ...t, trip_id: 'X1100_WB' } : t))),
      'stop_times',
      rows(base, 'stop_times').map((r) => (r.trip_id === 'R1_01001_1000_C' ? { ...r, trip_id: 'X1100_WB' } : r)),
    )
    const result = apply(feed, multiPlan({ addBackTripIds: ['X1100_WB', 'R3_01001_0730'] }))
    const { report } = result
    expect(report.addBack.notActive).toEqual(['X1100_WB'])
    expect(report.addBack.accepted).toEqual(['R3_01001_0730'])
    expect(report.tripIds.addedBack).toEqual(['R3_01001_0730'])
    // 押さえないので、加わる便は _2 を付けずに X1100_WB になる(01001_C の便は出力に無い)
    expect(report.tripIds.collisions).toEqual([])
    expect(tripsOf(result.feed, 'WB')).toEqual(['R2_1000_WB', 'X1100_WB'])
    expect(tripsOf(result.feed, '01001_C')).toEqual([])
    expect(validateEdit(feed, result, HOLIDAYS).filter((i) => i.severity === 'error')).toEqual([])
  })

  it('組ごと除く平日の service の除外した系統の便は、残した便に数えない', () => {
    const { report, feed } = apply(multiFeed(), multiPlan({ excludedRoutes: ['R1'] }))
    expect(report.tripIds.kept).toEqual(['R1_01001_0700', 'R1_01001_0800_K', 'R1_01001_0900_A', 'R1_01005_1200_MSN'])
    expect(rows(feed, 'trips').map((t) => t.trip_id)).not.toContain('R1_01001_1000_C')
  })

  it('平日に戻す判断材料:weekdayOnlyRoute は、すべての組の入れ替えに使う service の系統で見る', () => {
    const base = multiFeed()
    const result = apply(base, multiPlan())
    const diff = diffWeekdayTrips(base, result.feed, weekdayServicesOf(result.plan))
    const brief = (id: string) => diff.removed.find((b) => b.tripId === id) ?? diff.same.find((b) => b.tripId === id)!
    // R3 は平日だけの系統。R2 は WB の組の SB1・SB2 に便がある
    expect(restoreHints(base, result.feed, result.plan, brief('R3_01001_0730')).hints).toContain('weekdayOnlyRoute')
    const r2 = diffWeekdayTrips(base, result.feed, ['WB']).removed.find((b) => b.tripId === 'R2_0900_WB')!
    expect(restoreHints(base, result.feed, result.plan, r2).hints).not.toContain('weekdayOnlyRoute')
  })

  it('元のダイヤに戻す版:pairs を渡すと plan に入り、祝日の確かめに使う', () => {
    const base = multiFeed()
    const outcome = applyRevert(base, {
      ...OPTS,
      restoreFrom: '20261101',
      services: { kind: 'weekdayToSaturday', weekdayService: '01001', replacementService: '03001', pairs: multiPlan().pairs },
    })
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.result.plan.pairs?.map((p) => p.weekday)).toEqual(['01001', '01001_A', '01001_C', '01005_MSN', 'WB'])
    // 便は変えない(10/31 だけ走る 03001_C だけが除かれる)
    expect(rows(outcome.result.feed, 'trips').map((t) => t.trip_id)).toEqual(
      rows(base, 'trips').map((t) => t.trip_id).filter((id) => id !== 'R1_03001_1005_C'),
    )
    const holiday = validateEdit(base, outcome.result, HOLIDAYS).find((i) => i.code === 'holidayWithoutException')
    expect(holiday?.message).toContain('01001・01001_A・01005_MSN・WB')
  })
})

describe('checkPolicy(組の表)', () => {
  const errorCodes = (plan: Form2Plan) =>
    checkPolicy(multiFeed(), plan)
      .filter((p) => p.severity === 'error')
      .map((p) => p.code)

  it('既定の組は通る', () => {
    expect(errorCodes(multiPlan())).toEqual([])
  })

  it('組の表の先頭が weekdayService・replacementService と合わない・空なら badPairs', () => {
    expect(errorCodes(multiPlan({ weekdayService: 'WB' }))).toContain('badPairs')
    expect(errorCodes(multiPlan({ replacementService: '03001_A' }))).toContain('badPairs')
    expect(errorCodes(multiPlan({ pairs: [] }))).toEqual(['badPairs'])
  })

  it('同じ service が2つの組・2つの役割に出てくれば duplicateService(M2)', () => {
    const pairs = multiPlan().pairs!
    expect(errorCodes(multiPlan({ pairs: [...pairs.slice(0, 4), { weekday: 'WB', replacements: ['SB1', '03001'] }] }))).toEqual(['duplicateService'])
    expect(errorCodes(multiPlan({ pairs: [...pairs.slice(0, 4), { weekday: 'WB', replacements: ['SB1', 'SB1'] }] }))).toEqual(['duplicateService'])
    expect(errorCodes(multiPlan({ keptWeekdayServices: ['01002_RIT', '01005_MSN'] }))).toEqual(['duplicateService'])
    expect(errorCodes(multiPlan({ keptWeekdayServices: ['SB2'] }))).toEqual(['duplicateService'])
  })

  it('土曜・日曜にも走る平日の service を組に入れると weekdayServiceRunsOnWeekend', () => {
    expect(errorCodes(multiPlan({ pairs: [...multiPlan().pairs!, { weekday: 'MS', replacements: [] }] }))).toEqual(['weekdayServiceRunsOnWeekend'])
  })

  it('便の無い service は noWeekdayTrips・noReplacementTrips', () => {
    expect(errorCodes(multiPlan({ pairs: [...multiPlan().pairs!, { weekday: 'ZZ', replacements: ['YY'] }] }))).toEqual([
      'noWeekdayTrips',
      'noReplacementTrips',
    ])
  })

  it('月〜金にも走る service を入れ替えに使うと replacementRunsOnWeekday', () => {
    const pairs = multiPlan().pairs!
    expect(errorCodes(multiPlan({ pairs: [...pairs.slice(0, 4), { weekday: 'WB', replacements: ['SB1', 'MS'] }] }))).toEqual([
      'replacementRunsOnWeekday',
    ])
    // calendar_dates だけで平日に走る日がある service は、エラーにしない(replacementRunsWithWeekday の警告)
    const feed = withRows(multiFeed(), 'calendar_dates', [...rowsOf(MULTI_CALENDAR_DATES), ...rowsOf(`
service_id,date,exception_type
SB1,20261104,1`)])
    expect(checkPolicy(feed, multiPlan()).filter((p) => p.severity === 'error')).toEqual([])
  })

  it('期間に走らない入れ替えに使う service は、主の組でも主でない組と同じく警告で加えない(2026-11-04 の決定)', () => {
    const pairs = [
      { weekday: '01001', replacements: ['03001', '03001_C'] },
      { weekday: '01001_A', replacements: ['03001_A'] },
      { weekday: '01005_MSN', replacements: [] },
      { weekday: 'WB', replacements: ['SB1', 'SB2'] },
    ]
    const plan = multiPlan({ pairs })
    const problems = checkPolicy(multiFeed(), plan)
    expect(problems.filter((p) => p.severity === 'error')).toEqual([])
    const skipped = problems.filter((p) => p.code === 'replacementNotActiveSkipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].message).toContain('03001_C')
    expect(skipped[0].message).toContain('01001 に加えません')
    // 主の組には 03001 の便が加わるので、代わりの便なしでなくなるとは書かない
    expect(skipped[0].message).not.toContain('代わりの便なし')
    const result = apply(multiFeed(), plan)
    expect(tripsOf(result.feed, '01001')).not.toContain('R1_01001_1005_C')
    expect(result.report.pairs?.[0].replacements.map((r) => [r.serviceId, r.added > 0, r.notActive])).toEqual([
      ['03001', true, false],
      ['03001_C', false, true],
    ])
    expect(warning(result, 'replacementNotActiveSkipped')).toContain('(03001_C:1 便 → 01001)')
    expect(warning(result, 'replacementNotActiveSkipped')).not.toContain('代わりの便なし')
  })

  it('主の組の入れ替えに使う service がすべて期間に走らなければ replacementNotActive', () => {
    const pairs = [
      { weekday: '01001', replacements: ['03001_C'] },
      { weekday: 'WB', replacements: ['SB1', 'SB2'] },
    ]
    expect(errorCodes(multiPlan({ replacementService: '03001_C', pairs }))).toEqual(['replacementNotActive'])
  })

  it('入れ替えに使う service が期間の土曜に走らない日があれば、組ごとに1つの replacementPartial', () => {
    const feed = withRows(multiFeed(), 'calendar_dates', [...rowsOf(MULTI_CALENDAR_DATES), ...rowsOf(`
service_id,date,exception_type
SB1,20261107,2
SB2,20261114,2
SB2,20261121,2`)])
    const partial = checkPolicy(feed, multiPlan()).filter((p) => p.code === 'replacementPartial')
    expect(partial).toHaveLength(1)
    expect(partial[0].severity).toBe('warning')
    expect(partial[0].message).toContain('WB に便を加える')
    expect(partial[0].message).toContain('SB1:1 日(11/7)、SB2:2 日(11/14・11/21)')
    // 期間のすべての土曜に走れば出さない
    expect(checkPolicy(multiFeed(), multiPlan()).filter((p) => p.code === 'replacementPartial')).toEqual([])
  })

  it('平日の便を指す transfers の行は、主でない組の平日の service の便でも止める', () => {
    const feed = withRows(multiFeed(), 'transfers', rowsOf(`
from_stop_id,to_stop_id,transfer_type,from_trip_id,to_trip_id
A,A,1,R2_0900_WB,R1_MS_1400`))
    expect(checkPolicy(feed, multiPlan()).filter((p) => p.severity === 'error').map((p) => p.code)).toEqual(['tripReferences'])
  })

  it('除外する系統の平日の便は、すべての組の平日の service の便で見る', () => {
    expect(checkPolicy(multiFeed(), multiPlan({ excludedRoutes: ['R2', 'R4'] })).filter((p) => p.code === 'excludedRouteWithoutWeekdayTrips').map((p) => p.message)).toEqual([
      '除外する系統のうち、平日の便がない route_id があります(R4)。',
    ])
  })
})
