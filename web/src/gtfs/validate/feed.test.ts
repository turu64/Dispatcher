import { describe, expect, it } from 'vitest'
import { applyForm2, type Form2Result } from '../edit/form2'
import { basePlan, rowsOf, smallFeed, withRows } from '../edit/form2.fixture'
import type { Form2Plan } from '../edit/ops'
import type { GtfsFeed, GtfsRow } from '../load'
import { validateEdit, type ValidationIssue } from './edit'

// 検証器の規則(feed.ts)を、手で作る小さなフィード(form2.fixture.ts の smallFeed)で確かめる。
// 規則ごとに、編集後の表を壊したときに出ること、基準にも同じ問題があれば入力からある問題に分けることを見る。

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

function withEdited(result: Form2Result, name: string, rows: GtfsRow[]): Form2Result {
  return { ...result, feed: withRows(result.feed, name, rows) }
}

function withoutTables(feed: GtfsFeed, ...names: string[]): GtfsFeed {
  return { ...feed, tables: new Map([...feed.tables].filter(([name]) => !names.includes(name))) }
}

function rows(feed: GtfsFeed, name: string): GtfsRow[] {
  return feed.tables.get(name)!.rows
}

/** 編集後の stop_times の、便 tripId の stop_sequence が seq の行を書き換える */
function patchStopTime(result: Form2Result, tripId: string, seq: string, patch: GtfsRow): Form2Result {
  return withEdited(
    result,
    'stop_times',
    rows(result.feed, 'stop_times').map((r) => (r.trip_id === tripId && r.stop_sequence === seq ? { ...r, ...patch } : r)),
  )
}

describe('既定の場面', () => {
  it('smallFeed の既定の方針では、新しい規則の error も warning も出ない', () => {
    const base = smallFeed()
    const issues = validateEdit(base, apply(base), null)
    expect(errors(issues).map((i) => i.code)).toEqual([])
    for (const code of ['feedInfoRows', 'calendarBeyondFeedInfo', 'calendarOutsideValidity', 'timeFormatVariant', 'signatureColumnMismatch']) {
      expect(find(issues, code)).toEqual([])
    }
  })
})

describe('requiredFileMissing', () => {
  it('必須のファイルが無ければ error にし、calendar と calendar_dates はどちらかがあればよい', () => {
    const base = smallFeed()
    const result = apply(base)
    const broken = { ...result, feed: withoutTables(result.feed, 'agency', 'stops', 'calendar') }
    const [issue] = find(validateEdit(base, broken, null), 'requiredFileMissing')
    expect(issue).toMatchObject({ severity: 'error', count: 2, examples: ['agency.txt', 'stops.txt'] })
    expect(issue.message).toBe('GTFS-JP で必須のファイルがありません(2 件)。')

    const noCalendar = { ...result, feed: withoutTables(result.feed, 'calendar', 'calendar_dates') }
    expect(find(validateEdit(base, noCalendar, null), 'requiredFileMissing')[0].examples).toEqual(['calendar.txt または calendar_dates.txt'])
  })

  it('入力にも無いファイルは、入力からある問題として警告にする', () => {
    const base = withoutTables(smallFeed(), 'agency')
    const issues = validateEdit(base, apply(base), null)
    expect(errors(issues)).toEqual([])
    const [issue] = find(issues, 'requiredFileMissing')
    expect(issue).toMatchObject({ severity: 'warning', inherited: true, examples: ['agency.txt'] })
    expect(issue.message.startsWith('入力からある問題:')).toBe(true)
  })

  it('feed_info.txt が無い入力では、作った feed_info があるので出さない', () => {
    const base = withoutTables(smallFeed(), 'feed_info')
    expect(find(validateEdit(base, apply(base), null), 'requiredFileMissing')).toEqual([])
  })
})

describe('badCalendarDate', () => {
  it('date が正しい日付でない行と、exception_type が 1・2 以外の行を error にする', () => {
    const base = smallFeed()
    const result = apply(base)
    const broken = withEdited(result, 'calendar_dates', [
      ...rows(result.feed, 'calendar_dates'),
      { service_id: 'WK', date: '20261131', exception_type: '2' },
      { service_id: 'SA', date: '20261110', exception_type: '3' },
      { service_id: 'SU', date: '20261111', exception_type: '' },
    ])
    const [issue] = find(validateEdit(base, broken, null), 'badCalendarDate')
    expect(issue).toMatchObject({ severity: 'error', file: 'calendar_dates.txt', count: 3, examples: ['SA 20261110', 'SU 20261111', 'WK 20261131'] })
  })

  it('入力にも同じ行があれば、入力からある問題にする', () => {
    // 期間の中の行なので出力に残る
    const feed = smallFeed()
    const base = withRows(feed, 'calendar_dates', [...rows(feed, 'calendar_dates'), { service_id: 'SU', date: '20261115', exception_type: '0' }])
    const issues = validateEdit(base, apply(base), null)
    expect(errors(issues)).toEqual([])
    expect(find(issues, 'badCalendarDate')[0]).toMatchObject({ severity: 'warning', inherited: true, examples: ['SU 20261115'] })
  })
})

describe('badTimeFormat と timeFormatVariant', () => {
  it('HH:MM:SS でない時刻を error にする。24時を超える時刻と空(通過)は許す', () => {
    const base = smallFeed()
    // R3_0730_WK(3停留所)は平日だけの便なので、足し戻して出力に残す
    let result = apply(base, basePlan({ addBackTripIds: ['R3_0730_WK'] }))
    result = patchStopTime(result, 'R1_0700_WK', '1', { arrival_time: '7:5:00' })
    result = patchStopTime(result, 'R1_0800_WK', '2', { departure_time: '08:60:00' })
    result = patchStopTime(result, 'R1_0805_SA', '1', { arrival_time: '0805' })
    result = patchStopTime(result, 'R1_0805_SU', '1', { arrival_time: '25:10:00', departure_time: '25:10:00' })
    result = patchStopTime(result, 'R3_0730_WK', '2', { arrival_time: '', departure_time: '' })
    const issues = validateEdit(base, result, null)
    const [issue] = find(issues, 'badTimeFormat')
    expect(issue).toMatchObject({ severity: 'error', file: 'stop_times.txt', count: 3, examples: ['R1_0700_WK', 'R1_0800_WK', 'R1_0805_SA'] })
    expect(find(issues, 'timeFormatVariant')).toEqual([])
  })

  it('時が1桁の時刻や前後の空白は、書き方の違いとして警告する', () => {
    const base = smallFeed()
    let result = apply(base)
    result = patchStopTime(result, 'R1_0700_WK', '1', { arrival_time: '7:00:00', departure_time: '7:00:00' })
    result = patchStopTime(result, 'R2_1000_SA', '2', { arrival_time: ' 10:20:00' })
    const issues = validateEdit(base, result, null)
    expect(find(issues, 'badTimeFormat')).toEqual([])
    const [issue] = find(issues, 'timeFormatVariant')
    expect(issue).toMatchObject({ severity: 'warning', count: 2, examples: ['R1_0700_WK', 'R2_1000_SA'] })
    expect(issue.message).toContain('時が1桁')
  })

  it('写す元の便にある時刻の誤りは、写した便でも入力からある問題にする', () => {
    // R1_0805_SA の写しは R1_0805_WK(新しい trip_id)
    const feed = smallFeed()
    const base = withRows(
      feed,
      'stop_times',
      rows(feed, 'stop_times').map((r) => (r.trip_id === 'R1_0805_SA' && r.stop_sequence === '2' ? { ...r, arrival_time: '8:15' } : r)),
    )
    const result = apply(base)
    expect(result.report.tripIds.derived).toContainEqual({ from: 'R1_0805_SA', to: 'R1_0805_WK' })
    const issues = validateEdit(base, result, null)
    expect(errors(issues)).toEqual([])
    expect(find(issues, 'badTimeFormat')[0]).toMatchObject({ severity: 'warning', inherited: true, count: 2, examples: ['R1_0805_SA', 'R1_0805_WK'] })
  })
})

describe('stopSequenceNotIncreasing', () => {
  it('同じ stop_sequence の行がある便と、読めない値のある便を error にする', () => {
    const base = smallFeed()
    let result = apply(base)
    result = patchStopTime(result, 'R1_0805_SU', '2', { stop_sequence: '1' })
    result = patchStopTime(result, 'R1_0700_WK', '2', { stop_sequence: '-1' })
    // 先頭の 0 を除くと同じ値
    result = patchStopTime(result, 'R2_1000_SA', '2', { stop_sequence: '01' })
    // 行の順が逆でも、値が増えていけばよい
    result = withEdited(result, 'stop_times', [...rows(result.feed, 'stop_times')].reverse())
    const [issue] = find(validateEdit(base, result, null), 'stopSequenceNotIncreasing')
    expect(issue).toMatchObject({ severity: 'error', count: 3, examples: ['R1_0700_WK', 'R1_0805_SU', 'R2_1000_SA'] })
  })
})

describe('stopTimesEndpointBlank', () => {
  it('最初か最後の停留所の時刻が空の便を error にする。途中の停留所の空(通過)は許す', () => {
    const base = smallFeed()
    // R3_0730_WK(3停留所)は平日だけの便なので、足し戻して出力に残す
    let result = apply(base, basePlan({ addBackTripIds: ['R3_0730_WK'] }))
    result = patchStopTime(result, 'R1_0700_WK', '1', { arrival_time: '' })
    result = patchStopTime(result, 'R1_0805_SU', '2', { departure_time: ' ' })
    result = patchStopTime(result, 'R3_0730_WK', '2', { arrival_time: '', departure_time: '' })
    // 行の順が逆でも、stop_sequence の順で最初と最後を決める
    result = withEdited(result, 'stop_times', [...rows(result.feed, 'stop_times')].reverse())
    const issues = validateEdit(base, result, null)
    const [issue] = find(issues, 'stopTimesEndpointBlank')
    expect(issue).toMatchObject({ severity: 'error', file: 'stop_times.txt', count: 2, examples: ['R1_0700_WK', 'R1_0805_SU'] })
    expect(issue.message).toContain('最初と最後の停留所の時刻は必須')
    expect(find(issues, 'badTimeFormat')).toEqual([])
  })

  it('写す元の便にある空の時刻は、写した便でも入力からある問題にする', () => {
    const feed = smallFeed()
    const base = withRows(
      feed,
      'stop_times',
      rows(feed, 'stop_times').map((r) => (r.trip_id === 'R1_0805_SA' && r.stop_sequence === '1' ? { ...r, arrival_time: '' } : r)),
    )
    const issues = validateEdit(base, apply(base), null)
    expect(errors(issues)).toEqual([])
    expect(find(issues, 'stopTimesEndpointBlank')[0]).toMatchObject({ severity: 'warning', inherited: true, count: 2, examples: ['R1_0805_SA', 'R1_0805_WK'] })
  })
})

describe('stopTimesDecreasing', () => {
  it('stop_sequence の順に時刻が戻る便と、出発が到着より早い行のある便を error にする', () => {
    const base = smallFeed()
    let result = apply(base, basePlan({ addBackTripIds: ['R3_0730_WK'] }))
    // 前の停留所(07:00)より早い
    result = patchStopTime(result, 'R1_0700_WK', '2', { arrival_time: '06:59:00', departure_time: '06:59:00' })
    // 同じ行で出発が到着より早い
    result = patchStopTime(result, 'R2_1000_SA', '1', { departure_time: '09:59:00' })
    // 途中の空(通過)を飛ばして、1番目(07:30)と比べる
    result = patchStopTime(result, 'R3_0730_WK', '2', { arrival_time: '', departure_time: '' })
    result = patchStopTime(result, 'R3_0730_WK', '3', { arrival_time: '07:20:00', departure_time: '07:20:00' })
    // 24時をまたぐ便(23:55 → 24:05)と、前の停留所と同じ時刻は戻っていない
    result = patchStopTime(result, 'R1_0805_SU', '1', { arrival_time: '23:55:00', departure_time: '23:55:00' })
    result = patchStopTime(result, 'R1_0805_SU', '2', { arrival_time: '24:05:00', departure_time: '24:05:00' })
    result = patchStopTime(result, 'R1_0800_WK', '2', { arrival_time: '08:00:00', departure_time: '08:00:00' })
    result = withEdited(result, 'stop_times', [...rows(result.feed, 'stop_times')].reverse())
    const issues = validateEdit(base, result, null)
    const [issue] = find(issues, 'stopTimesDecreasing')
    expect(issue).toMatchObject({ severity: 'error', file: 'stop_times.txt', count: 3, examples: ['R1_0700_WK', 'R2_1000_SA', 'R3_0730_WK'] })
    expect(find(issues, 'badTimeFormat')).toEqual([])
  })

  it('正しくない時刻は badTimeFormat に任せ、比べない', () => {
    const base = smallFeed()
    const result = patchStopTime(apply(base), 'R1_0700_WK', '2', { arrival_time: '0659' })
    const issues = validateEdit(base, result, null)
    expect(find(issues, 'stopTimesDecreasing')).toEqual([])
    expect(find(issues, 'badTimeFormat')[0]).toMatchObject({ examples: ['R1_0700_WK'] })
  })

  it('写す元の便で時刻が戻っていれば、写した便でも入力からある問題にする', () => {
    const feed = smallFeed()
    const base = withRows(
      feed,
      'stop_times',
      rows(feed, 'stop_times').map((r) =>
        r.trip_id === 'R1_0805_SA' && r.stop_sequence === '2' ? { ...r, arrival_time: '08:00:00', departure_time: '08:00:00' } : r,
      ),
    )
    const issues = validateEdit(base, apply(base), null)
    expect(errors(issues)).toEqual([])
    expect(find(issues, 'stopTimesDecreasing')[0]).toMatchObject({ severity: 'warning', inherited: true, count: 2, examples: ['R1_0805_SA', 'R1_0805_WK'] })
  })
})

describe('badCalendarWeekday', () => {
  it('monday〜sunday が 0・1 以外の行を error にする', () => {
    const base = smallFeed()
    const result = apply(base)
    const broken = withEdited(
      result,
      'calendar',
      rows(result.feed, 'calendar').map((r) => (r.service_id === 'WK' ? { ...r, monday: '2' } : r.service_id === 'SA' ? { ...r, sunday: '' } : r)),
    )
    const [issue] = find(validateEdit(base, broken, null), 'badCalendarWeekday')
    expect(issue).toMatchObject({ severity: 'error', file: 'calendar.txt', count: 2, examples: ['SA', 'WK'] })
  })

  it('入力にも同じ行があれば、入力からある問題にする', () => {
    const feed = smallFeed()
    const base = withRows(
      feed,
      'calendar',
      rows(feed, 'calendar').map((r) => (r.service_id === 'SU' ? { ...r, saturday: 'no' } : r)),
    )
    const issues = validateEdit(base, apply(base), null)
    expect(errors(issues)).toEqual([])
    expect(find(issues, 'badCalendarWeekday')[0]).toMatchObject({ severity: 'warning', inherited: true, examples: ['SU'] })
  })
})

describe('stopIdChanged と routeIdChanged', () => {
  it('入力の stops・routes の id が出力から消えれば error にする', () => {
    const base = smallFeed()
    let result = apply(base)
    // S9・R3 は出力では使われないので、unknownStop・unknownRoute には当たらない
    result = withEdited(result, 'stops', rows(result.feed, 'stops').map((s) => (s.stop_id === 'S9' ? { ...s, stop_id: 'S9_new' } : s)))
    result = withEdited(result, 'routes', rows(result.feed, 'routes').filter((r) => r.route_id !== 'R3'))
    const issues = errors(validateEdit(base, result, null))
    expect(issues.map((i) => i.code).sort()).toEqual(['routeIdChanged', 'stopIdChanged'])
    expect(find(issues, 'stopIdChanged')[0]).toMatchObject({ file: 'stops.txt', count: 1, examples: ['S9'] })
    expect(find(issues, 'routeIdChanged')[0]).toMatchObject({ file: 'routes.txt', count: 1, examples: ['R3'] })
  })
})

describe('feedInfoRows', () => {
  it('feed_info が1行でなければ警告する', () => {
    const base = smallFeed()
    const result = apply(base)
    const info = rows(result.feed, 'feed_info')
    const [issue] = find(validateEdit(base, withEdited(result, 'feed_info', [...info, { ...info[0] }]), null), 'feedInfoRows')
    expect(issue).toMatchObject({ severity: 'warning', file: 'feed_info.txt', count: 2 })
    expect(issue.message).toContain('feed_info.txt の行が 2 行です。')
  })
})

describe('calendarBeyondFeedInfo と calendarOutsideValidity', () => {
  it('入力の calendar・calendar_dates が入力の feed_info の有効期間の外にあれば、切り詰めで落ちることを警告する', () => {
    const feed = smallFeed()
    const calendar = rows(feed, 'calendar').map((r) => (r.service_id === 'SA' ? { ...r, end_date: '20261231' } : r))
    const dates = [...rows(feed, 'calendar_dates'), { service_id: 'SU', date: '20260920', exception_type: '1' }]
    const base = withRows(withRows(feed, 'calendar', calendar), 'calendar_dates', dates)
    const issues = validateEdit(base, apply(base), null)
    const [issue] = find(issues, 'calendarBeyondFeedInfo')
    expect(issue).toMatchObject({ severity: 'warning', count: 2, examples: ['SA 20261001〜20261231', 'SU 20260920'] })
    expect(issue.message).toContain('(2026年10月1日〜2026年11月30日)の外の日があります')
    // 出力は切り詰めてあるので、出力の有効期間の外の行は無い
    expect(find(issues, 'calendarOutsideValidity')).toEqual([])
  })

  it('feed_info に日付が無い入力では見ない', () => {
    const base = withoutTables(smallFeed(), 'feed_info')
    expect(find(validateEdit(base, apply(base), null), 'calendarBeyondFeedInfo')).toEqual([])
  })

  it('出力の calendar・calendar_dates に出力の有効期間の外の日付があれば警告する', () => {
    const base = smallFeed()
    const result = apply(base)
    const broken = withEdited(result, 'calendar_dates', [...rows(result.feed, 'calendar_dates'), { service_id: 'WK', date: '20261201', exception_type: '2' }])
    expect(find(validateEdit(base, broken, null), 'calendarOutsideValidity')[0]).toMatchObject({ severity: 'warning', examples: ['WK 20261201'] })
  })
})

describe('signatureColumnMismatch', () => {
  it('入力の平日便と署名が同じなのに、行き先や乗降の扱いが違う平日便を警告する', () => {
    // R1_0700_SA は R1_0700_WK と停留所・時刻が同じ。写しの R1_0700_WK の行き先を変える
    const feed = smallFeed()
    const base = withRows(feed, 'trips', rows(feed, 'trips').map((t) => (t.trip_id === 'R1_0700_SA' ? { ...t, trip_headsign: '病院前' } : t)))
    const [issue] = find(validateEdit(base, apply(base), null), 'signatureColumnMismatch')
    expect(issue).toMatchObject({ severity: 'warning', file: 'trips.txt', count: 1, examples: ['R1_0700_WK'] })
    expect(issue.message).toContain('trip_headsign 1 便')
  })

  it('乗降の区分の違いも数え、空と 0 は同じとみなす', () => {
    const feed = smallFeed()
    const stopTimes = rows(feed, 'stop_times').map((r) => {
      if (r.trip_id === 'R1_0700_SA' && r.stop_sequence === '2') return { ...r, drop_off_type: '1' }
      // R1_0805_SA に署名が同じ平日便は無いので比べない
      if (r.trip_id === 'R1_0805_SA') return { ...r, pickup_type: '' }
      return r
    })
    const base = withRows(feed, 'stop_times', stopTimes)
    const [issue] = find(validateEdit(base, apply(base), null), 'signatureColumnMismatch')
    expect(issue).toMatchObject({ count: 1, examples: ['R1_0700_WK'] })
    expect(issue.message).toContain('drop_off_type 1 便')

    const onlyEmpty = withRows(
      feed,
      'stop_times',
      rows(feed, 'stop_times').map((r) => (r.trip_id === 'R1_0700_SA' && r.pickup_type === '0' ? { ...r, pickup_type: '' } : r)),
    )
    expect(find(validateEdit(onlyEmpty, apply(onlyEmpty), null), 'signatureColumnMismatch')).toEqual([])
  })
})

describe('unusedRoutes と unusedStops', () => {
  it('入力では便があり、出力では無くなる系統・停留所を件数つきで情報にする', () => {
    // R3 は平日だけの系統で、S9 は R3 だけが通る。S8 は入力の時点で使われていないので数えない
    const feed = smallFeed()
    const base = withRows(feed, 'stops', [...rows(feed, 'stops'), ...rowsOf('stop_id,stop_name,stop_lat,stop_lon\nS8,車庫,43.80,142.40')])
    const issues = validateEdit(base, apply(base), null)
    expect(find(issues, 'unusedRoutes')[0]).toMatchObject({ severity: 'info', file: 'routes.txt', count: 1, examples: ['R3'] })
    const [stops] = find(issues, 'unusedStops')
    expect(stops).toMatchObject({ severity: 'info', file: 'stops.txt', count: 1, examples: ['S9'] })
    expect(stops.message).toContain('1 か所')
  })

  it('平日だけの系統を除外すれば出さない', () => {
    const base = smallFeed()
    const issues = validateEdit(base, apply(base, basePlan({ excludedRoutes: ['R3'] })), null)
    expect(find(issues, 'unusedRoutes')).toEqual([])
    expect(find(issues, 'unusedStops')).toEqual([])
  })
})
