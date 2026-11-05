// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  useDriversStore.setState({ shortage: null, roster: null, params: { ...DUTY_DEFAULTS }, places: [] })
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

function viewOf(input: Partial<DriverInput> & Pick<DriverInput, 'base'>, onOpenPremise: () => void = () => {}) {
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
    <DriverView comparison={c} params={c.before.duties.params} places={input.places ?? []} onOpenPremise={onOpenPremise} />,
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

describe('DriverView(上限を超えた勤務・回送が長すぎる勤務の注意)', () => {
  it('場所を置かず上限を超える勤務が無ければ、注意を出さない', () => {
    viewOf({ base: shuttleFeed(14), edited: { feed: shuttleFeed(6), draft: false }, weekdayServices: new Set(['WK']) })
    expect(screen.queryByTestId('duty-warning')).toBeNull()
  })

  it('路線から遠い車庫を置くと、上限を超えた勤務と回送が長すぎる勤務の数を減便の前後で出す', () => {
    // 停留所から約 50km 北の車庫(出庫・入庫の回送が片道 3 時間 15 分)。どの便も1便だけで連続運転の上限を超える
    const far = { kind: 'garage' as const, name: '車庫', lat: 44.21, lon: 142.36 }
    viewOf({ base: shuttleFeed(14), edited: { feed: shuttleFeed(6), draft: false }, weekdayServices: new Set(['WK']), places: [far] })
    const warning = screen.getByTestId('duty-warning')
    expect(warning.textContent).toContain('1便だけで改善基準告示の上限を超える勤務 減便前 14・減便後 6')
    expect(warning.textContent).toContain('出庫か入庫の回送が片道 60 分を超える勤務 減便前 14・減便後 6')
    expect(warning.textContent).toContain('置いた場所が正しいか')
    expect(warning.className).toContain('text-destructive')
    expect(warning.textContent).not.toContain('あなた')
  })

  it('減便後が無ければ、減便前の数だけを出す', () => {
    const far = { kind: 'depot' as const, name: '営業所', lat: 44.21, lon: 142.36 }
    viewOf({ base: shuttleFeed(14), places: [far] })
    expect(screen.getByTestId('duty-warning').textContent).toContain('出庫か入庫の回送が片道 60 分を超える勤務 14')
  })
})

describe('DriverPanel(store とつないだ欄)', () => {
  it('GTFS か比較する日付が無ければ何も出さない', () => {
    const { container } = render(<DriverPanel />)
    expect(container.textContent).toBe('')
  })

  it('入力の欄は無く、結果と「前提情報で設定する」ボタンだけを出す', () => {
    showInStore(shuttleFeed(14), shuttleFeed(6), WEDNESDAY)
    render(<DriverPanel />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByTestId('places-editor')).toBeNull()
    expect(screen.queryByLabelText('欠員(その日に乗務できない運転士の数)')).toBeNull()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['前提情報で設定する'])
    expect(screen.getByTestId('shortage-hint').textContent).toBe('前提情報で欠員を入れると、足りるかの目安を出します。')
  })

  it('store の欠員・仮定を変えると(前提情報の欄で入れたとき)、判定と表を数え直す', () => {
    showInStore(shuttleFeed(14), shuttleFeed(6), WEDNESDAY)
    useEditStore.setState({ versions: [] })
    render(<DriverPanel />)
    expect(screen.getByTestId('driver-verdict').textContent).toBe('減便で減る勤務の数(目安)は 1 です。')
    act(() => useDriversStore.getState().setShortage(2))
    // 方針が分からない(版が無い)ときも、差と欠員は比べる
    expect(screen.getByTestId('driver-verdict').textContent).toContain('あと 1 足りない目安')
    expect(screen.queryByTestId('shortage-hint')).toBeNull()
    act(() => useDriversStore.getState().setParams({ maxBoundMin: BOUND_LIMIT_MIN.extended }))
    expect(rowText('勤務の数(目安)')).toBe('勤務の数(目安)11±0')
    expect(screen.getByTestId('assumptions-summary').textContent).toContain('拘束時間の上限 15 時間')
    expect(screen.getByRole('list', { name: '使った仮定' }).textContent).toContain('拘束時間は 15 時間以内')
  })
})

describe('DriverView(在籍の運転士の数の参考)', () => {
  it('在籍を入れていなければ出さない', () => {
    viewOf({ base: shuttleFeed(14), edited: { feed: shuttleFeed(6), draft: false }, weekdayServices: new Set(['WK']), shortage: 1 })
    expect(screen.queryByTestId('roster-check')).toBeNull()
  })

  it('在籍を入れると、判定の下に乗務できる運転士と減便後に要る勤務の数を並べ、運用番号の数との差を1文で添える', () => {
    viewOf({ base: shuttleFeed(14), edited: { feed: shuttleFeed(6), draft: false }, weekdayServices: new Set(['WK']), shortage: 1, roster: 5 })
    const check = screen.getByTestId('roster-check')
    expect(check.textContent).toContain('参考:乗務できる運転士(在籍 5 − 欠員 1)4 人/減便後に要る勤務の数(目安)1。')
    expect(check.textContent).toContain('下限の目安のため、事業者の運用番号の数')
    expect(screen.queryByTestId('roster-warning')).toBeNull()
    // 判定の下に出す
    expect(screen.getByTestId('driver-verdict').compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 主な判定は変えない
    expect(screen.getByTestId('driver-verdict').textContent).toBe('減便で減る勤務の数(目安)1 ≥ 欠員 1 → 足りる目安です。')
  })

  it('減便後に要る勤務の数が乗務できる運転士を上回るときは注意にする', () => {
    viewOf({ base: shuttleFeed(14), edited: { feed: shuttleFeed(6), draft: false }, weekdayServices: new Set(['WK']), shortage: 1, roster: 1 })
    const warning = screen.getByTestId('roster-warning')
    expect(warning.textContent).toContain('減便後に要る勤務の数(目安)が、乗務できる運転士の数を 1 上回ります。')
    expect(warning.className).toContain('text-destructive')
  })

  it('減便後が無ければ減便前の勤務の数と比べ、欠員が在籍より多ければ数を確かめる注意にする', () => {
    viewOf({ base: shuttleFeed(14), roster: 10 })
    expect(screen.getByTestId('roster-check').textContent).toContain('参考:乗務できる運転士(在籍 10、欠員は未入力)10 人/減便前に要る勤務の数(目安)2。')
    cleanup()
    viewOf({ base: shuttleFeed(14), roster: 10, shortage: 20 })
    expect(screen.getByTestId('roster-warning').textContent).toContain('欠員が在籍の運転士の数より多く')
  })
})

describe('DriverView(前提情報で設定する)', () => {
  it('ボタンを押すと onOpenPremise を呼ぶ', () => {
    const open = vi.fn()
    viewOf({ base: smallFeed() }, open)
    fireEvent.click(screen.getByRole('button', { name: '前提情報で設定する' }))
    expect(open).toHaveBeenCalledTimes(1)
  })
})
