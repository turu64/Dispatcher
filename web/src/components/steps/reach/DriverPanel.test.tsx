// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BOUND_LIMIT_MIN, DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import { applyForm2, activeWeekdayServicesOf } from '@/gtfs/edit/form2'
import { basePlan, feedOf, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { GtfsFeed } from '@/gtfs/load'
import { compareDrivers, useDriversStore, type DriverInput } from '@/store/drivers'
import { useEditStore } from '@/store/edit'
import { useReachStore } from '@/store/reach'
import DriverPanel, { DriverView } from './DriverPanel'

afterEach(() => {
  cleanup()
  useDriversStore.setState({ shortage: null, params: { ...DUTY_DEFAULTS }, places: [] })
  useReachStore.setState({ source: null, edited: null, date: null })
  useEditStore.setState({ draft: null, versions: [] })
})

const WEDNESDAY = '20261104'
const SATURDAY = '20261107'
const PERIOD = { start: '20261001', end: '20261130' }

/**
 * 平日 WK は 6:00 から1時間ごとに A→A の 30 分の便を wk 便、土曜 SA は 6 便。
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

/** 到達圏の store に減便前・減便後と比較する日付を入れる(DriverPanel は store から読む) */
function showInStore(base: GtfsFeed, edited: GtfsFeed | null, date: string, draft = false) {
  useReachStore.setState({
    source: { feed: base, stops: [], period: PERIOD },
    edited: edited ? { feed: edited, period: PERIOD, draft } : null,
    date,
  })
}

function viewOf(input: Partial<DriverInput> & Pick<DriverInput, 'base'>) {
  const c = compareDrivers({
    edited: null,
    date: WEDNESDAY,
    weekdayServices: null,
    params: { ...DUTY_DEFAULTS },
    places: [],
    shortage: null,
    ...input,
  })
  return render(
    <DriverView comparison={c} params={c.before.duties.params} places={[]} onShortage={() => {}} onParams={() => {}} onResetParams={() => {}} />,
  )
}

const table = () => screen.getByRole('table', { name: '減便の前後の便・営業運行時間・勤務の数' })
const rowText = (name: string) =>
  within(table())
    .getAllByRole('row')
    .find((r) => r.textContent?.startsWith(name))?.textContent ?? ''

describe('DriverView(前後の表と判定)', () => {
  it('減便後が無ければ減便前の列だけを出し、承認すると比べる旨を出す', () => {
    viewOf({ base: smallFeed() })
    const headers = within(table()).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['', '減便前'])
    expect(rowText('便の数')).toBe('便の数4 便')
    expect(rowText('営業運行時間')).toBe('営業運行時間1時間0分')
    expect(rowText('勤務の数(目安)')).toMatch(/^勤務の数\(目安\)\d+$/)
    expect(screen.getByTestId('driver-verdict').textContent).toContain('減便の方針を承認すると')
  })

  it('減便後があれば前・後・差を出し、欠員に足りる目安を出す', () => {
    const base = shuttleFeed(14)
    viewOf({ base, edited: { feed: shuttleFeed(6), draft: false }, weekdayServices: new Set(['WK']), shortage: 1 })
    const headers = within(table()).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['', '減便前', '減便後', '差'])
    expect(rowText('便の数')).toBe('便の数14 便6 便−8 便')
    expect(rowText('営業運行時間')).toBe('営業運行時間7時間0分3時間0分−4時間0分−57.1%')
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)21−1')
    expect(screen.getByTestId('driver-verdict').textContent).toBe('減便で減る勤務の数(目安)1 ≥ 欠員 1 → 足りる目安です。')
  })

  it('欠員が減る勤務の数より多ければ、あと何人足りない目安かを出す', () => {
    viewOf({ base: shuttleFeed(14), edited: { feed: shuttleFeed(6), draft: true }, weekdayServices: new Set(['WK']), shortage: 20 })
    expect(screen.getByTestId('driver-verdict').textContent).toBe('⚠ 減便で減る勤務の数(目安)1 < 欠員 20 → あと 19 足りない目安です。')
    expect(screen.getByRole('columnheader', { name: '減便後(下書き)' })).toBeTruthy()
  })

  it('比較する日付が平日でないときは、前後で差が無い旨を出す', () => {
    const base = smallFeed()
    const outcome = applyForm2(base, basePlan(), { generatedAt: '202611051200' })
    if (!outcome.ok) throw new Error(outcome.message)
    viewOf({
      base,
      edited: { feed: outcome.result.feed, draft: false },
      weekdayServices: activeWeekdayServicesOf(outcome.result),
      date: SATURDAY,
      shortage: 20,
    })
    const verdict = screen.getByTestId('driver-verdict').textContent ?? ''
    expect(verdict).toContain('比較する日付(2026年11月7日(土))は減便前の平日ダイヤが走らない日のため、減便の前後で便と勤務の数は変わりません')
    expect(verdict).not.toContain('足りる')
    expect(rowText('勤務の数(目安)')).toMatch(/±0$/)
  })

  it('入力の運用番号の数は、取れたときだけ「参考」の行に出す', () => {
    viewOf({ base: smallFeed() })
    expect(rowText('入力の運用番号の数')).toBe('')
    const feed = feedOf({
      stops: [{ stop_id: 'A', stop_name: '駅前', stop_lat: '43.76', stop_lon: '142.36' }],
      calendar: [
        { service_id: '01', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20261130' },
      ],
      trips: [{ route_id: 'R1', service_id: '01', trip_id: '101_1_01_01_0600' }],
      stop_times: [
        { trip_id: '101_1_01_01_0600', arrival_time: '06:00:00', departure_time: '06:00:00', stop_id: 'A', stop_sequence: '1' },
        { trip_id: '101_1_01_01_0600', arrival_time: '06:30:00', departure_time: '06:30:00', stop_id: 'A', stop_sequence: '2' },
      ],
    })
    cleanup()
    viewOf({ base: feed })
    expect(rowText('入力の運用番号の数(参考)')).toBe('入力の運用番号の数(参考)1')
  })

  it('断り書きに、下限の目安・改善基準告示の上限・事業者の判断・回送 0 を書き、「あなた」を使わない', () => {
    const { container } = viewOf({ base: smallFeed() })
    const notes = screen.getByRole('list', { name: '要る運転士の数の断り書き' }).textContent ?? ''
    expect(notes).toContain('下限の目安')
    expect(notes).toContain('改善基準告示 第5条の上限(拘束 13 時間・運転 9 時間・連続運転 4 時間)')
    expect(notes).toContain('36協定')
    expect(notes).toContain('出庫・入庫の回送を 0 として')
    expect(container.textContent).not.toContain('あなた')
  })
})

describe('DriverPanel(store とつないだ欄)', () => {
  it('GTFS か比較する日付が無ければ何も出さない', () => {
    const { container } = render(<DriverPanel />)
    expect(container.textContent).toBe('')
  })

  it('欠員を入れると判定が変わり、空にすると入れていない状態に戻る', () => {
    showInStore(shuttleFeed(14), shuttleFeed(6), WEDNESDAY)
    useEditStore.setState({ versions: [] })
    render(<DriverPanel />)
    const input = screen.getByLabelText('欠員(その日に乗務できない運転士の数)')
    fireEvent.change(input, { target: { value: '２' } })
    expect(useDriversStore.getState().shortage).toBe(2)
    // 方針が分からない(版が無い)ときも、差と欠員は比べる
    expect(screen.getByTestId('driver-verdict').textContent).toContain('あと 1 足りない目安')
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(screen.getByText('0 以上の整数を入れてください')).toBeTruthy()
    expect(useDriversStore.getState().shortage).toBe(2)
    fireEvent.change(input, { target: { value: '' } })
    expect(useDriversStore.getState().shortage).toBeNull()
    expect(screen.getByTestId('driver-verdict').textContent).toContain('欠員を入れると')
  })

  it('「仮定を変える」で拘束を 15 時間にすると計算し直す', () => {
    showInStore(shuttleFeed(14), shuttleFeed(6), WEDNESDAY)
    useDriversStore.getState().setShortage(1)
    render(<DriverPanel />)
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)21−1')
    fireEvent.click(screen.getByText('仮定を変える'))
    fireEvent.click(screen.getByRole('radio', { name: '15 時間(延長の上限)' }))
    expect(useDriversStore.getState().params.maxBoundMin).toBe(BOUND_LIMIT_MIN.extended)
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)11±0')
    expect(screen.getByTestId('driver-verdict').textContent).toContain('あと 1 足りない目安')
    // 使った仮定の文も 15 時間になる
    expect(screen.getByRole('list', { name: '使った仮定' }).textContent).toContain('拘束時間は 15 時間以内')
    fireEvent.click(screen.getByRole('button', { name: '既定値に戻す' }))
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)21−1')
  })

  it('点呼の分を変えても計算し直す(入庫後の点呼を延ばすと拘束が延びる)', () => {
    // 平日 12 便(6:00〜17:30。拘束 12 時間 15 分)。入庫後の点呼を 75 分にすると 13 時間 15 分になり、2つの勤務になる
    showInStore(shuttleFeed(12), shuttleFeed(6), WEDNESDAY)
    render(<DriverPanel />)
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)11±0')
    fireEvent.click(screen.getByText('仮定を変える'))
    fireEvent.change(screen.getByLabelText('入庫後の点呼'), { target: { value: '75' } })
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)21−1')
  })
})
