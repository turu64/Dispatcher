import { describe, expect, it } from 'vitest'
import { applyForm2, type Form2Result } from '../edit/form2'
import { basePlan, shiftTrip, smallFeed, withRows } from '../edit/form2.fixture'
import type { Form2Plan } from '../edit/ops'
import type { HolidayList } from '../holidays'
import type { GtfsFeed, GtfsRow } from '../load'
import { form2Texts, timingNotices, validateEdit, type ValidationIssue } from './edit'

const HOLIDAYS: HolidayList = {
  names: new Map([
    ['20261103', '文化の日'],
    ['20261123', '勤労感謝の日'],
    ['20270101', '元日'],
  ]),
  first: '19550101',
  coveredUntil: '20271231',
  source: 'テスト用の祝日一覧',
}

function apply(feed: GtfsFeed, plan: Form2Plan = basePlan()): Form2Result {
  const outcome = applyForm2(feed, plan, { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result
}

function find(issues: ValidationIssue[], code: string): ValidationIssue[] {
  return issues.filter((i) => i.code === code)
}

function errors(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error')
}

/** 編集後のフィードの表を差し替えた結果(検証の規則を確かめるため) */
function withEdited(result: Form2Result, name: string, rows: GtfsRow[]): Form2Result {
  return { ...result, feed: withRows(result.feed, name, rows) }
}

/** calendar と feed_info を 2027-01-31 までにしたフィード(年末年始を含む) */
function untilJanuary(): GtfsFeed {
  const feed = smallFeed()
  const calendar = feed.tables.get('calendar')!.rows.map((r) => ({ ...r, end_date: '20270131' }))
  const info = feed.tables.get('feed_info')!.rows.map((r) => ({ ...r, feed_end_date: '20270131' }))
  return withRows(withRows(feed, 'calendar', calendar), 'feed_info', info)
}

describe('validateEdit', () => {
  it('他の祝日に例外があるのに、平日の祝日に平日の service が走れば、例外の型を添えて警告する', () => {
    // 11/3(火)には例外があり、11/23(月)には無い
    const base = smallFeed()
    const issues = validateEdit(base, apply(base), HOLIDAYS)
    const [issue] = find(issues, 'holidayWithoutException')
    expect(issue.severity).toBe('warning')
    expect(issue.examples).toEqual(['20261123'])
    expect(issue.message).toContain('2026年11月23日(月) 勤労感謝の日')
    expect(issue.message).toContain('SA=運休、SU=運行、WK=運休')
    expect(errors(issues)).toEqual([])
  })

  it('どの祝日にも例外が無ければ情報にとどめる', () => {
    const base = withRows(smallFeed(), 'calendar_dates', [], ['service_id', 'date', 'exception_type'])
    const [issue] = find(validateEdit(base, apply(base), HOLIDAYS), 'holidayWithoutException')
    expect(issue.severity).toBe('info')
    expect(issue.examples).toEqual(['20261103', '20261123'])
    expect(issue.message).toContain('この GTFS は祝日も平日のダイヤで走る作りです')
    // 祝日一覧が無ければ確かめず、そのことを情報で出す
    const missing = validateEdit(base, apply(base), null)
    expect(find(missing, 'holidayWithoutException')).toEqual([])
    expect(find(missing, 'holidayListMissing')[0]).toMatchObject({ severity: 'info', message: '祝日一覧を読めないため、祝日の確認をしていません。' })
  })

  it('年末年始の窓の平日で、平日の service が走る日を日付で並べる', () => {
    const base = untilJanuary()
    const result = apply(base, basePlan({ period: { start: '20261201', end: null } }))
    const [issue] = find(validateEdit(base, result, HOLIDAYS), 'yearEnd')
    expect(issue.severity).toBe('warning')
    expect(issue.count).toBe(6)
    expect(issue.examples).toEqual(['20261228', '20261229', '20261230', '20261231', '20270101'])
    expect(issue.message).toContain('2027年1月4日(月)は減便後の平日ダイヤで走ります')
    // 収録の範囲の外は確かめていないことを出す
    const short: HolidayList = { ...HOLIDAYS, coveredUntil: '20261231' }
    const [uncovered] = find(validateEdit(base, result, short), 'holidayNotCovered')
    expect(uncovered).toMatchObject({ severity: 'warning', examples: ['20270101', '20270131'] })
    expect(uncovered.message).toBe('2027年1月1日〜2027年1月31日 の祝日は、内閣府の一覧にまだ無いため確かめていません。')
  })

  it('平日の service が走らない平日を、その日に走る service とあわせて並べる', () => {
    const base = smallFeed()
    const [issue] = find(validateEdit(base, apply(base), HOLIDAYS), 'weekdayNotRunning')
    expect(issue).toMatchObject({ severity: 'info', count: 1, examples: ['20261103'] })
    expect(issue.message).toContain('2026年11月3日(火):SU')
  })

  it('trip_id の重複と、参照先の無い service_id はエラーにする', () => {
    const base = smallFeed()
    const result = apply(base)
    const trips = result.feed.tables.get('trips')!.rows
    const broken = withEdited(result, 'trips', [
      ...trips,
      { ...trips[0] },
      { route_id: 'R1', service_id: 'XX', trip_id: 'R1_0700_SA_X', trip_headsign: '', block_id: '' },
    ])
    const issues = errors(validateEdit(base, broken, HOLIDAYS))
    expect(find(issues, 'duplicateTripId')[0]).toMatchObject({ file: 'trips.txt', count: 1, examples: ['R1_0700_SA'] })
    expect(find(issues, 'unknownService')[0]).toMatchObject({ count: 1, examples: ['XX'] })
    // stop_times の無い便もエラーにする
    expect(find(issues, 'tripWithoutStopTimes')[0]).toMatchObject({ examples: ['R1_0700_SA_X'] })
    expect(issues.every((i) => !i.exportOnly && !i.inherited)).toBe(true)
  })

  it('入力にある参照の欠けでは commit を止めず、入力からある問題として警告にする', () => {
    // stops に無い stop_id(ZZ)の行が基準に1つある。写す便の行なので、編集後にも残る
    const feed = smallFeed()
    const base = withRows(
      feed,
      'stop_times',
      feed.tables.get('stop_times')!.rows.map((r) => (r.trip_id === 'R1_0805_SA' && r.stop_sequence === '2' ? { ...r, stop_id: 'ZZ' } : r)),
    )
    const issues = validateEdit(base, apply(base), HOLIDAYS)
    expect(errors(issues)).toEqual([])
    const [issue] = find(issues, 'unknownStop')
    expect(issue).toMatchObject({ severity: 'warning', inherited: true, count: 1, examples: ['ZZ'] })
    expect(issue.message.startsWith('入力からある問題:')).toBe(true)
  })

  it('有効期間が 7 日以下なら、出力だけを止める error にする', () => {
    const base = smallFeed()
    const issues = validateEdit(base, apply(base, basePlan({ period: { start: '20261101', end: '20261107' } })), HOLIDAYS)
    const [issue] = errors(issues)
    expect(issue).toMatchObject({ code: 'shortValidity', severity: 'error', exportOnly: true })
    expect(issue.message).toBe(
      '有効期間が 7 日です。GTFS-JP は有効期間が 7 日以下のデータを作成しないこととしているため、出力できません。期間の開始日か終了日を変えてください。',
    )
    // Form2Report の shortValidity は form2.shortValidity として重ねて出さない
    expect(find(issues, 'form2.shortValidity')).toEqual([])
    expect(find(issues, 'validityGapAfter')[0]).toMatchObject({ severity: 'info', examples: ['20261108', '20261130'] })
  })

  it('30 日未満なら警告する', () => {
    const base = smallFeed()
    const issues = validateEdit(base, apply(base, basePlan({ period: { start: '20261102', end: null } })), HOLIDAYS)
    expect(find(issues, 'validityUnder30')[0]).toMatchObject({ severity: 'warning', message: '有効期間が 29 日です。GTFS-JP は、可能であれば 30 日以上を望ましいとしています。' })
    expect(find(issues, 'validityGapBefore')[0]).toMatchObject({ severity: 'info', count: 32, examples: ['20261001', '20261101'] })
    expect(errors(issues)).toEqual([])
    // 30 日ちょうどなら出さない
    expect(find(validateEdit(base, apply(base), HOLIDAYS), 'validityUnder30')).toEqual([])
  })

  it('基準では別の便を指していた trip_id を情報で出す', () => {
    // R1_0800_SA(C→B)の写しは R1_0800_WK で、基準の R1_0800_WK(A→B)とは別の便
    const base = smallFeed()
    const [issue] = find(validateEdit(base, apply(base), HOLIDAYS), 'tripIdReused')
    expect(issue).toMatchObject({ severity: 'info', count: 1, examples: ['R1_0800_WK'] })
    // R1_0700_SA を 07:10 にした版では、R1_0700_WK も別の便を指す
    const shifted = shiftTrip(base, 'R1_0700_SA', 600)
    const [second] = find(validateEdit(shifted, apply(shifted), HOLIDAYS), 'tripIdReused')
    expect(second.examples).toEqual(['R1_0700_WK', 'R1_0800_WK'])
  })

  it('Form2Report の警告を form2. を付けて写す', () => {
    const base = withRows(
      smallFeed(),
      'trips',
      smallFeed().tables.get('trips')!.rows.map((t) => (t.trip_id === 'R1_0805_SA' ? { ...t, block_id: 'B1' } : t)),
    )
    const issues = validateEdit(base, apply(base), HOLIDAYS)
    expect(find(issues, 'form2.blockIdCopied')[0]).toMatchObject({ severity: 'warning', file: 'trips.txt' })

    // 孤立した stop_times の行は出力から除くので、編集後には stopTimesUnknownTrip が無く、form2. の警告だけが出る
    const orphan = withRows(smallFeed(), 'stop_times', [
      ...smallFeed().tables.get('stop_times')!.rows,
      { trip_id: 'R1_0805_WK', arrival_time: '10:00:00', departure_time: '10:00:00', stop_id: 'A', stop_sequence: '3', pickup_type: '0', drop_off_type: '0' },
    ])
    const orphanIssues = validateEdit(orphan, apply(orphan), HOLIDAYS)
    expect(find(orphanIssues, 'form2.orphanStopTimesDropped')[0]).toMatchObject({ severity: 'warning', file: 'stop_times.txt' })
    expect(find(orphanIssues, 'form2.orphanStopTimesDropped')[0].message).toContain('trip_id:R1_0805_WK')
    expect(find(orphanIssues, 'stopTimesUnknownTrip')).toEqual([])
    expect(errors(orphanIssues)).toEqual([])
  })
})

describe('timingNotices', () => {
  const base = smallFeed()
  const result = apply(base)

  it('実施日まで 3 日・7 日・30 日未満で、いちばん短いものの注意を1つ出す', () => {
    const lead = (today: string) => timingNotices(result, today).filter((i) => i.code.startsWith('leadTime'))
    // 開始日は 2026-11-01
    expect(lead('20261030').map((i) => [i.code, i.severity])).toEqual([['leadTimeUnder3', 'warning']])
    expect(lead('20261030')[0].message).toContain('実施まで 2 日です。')
    expect(lead('20261029').map((i) => i.code)).toEqual(['leadTimeUnder7'])
    expect(lead('20261026').map((i) => i.code)).toEqual(['leadTimeUnder7'])
    expect(lead('20261025').map((i) => i.code)).toEqual(['leadTimeUnder30'])
    expect(lead('20261003').map((i) => i.code)).toEqual(['leadTimeUnder30'])
    expect(lead('20261002').map((i) => i.code)).toEqual([])
    // 既定の開始日は今日なので d = 0 で leadTimeUnder3
    expect(lead('20261101')[0].message).toContain('実施まで 0 日です。')
  })

  it('実施日を過ぎていれば、反映が間に合うかではなく、過ぎた日数と補い方を出す', () => {
    const lead = (today: string) => timingNotices(result, today).filter((i) => i.code.startsWith('leadTime'))
    // 開始日は 2026-11-01
    const passed = lead('20261104')
    expect(passed.map((i) => [i.code, i.severity])).toEqual([['leadTimePassed', 'warning']])
    expect(passed[0].message).toBe('実施日(2026年11月1日)を 3 日過ぎています。過ぎた日は経路検索に正しく出ていません。周知文などで補ってください。')
    expect(passed[0].message).not.toContain('静的 GTFS')
    expect(passed[0].message).not.toContain('実施まで')
    expect(lead('20261102').map((i) => i.code)).toEqual(['leadTimePassed'])
    expect(lead('20261102')[0].message).toContain('を 1 日過ぎています。')
    // 当日(d = 0)はまだ過ぎていない
    expect(lead('20261101').map((i) => i.code)).toEqual(['leadTimeUnder3'])
  })

  it('開始日が今日より先なら公開の時期を、末日が 30 日以内なら次の版を促し、公開の注意はいつも出す', () => {
    const issues = timingNotices(result, '20261020')
    expect(find(issues, 'futureStart')[0]).toMatchObject({ severity: 'info' })
    expect(find(issues, 'futureStart')[0].message).toContain('今日〜2026年10月31日 は、この ZIP を公開すると経路検索に便が出ません。')
    expect(find(issues, 'validityEndSoon')).toEqual([])
    expect(find(issues, 'publishNotes')).toHaveLength(3)
    // 開始日の前日が今日なら、同じ日を「今日〜…」と並べず「今日(…)」の1つにする
    expect(find(timingNotices(result, '20261031'), 'futureStart')[0].message).toContain(
      '今日(2026年10月31日) は、この ZIP を公開すると経路検索に便が出ません。',
    )
    const late = timingNotices(result, '20261101')
    expect(find(late, 'futureStart')).toEqual([])
    expect(find(late, 'validityEndSoon')[0]).toMatchObject({
      severity: 'warning',
      message: '2026年12月1日 から経路検索に便が出なくなります。その前に新しい版を公開してください。',
    })
  })
})

describe('form2Texts', () => {
  it('有効期間と期間の外、何が変わるかの文言に値を入れる', () => {
    const base = smallFeed()
    const texts = form2Texts(apply(base, basePlan({ addBackTripIds: ['R3_0730_WK'] })), '20261104')
    expect(texts.validity).toEqual([
      '出力する GTFS の有効期間は 2026年11月1日〜2026年11月30日(30日)です。',
      '2026年10月1日〜2026年10月31日 は出力に含まれません(過ぎた日です)。',
      '出力の有効期間は 2026年11月30日(入力の GTFS の末日)までです。減便が続くときは、次の版にも同じ方針を適用してください。',
    ])
    expect(texts.changes[0]).toBe(
      '期間の中で平日ダイヤが走る日(20日。祝日などの例外の日を除く)は、すべて土曜ダイヤ(足し戻した便と、除外した系統の便を除く)で走ります。',
    )
    expect(texts.changes).toContain('足し戻した便は学校の休業日にも走ります。休校日運休の便は GTFS では表せないため、変更指示書と周知文で補ってください。')
    const ended = form2Texts(apply(base, basePlan({ kind: 'weekdayToSundayHoliday', replacementService: 'SU', period: { start: '20261101', end: '20261120' } })), '20261020')
    expect(ended.validity[1]).toContain('2026年11月21日 以降は出力に含まれず')
    expect(ended.changes[0]).toContain('すべて日祝ダイヤ')
    expect(ended.changes.some((t) => t.includes('学校の休業日'))).toBe(false)
  })
})
