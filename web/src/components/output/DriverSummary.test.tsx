// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BOUND_LIMIT_MIN, DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import { applyForm2 } from '@/gtfs/edit/form2'
import { basePlan, feedOf, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { GtfsFeed } from '@/gtfs/load'
import { compareDrivers, useDriversStore, type DriverInput } from '@/store/drivers'
import { useEditStore } from '@/store/edit'
import { useReachStore } from '@/store/reach'
import { SHORTAGE_WHERE } from '@/components/steps/reach/driverText'
import DriverSummary, { DriverLine, DriverLineView, DriverSummaryView, SUMMARY_DATE_NOTE } from './DriverSummary'

afterEach(() => {
  cleanup()
  useDriversStore.setState({ shortage: null, roster: null, params: { ...DUTY_DEFAULTS }, places: [] })
  useReachStore.setState({ source: null, edited: null, date: null })
  useEditStore.setState({ draft: null, versions: [] })
})

const WEDNESDAY = '20261104'
const SATURDAY = '20261107'
const PERIOD = { start: '20261001', end: '20261130' }

/**
 * 平日 WK は 6:00 から1時間ごとに A→A の 30 分の便を wk 便、土曜 SA は 6 便(DriverPanel.test.tsx と同じ形)。
 * 14 便なら拘束 14 時間 15 分で、13 時間では2つの勤務、15 時間では1つ
 */
function shuttleFeed(wk: number): GtfsFeed {
  const tripsOf = (service: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      route_id: 'R1',
      service_id: service,
      trip_id: `R1_${String(6 + i).padStart(2, '0')}00_${service}`,
    }))
  const trips = [...tripsOf('WK', wk), ...tripsOf('SA', 6)]
  const day = (wd: string, sa: string) => ({ monday: wd, tuesday: wd, wednesday: wd, thursday: wd, friday: wd, saturday: sa, sunday: '0' })
  return feedOf({
    stops: [{ stop_id: 'A', stop_name: '駅前', stop_lat: '43.76', stop_lon: '142.36' }],
    calendar: [
      { service_id: 'WK', ...day('1', '0'), start_date: PERIOD.start, end_date: PERIOD.end },
      { service_id: 'SA', ...day('0', '1'), start_date: PERIOD.start, end_date: PERIOD.end },
    ],
    trips,
    stop_times: trips.flatMap((t) => {
      const h = t.trip_id.slice(3, 5)
      return [
        { trip_id: t.trip_id, arrival_time: `${h}:00:00`, departure_time: `${h}:00:00`, stop_id: 'A', stop_sequence: '1' },
        { trip_id: t.trip_id, arrival_time: `${h}:30:00`, departure_time: `${h}:30:00`, stop_id: 'A', stop_sequence: '2' },
      ]
    }),
  })
}

function comparisonOf(input: Partial<DriverInput> = {}) {
  return compareDrivers({
    base: shuttleFeed(14),
    edited: { feed: shuttleFeed(6), draft: false },
    date: WEDNESDAY,
    weekdayServices: new Set(['WK']),
    params: { ...DUTY_DEFAULTS },
    places: [],
    shortage: null,
    ...input,
  })
}

const table = () => screen.getByRole('table', { name: '減便の前後の営業運行時間と勤務の数' })
const rowText = (name: string) =>
  within(table())
    .getAllByRole('row')
    .find((r) => r.textContent?.startsWith(name))?.textContent ?? ''

describe('DriverSummaryView(変更指示書のまとまり)', () => {
  it('営業運行時間の前・後・削減量と、勤務の数の目安の前・後・差、使った仮定を1つのまとまりで出す。印刷で途中から分けない', () => {
    render(<DriverSummaryView comparison={comparisonOf()} note={SUMMARY_DATE_NOTE} />)
    const block = screen.getByTestId('driver-summary')
    expect(block.className).toContain('break-inside-avoid')
    expect(block.textContent).toContain('要る運転士の数(目安)(2026年11月4日(水)の便で比べた数)')
    const headers = within(table()).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['', '減便前', '減便後', '差'])
    expect(rowText('営業運行時間')).toBe('営業運行時間7時間0分3時間0分−4時間0分(−57.1%)')
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)21−1')
    const assumptions = screen.getByRole('list', { name: '要る運転士の数の仮定' })
    expect(assumptions.className).toContain('print:columns-2')
    expect(assumptions.textContent).toContain('拘束時間は 13 時間以内')
    expect(assumptions.textContent).toContain('勤務の数は下限の目安です')
    // 日付の断りは画面だけ
    expect(screen.getByText(SUMMARY_DATE_NOTE).className).toContain('print-hide')
    expect(block.textContent).not.toContain('あなた')
  })

  it('欠員は入れたときだけ、判定と並べて出す', () => {
    render(<DriverSummaryView comparison={comparisonOf()} />)
    expect(screen.queryByTestId('driver-summary-verdict')).toBeNull()
    expect(screen.getByTestId('driver-summary').textContent).not.toContain('欠員')
    cleanup()

    render(<DriverSummaryView comparison={comparisonOf({ shortage: 1 })} />)
    expect(screen.getByTestId('driver-summary-verdict').textContent).toBe('欠員 1 人:減便で減る勤務の数(目安)1 ≥ 欠員 1 → 足りる目安です。')
    cleanup()

    render(<DriverSummaryView comparison={comparisonOf({ shortage: 20 })} />)
    const verdict = screen.getByTestId('driver-summary-verdict')
    expect(verdict.textContent).toBe('欠員 20 人:⚠ 減便で減る勤務の数(目安)1 < 欠員 20 → あと 19 足りない目安です。')
    expect(verdict.className).toContain('font-semibold')
  })

  it('営業所を置くと、仮定の一覧にその数と、回送・休憩の数え方を出す。置いた営業所の名前は出さない', () => {
    const places = [
      { name: '旭川営業所テスト', lat: 43.76, lon: 142.36 },
      { name: '永山出張所テスト', lat: 43.77, lon: 142.36 },
      { name: '名寄出張所テスト', lat: 43.76, lon: 142.37 },
    ]
    render(<DriverSummaryView comparison={comparisonOf({ places })} />)
    const list = screen.getByRole('list', { name: '要る運転士の数の仮定' }).textContent ?? ''
    expect(list).toContain('営業所(3 か所)と最初・最後の停留所の間の回送を、拘束時間と運転時間に入れます')
    expect(list).toContain('休憩は、営業所の 300m 以内の停留所でのすき間だけに数えます')
    expect(list).not.toContain('営業所の位置がないため')
    expect(list).not.toMatch(/車庫|休憩施設/)
    const block = screen.getByTestId('driver-summary').textContent ?? ''
    for (const p of places) expect(block).not.toContain(p.name)
    cleanup()

    // 置かなければ、位置がない旨を出す
    render(<DriverSummaryView comparison={comparisonOf()} />)
    const none = screen.getByRole('list', { name: '要る運転士の数の仮定' }).textContent ?? ''
    expect(none).toContain('営業所の位置がないため、出庫・入庫の回送は数えません')
    expect(none).toContain('営業所の位置がないため、どの停留所でのすき間も休憩に数えます')
  })

  it('在籍の運転士の数は入れたときだけ、乗務できる運転士と減便後に要る勤務の数を参考に並べる。置いた場所の名前は出さない', () => {
    render(<DriverSummaryView comparison={comparisonOf({ shortage: 1 })} />)
    expect(screen.queryByTestId('driver-summary-roster')).toBeNull()
    cleanup()

    const places = [{ name: '秘匿の営業所S', lat: 43.76, lon: 142.36 }]
    render(<DriverSummaryView comparison={comparisonOf({ shortage: 1, roster: 3, places })} />)
    const roster = screen.getByTestId('driver-summary-roster').textContent ?? ''
    expect(roster).toContain('参考:乗務できる運転士(在籍 3 − 欠員 1)2 人/減便後に要る勤務の数(目安)1。')
    expect(roster).toContain('事業者の運用番号の数')
    expect(roster).not.toContain('注意')
    expect(screen.getByTestId('driver-summary').textContent).not.toContain(places[0].name)
    cleanup()

    // 要る勤務の数が乗務できる運転士を上回れば注意にする(主な判定は変えない)
    render(<DriverSummaryView comparison={comparisonOf({ shortage: 1, roster: 1 })} />)
    expect(screen.getByTestId('driver-summary-roster').textContent).toContain('注意:減便後に要る勤務の数(目安)が、乗務できる運転士の数を 1 上回ります。')
    expect(screen.getByTestId('driver-summary-verdict').textContent).toBe('欠員 1 人:減便で減る勤務の数(目安)1 ≥ 欠員 1 → 足りる目安です。')
  })

  it('仮定を変えると(拘束 15 時間)、勤務の数と仮定の文がその値になる', () => {
    render(<DriverSummaryView comparison={comparisonOf({ params: { ...DUTY_DEFAULTS, maxBoundMin: BOUND_LIMIT_MIN.extended } })} />)
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)11±0')
    expect(screen.getByRole('list', { name: '要る運転士の数の仮定' }).textContent).toContain('拘束時間は 15 時間以内')
  })
})

describe('DriverSummary(変更指示書に差し込む。承認済みの最後の版と比べる)', () => {
  function approved() {
    const base = smallFeed()
    const outcome = applyForm2(base, basePlan(), { generatedAt: '202611051200' })
    if (!outcome.ok) throw new Error(outcome.message)
    return { base, version: outcome.result }
  }

  it('欠員と仮定は store の値を使い、変えると数え直す', () => {
    const { base, version } = approved()
    render(<DriverSummary base={base} version={version} date={WEDNESDAY} />)
    expect(within(table()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', '減便前', '減便後', '差'])
    expect(screen.queryByTestId('driver-summary-verdict')).toBeNull()
    act(() => useDriversStore.getState().setShortage(5))
    expect(screen.getByTestId('driver-summary-verdict').textContent).toMatch(/^欠員 5 人:⚠ .*あと \d+ 足りない目安です。$/)
    expect(screen.getByTestId('driver-summary-verdict').textContent).not.toMatch(/勤務の数\(目安\)-\d/)
    act(() => useDriversStore.getState().setParams({ maxBoundMin: BOUND_LIMIT_MIN.extended }))
    expect(screen.getByRole('list', { name: '要る運転士の数の仮定' }).textContent).toContain('拘束時間は 15 時間以内')
  })

  it('比較する平日が無ければ、出さない理由を1行出す', () => {
    const { base, version } = approved()
    render(<DriverSummary base={base} version={version} date={null} />)
    expect(screen.getByTestId('driver-summary').textContent).toContain('比較する平日が見つからないため、出していません。')
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('DriverLine(平日便を戻す手順の1行)', () => {
  it('勤務の数の前後と差、比較する日付、欠員との比較を1行で出す', () => {
    render(<DriverLineView comparison={comparisonOf({ shortage: 20 })} />)
    const line = screen.getByTestId('driver-line')
    expect(line.textContent).toBe(
      '⚠ 勤務の数(目安):減便前 2 → 減便後 1(−1、2026年11月4日(水))。減便で減る勤務の数(目安)1 < 欠員 20 → あと 19 足りない目安です。',
    )
    expect(line.className).toContain('text-destructive')
  })

  it('欠員を入れていなければ、入れる場所を示す。下書きなら減便後に(下書き)と添える', () => {
    render(<DriverLineView comparison={comparisonOf({ edited: { feed: shuttleFeed(6), draft: true } })} />)
    const text = screen.getByTestId('driver-line').textContent ?? ''
    expect(text).toContain('減便後(下書き) 1')
    expect(text).toContain(SHORTAGE_WHERE)
  })

  it('在籍の運転士の数を入れたときだけ、参考の数を足し、上回れば注意にする', () => {
    render(<DriverLineView comparison={comparisonOf({ shortage: 1 })} />)
    expect(screen.queryByTestId('driver-line-roster')).toBeNull()
    cleanup()
    render(<DriverLineView comparison={comparisonOf({ shortage: 1, roster: 1 })} />)
    const roster = screen.getByTestId('driver-line-roster').textContent ?? ''
    expect(roster).toContain('参考:乗務できる運転士(在籍 1 − 欠員 1)0 人/減便後に要る勤務の数(目安)1。')
    expect(roster).toContain('⚠ 注意:減便後に要る勤務の数(目安)が、乗務できる運転士の数を 1 上回ります。')
  })

  it('比較する日付が平日でなければ、前後で差が無い旨を出す', () => {
    render(<DriverLineView comparison={comparisonOf({ date: SATURDAY, shortage: 3 })} />)
    expect(screen.getByTestId('driver-line').textContent).toContain('減便前の平日ダイヤが走らない日のため')
  })

  it('store の比較(到達圏の減便前・減便後・比較する日付)を使い、GTFS か日付が無ければ何も出さない', () => {
    const { container } = render(<DriverLine />)
    expect(container.textContent).toBe('')
    cleanup()
    act(() => {
      useReachStore.setState({
        source: { feed: shuttleFeed(14), stops: [], period: PERIOD },
        edited: { feed: shuttleFeed(6), period: PERIOD, draft: false },
        date: WEDNESDAY,
      })
      useDriversStore.getState().setShortage(1)
    })
    render(<DriverLine />)
    expect(screen.getByTestId('driver-line').textContent).toContain('減便前 2 → 減便後 1(−1、')
    expect(screen.getByTestId('driver-line').textContent).toContain('足りる目安です。')
    // 欠員を変えると(便を戻して勤務の数が変わったときと同じく)すぐに書き直す
    act(() => useDriversStore.getState().setShortage(3))
    expect(screen.getByTestId('driver-line').textContent).toContain('あと 2 足りない目安です。')
  })
})
