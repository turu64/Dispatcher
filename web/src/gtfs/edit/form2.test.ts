import { describe, expect, it } from 'vitest'
import type { GtfsFeed, GtfsRow } from '../load'
import { applyForm2, type Form2Result } from './form2'
import {
  basePlan,
  dohokuShapedFeed,
  renameTrip,
  rowsOf,
  smallFeed,
  withRows,
  without,
} from './form2.fixture'
import { checkPolicy, type Form2Plan } from './ops'

const OPTS = { generatedAt: '202611041200' }

function apply(feed: GtfsFeed, plan: Form2Plan): Form2Result {
  const outcome = applyForm2(feed, plan, OPTS)
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result
}

function rows(feed: GtfsFeed, name: string): GtfsRow[] {
  return feed.tables.get(name)?.rows ?? []
}

function tripIds(feed: GtfsFeed, service?: string): string[] {
  return rows(feed, 'trips')
    .filter((t) => service === undefined || t.service_id === service)
    .map((t) => t.trip_id ?? '')
}

function codes(result: Form2Result): string[] {
  return result.report.warnings.map((w) => w.code)
}

/** 夏の平日 S11(calendar 20261001〜20261031)と、その便 R1_1200_S11 を足したフィード */
function withSummerService(extraDates = ''): GtfsFeed {
  let feed = smallFeed()
  feed = withRows(feed, 'calendar', [
    ...rows(feed, 'calendar'),
    ...rowsOf(`
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
S11,1,1,1,1,1,0,0,20261001,20261031`),
  ])
  if (extraDates !== '') feed = withRows(feed, 'calendar_dates', [...rows(feed, 'calendar_dates'), ...rowsOf(extraDates)])
  feed = withRows(feed, 'trips', [...rows(feed, 'trips'), { route_id: 'R1', service_id: 'S11', trip_id: 'R1_1200_S11', trip_headsign: '市役所', block_id: '' }])
  return withRows(feed, 'stop_times', [
    ...rows(feed, 'stop_times'),
    { trip_id: 'R1_1200_S11', arrival_time: '12:00:00', departure_time: '12:00:00', stop_id: 'A', stop_sequence: '1', pickup_type: '0', drop_off_type: '1' },
    { trip_id: 'R1_1200_S11', arrival_time: '12:10:00', departure_time: '12:10:00', stop_id: 'B', stop_sequence: '2', pickup_type: '1', drop_off_type: '0' },
  ])
}

/** 写す元(SA)の calendar の期間を変えたフィード */
function withSaturdayCalendar(start: string, end: string): GtfsFeed {
  const feed = smallFeed()
  return withRows(
    feed,
    'calendar',
    rows(feed, 'calendar').map((r) => (r.service_id === 'SA' ? { ...r, start_date: start, end_date: end } : r)),
  )
}

describe('applyForm2', () => {
  it('平日の便を土曜の便に入れ替え、写した便の trip_id は service_id の部分だけを平日に変える', () => {
    const base = smallFeed()
    const { feed, report } = apply(base, basePlan())
    expect(report.tripIds.rule).toBe('replace-service-part')
    expect(report.tripIds.servicePartIndex).toBe(2)
    expect(report.tripIds.derived).toEqual([
      { from: 'R1_0700_SA', to: 'R1_0700_WK' },
      { from: 'R1_0800_SA', to: 'R1_0800_WK' },
      { from: 'R1_0805_SA', to: 'R1_0805_WK' },
      { from: 'R2_1000_SA', to: 'R2_1000_WK' },
    ])
    // 平日の便は写した便だけになり、土曜・日曜の便は残る
    expect(tripIds(feed, 'WK')).toEqual(['R1_0700_WK', 'R1_0800_WK', 'R1_0805_WK', 'R2_1000_WK'])
    expect(tripIds(feed, 'SA')).toEqual(['R1_0700_SA', 'R1_0800_SA', 'R1_0805_SA', 'R2_1000_SA'])
    expect(tripIds(feed, 'SU')).toEqual(['R1_0805_SU'])
    // trips の行は写す元のまま、trip_id と service_id だけ変える
    const copied = rows(feed, 'trips').find((t) => t.trip_id === 'R1_0805_WK')
    expect(copied).toEqual({ route_id: 'R1', service_id: 'WK', trip_id: 'R1_0805_WK', trip_headsign: '市役所', block_id: '' })
    // stop_times は写す元の行をそのまま写し、trip_id だけ変える
    expect(rows(feed, 'stop_times').filter((r) => r.trip_id === 'R1_0805_WK')).toEqual(
      rows(base, 'stop_times')
        .filter((r) => r.trip_id === 'R1_0805_SA')
        .map((r) => ({ ...r, trip_id: 'R1_0805_WK' })),
    )
    expect(report.tripIds.removed).toEqual(['R1_0700_WK', 'R1_0800_WK', 'R2_0900_WK', 'R3_0730_WK'])
    expect(report.tripIds.kept).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('写した便の trip_id が足し戻した便と重なったら、後ろに _2 を付けて重なりを残す', () => {
    const { feed, report } = apply(smallFeed(), basePlan({ addBackTripIds: ['R1_0800_WK'] }))
    expect(report.addBack.accepted).toEqual(['R1_0800_WK'])
    expect(report.tripIds.derived).toContainEqual({ from: 'R1_0800_SA', to: 'R1_0800_WK_2' })
    expect(report.tripIds.collisions).toEqual([
      { from: 'R1_0800_SA', candidate: 'R1_0800_WK', assigned: 'R1_0800_WK_2', collidedWithService: 'WK' },
    ])
    expect(tripIds(feed, 'WK')).toEqual(['R1_0700_WK', 'R1_0800_WK', 'R1_0800_WK_2', 'R1_0805_WK', 'R2_1000_WK'])
  })

  it('写した便は、消した平日便の trip_id を使ってよい', () => {
    const { feed, report } = apply(smallFeed(), basePlan())
    expect(report.tripIds.removed).toContain('R1_0700_WK')
    expect(report.tripIds.derived).toContainEqual({ from: 'R1_0700_SA', to: 'R1_0700_WK' })
    expect(report.tripIds.collisions).toEqual([])
    // 同じ trip_id は1つだけ
    expect(tripIds(feed).filter((id) => id === 'R1_0700_WK')).toHaveLength(1)
  })

  it('除外した系統の平日便はそのまま残し、その系統の土曜便は写さない', () => {
    const base = smallFeed()
    const { feed, report } = apply(base, basePlan({ excludedRoutes: ['R2'] }))
    expect(report.tripIds.kept).toEqual(['R2_0900_WK'])
    expect(report.tripIds.derived.map((d) => d.from)).not.toContain('R2_1000_SA')
    expect(tripIds(feed, 'WK')).toEqual(['R1_0700_WK', 'R1_0800_WK', 'R1_0805_WK', 'R2_0900_WK'])
    // 残した便の行は基準の行そのもの
    const keptRow = rows(base, 'trips').find((t) => t.trip_id === 'R2_0900_WK')
    expect(rows(feed, 'trips')).toContain(keptRow)
    // 土曜の便としては残る
    expect(tripIds(feed, 'SA')).toContain('R2_1000_SA')
  })

  it('足し戻した便は元の trip_id と時刻のまま残る', () => {
    const base = smallFeed()
    const { feed, report } = apply(base, basePlan({ addBackTripIds: ['R3_0730_WK'] }))
    expect(report.addBack.accepted).toEqual(['R3_0730_WK'])
    expect(report.tripIds.addedBack).toEqual(['R3_0730_WK'])
    expect(rows(feed, 'trips')).toContain(rows(base, 'trips').find((t) => t.trip_id === 'R3_0730_WK'))
    const before = rows(base, 'stop_times').filter((r) => r.trip_id === 'R3_0730_WK')
    const after = rows(feed, 'stop_times').filter((r) => r.trip_id === 'R3_0730_WK')
    expect(after).toEqual(before)
    expect(after.map((r) => r.departure_time)).toEqual(['07:30:00', '07:40:00', '07:50:00'])
  })

  it('足し戻しを分類する(重複・無い便・平日でない便・除外した系統・既にある便・受け付け)', () => {
    const { report } = apply(
      smallFeed(),
      basePlan({
        excludedRoutes: ['R2'],
        addBackTripIds: ['R3_0730_WK', 'R3_0730_WK', 'NONE', 'NONE', 'R1_0805_SA', 'R2_0900_WK', 'R1_0700_WK', 'R1_0800_WK'],
      }),
    )
    expect(report.addBack).toEqual({
      requested: 8,
      accepted: ['R1_0800_WK', 'R3_0730_WK'],
      ignoredExcludedRoute: ['R2_0900_WK'],
      // R1_0700_WK は土曜の R1_0700_SA と同じ時刻・停留所なので、写す便として既にある
      ignoredAlreadyPresent: [{ tripId: 'R1_0700_WK', sameAs: 'R1_0700_SA' }],
      notWeekday: ['R1_0805_SA'],
      notFound: ['NONE'],
      // 重複は「無い便」より先に調べるので、無い便の2回目も重複になる
      duplicate: ['NONE', 'R3_0730_WK'],
    })

    // 先に受け付けた便と同じ署名の便は、受け付けた便を sameAs にする
    let feed = smallFeed()
    feed = withRows(feed, 'trips', [...rows(feed, 'trips'), { route_id: 'R3', service_id: 'WK', trip_id: 'R3_0730x_WK', trip_headsign: '市役所', block_id: '' }])
    feed = withRows(feed, 'stop_times', [
      ...rows(feed, 'stop_times'),
      ...rows(feed, 'stop_times')
        .filter((r) => r.trip_id === 'R3_0730_WK')
        .map((r) => ({ ...r, trip_id: 'R3_0730x_WK' })),
    ])
    const second = apply(feed, basePlan({ addBackTripIds: ['R3_0730_WK', 'R3_0730x_WK'] })).report.addBack
    expect(second.accepted).toEqual(['R3_0730_WK'])
    expect(second.ignoredAlreadyPresent).toEqual([{ tripId: 'R3_0730x_WK', sameAs: 'R3_0730_WK' }])
  })

  it('有効期間を期間に合わせ、calendar を切り詰め、期間の外の calendar_dates を除く', () => {
    const base = smallFeed()
    const { feed, report } = apply(base, basePlan())
    expect(report.inputValidity).toEqual({ start: '20261001', end: '20261130' })
    expect(report.validity).toEqual({ start: '20261101', end: '20261130', days: 30 })
    expect(rows(feed, 'calendar').map((r) => [r.service_id, r.start_date, r.end_date])).toEqual([
      ['SA', '20261101', '20261130'],
      ['SU', '20261101', '20261130'],
      ['WK', '20261101', '20261130'],
    ])
    expect(report.calendarDates).toEqual({
      kept: 3,
      dropped: [
        { service_id: 'WK', date: '20261012', exception_type: '2' },
        { service_id: 'SA', date: '20261012', exception_type: '2' },
        { service_id: 'SU', date: '20261012', exception_type: '1' },
      ],
    })
    // 残る行は中身を変えない(祝日の例外もそのまま)
    expect(rows(feed, 'calendar_dates')).toEqual(rows(base, 'calendar_dates').filter((r) => r.date === '20261103'))
    const info = rows(feed, 'feed_info')[0]
    expect([info.feed_start_date, info.feed_end_date]).toEqual(['20261101', '20261130'])
    expect(report.droppedServices).toEqual([])
  })

  it('期間の終わりを指定すると、有効期間はその日で終わる', () => {
    const { feed, report } = apply(smallFeed(), basePlan({ period: { start: '20261101', end: '20261115' } }))
    expect(report.validity).toEqual({ start: '20261101', end: '20261115', days: 15 })
    expect(rows(feed, 'calendar').every((r) => r.start_date === '20261101' && r.end_date === '20261115')).toBe(true)
    expect(rows(feed, 'feed_info')[0].feed_end_date).toBe('20261115')
    expect(rows(feed, 'calendar_dates').map((r) => r.date)).toEqual(['20261103', '20261103', '20261103'])
  })

  it('期間の開始日が入力の開始日より前なら、入力の開始日にそろえて警告する', () => {
    const { feed, report } = apply(smallFeed(), basePlan({ period: { start: '20260901', end: '20261231' } }))
    expect(report.validity).toEqual({ start: '20261001', end: '20261130', days: 61 })
    expect(codes({ report } as Form2Result)).toEqual(['periodStartClamped', 'periodEndClamped'])
    // 期間が入力の有効期間の全体を覆うので、calendar と calendar_dates は変わらない
    expect(rows(feed, 'calendar')).toEqual(rows(smallFeed(), 'calendar'))
    expect(report.calendarDates.kept).toBe(6)
  })

  it('feed_info に日付が無ければ、開始は start_date と date の最小、末日は end_date と date の最大にする(start_date > end_date の行があっても末日を延ばさない)', () => {
    let feed = smallFeed()
    feed = withRows(feed, 'feed_info', rows(feed, 'feed_info').map((r) => ({ ...r, feed_start_date: '', feed_end_date: '' })))
    // 日曜の行を start_date 20261210 > end_date 20261001 の誤った行にする(参照実装の fuzz の m2_validity_pool と同じ形)
    feed = withRows(
      feed,
      'calendar',
      rows(feed, 'calendar').map((r) => (r.service_id === 'SU' ? { ...r, start_date: '20261210', end_date: '20261001' } : r)),
    )
    const { feed: out, report } = apply(feed, basePlan())
    expect(report.inputValidity).toEqual({ start: '20261001', end: '20261130' })
    expect(report.validity).toEqual({ start: '20261101', end: '20261130', days: 30 })
    const info = rows(out, 'feed_info')[0]
    expect([info.feed_start_date, info.feed_end_date]).toEqual(['20261101', '20261130'])
    // 出力の calendar のどの行も、feed_info の末日を越えない
    expect(rows(out, 'calendar').every((r) => (r.end_date ?? '') <= '20261130')).toBe(true)
  })

  it('有効期間が 7 日以下なら警告を残す(出力を止めるのは validateEdit)', () => {
    // 11/1(日)〜11/7(土)。写す元の土曜の便が走る日を含む
    const outcome = applyForm2(smallFeed(), basePlan({ period: { start: '20261101', end: '20261107' } }), OPTS)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.report.validity.days).toBe(7)
    expect(codes(outcome.result)).toEqual(['shortValidity'])
    expect(outcome.result.report.warnings[0].message).toContain('有効期間が 7 日です')
  })

  it('feed_version は 12 桁なら作成日時にし、それ以外は _dispatcher_ と作成日時を付ける', () => {
    const versionOf = (version: string) => {
      const feed = smallFeed()
      const withVersion = withRows(feed, 'feed_info', [{ ...rows(feed, 'feed_info')[0], feed_version: version }])
      return apply(withVersion, basePlan())
    }
    const twelve = apply(smallFeed(), basePlan())
    expect(twelve.report.feedVersion).toEqual({ before: '202609171038', after: '202611041200' })
    expect(rows(twelve.feed, 'feed_info')[0].feed_version).toBe('202611041200')
    expect(versionOf('2026.10 改正').report.feedVersion.after).toBe('2026.10 改正_dispatcher_202611041200')
    expect(versionOf('').report.feedVersion.after).toBe('202611041200')
    // 入力が 12 桁で、新しい値が入力以下なら警告
    const later = versionOf('209912312359')
    expect(later.report.feedVersion.after).toBe('202611041200')
    expect(codes(later)).toEqual(['feedVersionNotIncreasing'])
  })

  it('feed_info が無ければ agency から作って警告する', () => {
    const base = without(smallFeed(), 'feed_info')
    const { feed, report } = apply(base, basePlan())
    const table = feed.tables.get('feed_info')
    expect(table?.fileName).toBe('feed_info.txt')
    expect(table?.fields).toEqual(['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version'])
    expect(table?.rows).toEqual([
      {
        feed_publisher_name: 'テストバス',
        feed_publisher_url: 'https://example.jp/',
        feed_lang: 'ja',
        feed_start_date: '20261101',
        feed_end_date: '20261130',
        feed_version: '202611041200',
      },
    ])
    expect(codes({ report } as Form2Result)).toEqual(['feedInfoCreated'])
    // 入力の有効期間は calendar と calendar_dates から決める
    expect(report.inputValidity).toEqual({ start: '20261001', end: '20261130' })

    // 列が無ければ後ろに足して警告する
    const noColumns = smallFeed()
    const info = rows(noColumns, 'feed_info')[0]
    const partial = withRows(noColumns, 'feed_info', [{ feed_publisher_name: info.feed_publisher_name, feed_lang: 'ja' }], ['feed_publisher_name', 'feed_lang'])
    const added = apply(partial, basePlan())
    expect(added.feed.tables.get('feed_info')?.fields).toEqual(['feed_publisher_name', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version'])
    expect(codes(added)).toEqual(['feedInfoColumnsAdded'])
  })

  it('有効期間に運行日が残らない service の便は、出力から除いて警告する', () => {
    const { feed, report } = apply(withSummerService(), basePlan())
    expect(report.droppedServices).toEqual([{ serviceId: 'S11', trips: 1 }])
    expect(codes({ report } as Form2Result)).toEqual(['calendarRowDropped', 'servicesDropped'])
    expect(tripIds(feed)).not.toContain('R1_1200_S11')
    expect(rows(feed, 'stop_times').some((r) => r.trip_id === 'R1_1200_S11')).toBe(false)
    expect(rows(feed, 'calendar').map((r) => r.service_id)).toEqual(['SA', 'SU', 'WK'])
  })

  it('例外の行だけが期間内に残っても、走る日が無い service は除き、その例外の行も除く', () => {
    const { feed, report } = apply(
      withSummerService(`
service_id,date,exception_type
S11,20261103,2`),
      basePlan(),
    )
    expect(report.droppedServices).toEqual([{ serviceId: 'S11', trips: 1 }])
    expect(rows(feed, 'calendar_dates').some((r) => r.service_id === 'S11')).toBe(false)
    expect(report.calendarDates.dropped).toContainEqual({ service_id: 'S11', date: '20261103', exception_type: '2' })
    expect(report.calendarDates.kept).toBe(3)
    expect(tripIds(feed)).not.toContain('R1_1200_S11')
  })

  it('写す元の service が新しい有効期間に1日も走らなければ、方針を適用しない', () => {
    const feed = withSaturdayCalendar('20261001', '20261031')
    expect(checkPolicy(feed, basePlan()).filter((p) => p.severity === 'error').map((p) => p.code)).toEqual(['replacementNotActive'])
    const outcome = applyForm2(feed, basePlan(), OPTS)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('1日も走りません')
  })

  it('写す元の service が新しい有効期間の一部しか覆わなければ警告する', () => {
    const feed = withSaturdayCalendar('20261001', '20261115')
    const problems = checkPolicy(feed, basePlan())
    expect(problems.filter((p) => p.severity === 'error')).toEqual([])
    expect(problems.map((p) => p.code)).toContain('replacementPartial')
    expect(applyForm2(feed, basePlan(), OPTS).ok).toBe(true)
  })

  it('平日の便を指す transfers の行があれば、方針を適用しない', () => {
    const feed = withRows(
      smallFeed(),
      'transfers',
      rowsOf(`
from_stop_id,to_stop_id,transfer_type,from_trip_id,to_trip_id
A,A,1,R1_0700_WK,R1_0805_SU`),
    )
    expect(checkPolicy(feed, basePlan()).map((p) => p.code)).toContain('tripReferences')
    const outcome = applyForm2(feed, basePlan(), OPTS)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('transfers.txt 1 行')
    // 平日の便を指さない行なら適用できる
    const other = withRows(
      smallFeed(),
      'transfers',
      rowsOf(`
from_stop_id,to_stop_id,transfer_type,from_trip_id,to_trip_id
A,A,1,R1_0700_SA,R1_0805_SU`),
    )
    expect(applyForm2(other, basePlan(), OPTS).ok).toBe(true)
  })

  it('基準のフィードを書き換えない(行を凍結して適用してもエラーにならず、変えない表は同じ参照)', () => {
    const base = smallFeed()
    for (const table of base.tables.values()) {
      for (const row of table.rows) Object.freeze(row)
      Object.freeze(table.rows)
      Object.freeze(table.fields)
      Object.freeze(table)
    }
    Object.freeze(base.tables)
    const snapshot = JSON.stringify([...base.tables.entries()])
    const { feed } = apply(base, basePlan({ excludedRoutes: ['R2'], addBackTripIds: ['R1_0800_WK', 'R3_0730_WK'] }))
    expect(JSON.stringify([...base.tables.entries()])).toBe(snapshot)
    for (const name of ['agency', 'routes', 'stops']) expect(feed.tables.get(name)).toBe(base.tables.get(name))
    for (const name of ['trips', 'stop_times', 'calendar', 'calendar_dates', 'feed_info']) {
      expect(feed.tables.get(name)).not.toBe(base.tables.get(name))
    }
    expect(feed.warnings).toEqual([])
  })

  it('基準に無い calendar.txt を作らない', () => {
    let base = without(smallFeed(), 'calendar')
    base = withRows(
      base,
      'calendar_dates',
      rowsOf(`
service_id,date,exception_type
WK,20261012,1
WK,20261102,1
WK,20261104,1
SA,20261107,1
SU,20261108,1`),
    )
    const { feed, report } = apply(base, basePlan())
    expect(feed.tables.has('calendar')).toBe(false)
    expect(report.inputValidity).toEqual({ start: '20261001', end: '20261130' })
    expect(rows(feed, 'calendar_dates').map((r) => `${r.service_id},${r.date}`)).toEqual(['WK,20261102', 'WK,20261104', 'SA,20261107', 'SU,20261108'])
    expect(tripIds(feed, 'WK')).toEqual(['R1_0700_WK', 'R1_0800_WK', 'R1_0805_WK', 'R2_1000_WK'])
  })

  it('trip_id の service_id の部分が見つからなければ、後ろに平日の service_id を付ける', () => {
    const base = renameTrip(smallFeed(), 'R1_0805_SA', 'X0805')
    const { report } = apply(base, basePlan())
    expect(report.tripIds.rule).toBe('append-service')
    expect(report.tripIds.servicePartIndex).toBeNull()
    expect(report.tripIds.derived).toEqual([
      { from: 'R1_0700_SA', to: 'R1_0700_SA_WK' },
      { from: 'R1_0800_SA', to: 'R1_0800_SA_WK' },
      { from: 'R2_1000_SA', to: 'R2_1000_SA_WK' },
      { from: 'X0805', to: 'X0805_WK' },
    ])
  })

  it('固定の部分が平日の service_id と同じでも、service_id の部分の位置を取り違えない', () => {
    const { report } = apply(
      dohokuShapedFeed(),
      { kind: 'weekdayToSaturday', weekdayService: '01', replacementService: '03', period: { start: '20261101', end: null }, excludedRoutes: [], addBackTripIds: [] },
    )
    expect(report.tripIds.servicePartIndex).toBe(3)
    expect(report.tripIds.derived).toEqual([{ from: '0026_01_01_03_0705', to: '0026_01_01_01_0705' }])
  })

  it('日曜の便の trip_id が写す便の候補と同じなら、後ろに _2 を付ける', () => {
    const base = renameTrip(smallFeed(), 'R1_0805_SU', 'R1_0805_WK')
    const { feed, report } = apply(base, basePlan())
    // id の付け方の見つけ方は平日と写す元の便だけを見るので、見つけ方は変わらない
    expect(report.tripIds.servicePartIndex).toBe(2)
    expect(report.tripIds.collisions).toEqual([
      { from: 'R1_0805_SA', candidate: 'R1_0805_WK', assigned: 'R1_0805_WK_2', collidedWithService: 'SU' },
    ])
    expect(tripIds(feed, 'SU')).toEqual(['R1_0805_WK'])
    expect(tripIds(feed, 'WK')).toContain('R1_0805_WK_2')
  })

  it('入力が (service_id, trip_id) の順なら出力も同じ順にし、stop_times は trips の順にまとめる', () => {
    const { feed, report } = apply(smallFeed(), basePlan({ addBackTripIds: ['R3_0730_WK'] }))
    expect(report.rowOrder).toEqual({ trips: 'service_id,trip_id', stop_times: 'trips' })
    const trips = rows(feed, 'trips').map((t) => `${t.service_id},${t.trip_id}`)
    expect(trips).toEqual([
      'SA,R1_0700_SA',
      'SA,R1_0800_SA',
      'SA,R1_0805_SA',
      'SA,R2_1000_SA',
      'SU,R1_0805_SU',
      'WK,R1_0700_WK',
      'WK,R1_0800_WK',
      'WK,R1_0805_WK',
      'WK,R2_1000_WK',
      'WK,R3_0730_WK',
    ])
    // stop_times は出力の trips の順に便ごとにまとまり、便の中は入力の行の順
    const order: string[] = []
    for (const r of rows(feed, 'stop_times')) if (order[order.length - 1] !== r.trip_id) order.push(r.trip_id ?? '')
    expect(order).toEqual(rows(feed, 'trips').map((t) => t.trip_id))
    expect(rows(feed, 'stop_times').filter((r) => r.trip_id === 'R3_0730_WK').map((r) => r.stop_sequence)).toEqual(['1', '2', '3'])

    // どちらの順でもなければ、入力の順のまま写した便を後ろに足す
    const shuffled = smallFeed()
    const trips2 = rows(shuffled, 'trips')
    const reordered = withRows(shuffled, 'trips', [trips2[5], ...trips2.slice(0, 5), ...trips2.slice(6)])
    const second = apply(reordered, basePlan())
    expect(second.report.rowOrder).toEqual({ trips: 'input', stop_times: 'input' })
    expect(tripIds(second.feed)).toEqual([
      'R1_0700_SA',
      'R1_0800_SA',
      'R1_0805_SA',
      'R2_1000_SA',
      'R1_0805_SU',
      'R1_0700_WK',
      'R1_0800_WK',
      'R1_0805_WK',
      'R2_1000_WK',
    ])
    const stOrder: string[] = []
    for (const r of rows(second.feed, 'stop_times')) if (stOrder[stOrder.length - 1] !== r.trip_id) stOrder.push(r.trip_id ?? '')
    expect(stOrder).toEqual(['R1_0700_SA', 'R1_0800_SA', 'R1_0805_SA', 'R2_1000_SA', 'R1_0805_SU', 'R1_0700_WK', 'R1_0800_WK', 'R1_0805_WK', 'R2_1000_WK'])
  })
})
