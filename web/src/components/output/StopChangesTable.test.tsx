// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyForm2 } from '@/gtfs/edit/form2'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { GtfsFeed } from '@/gtfs/load'
import { useReachStore } from '@/store/reach'
import StopChangesTable from './StopChangesTable'

// 到達圏の計算は、この画面では走らせない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

// smallFeed の 20261104(水)。基準の平日:A 発 R1 07:00・R3 07:30・R1 08:00・R2 09:00、R3 は S9(学校前)も 07:40 に通る。
// 平日を土曜ダイヤに入れ替えた後:A は R1 07:00・R1 08:05・R2 10:00、C(病院前)は R1 08:00。S9 は発車が無くなる
function setReach(base: GtfsFeed | null, edited: GtfsFeed | null, date: string | null, draft = false) {
  act(() => {
    useReachStore.setState({
      source: base ? { feed: base, stops: [], period: { start: '20261001', end: '20261130' } } : null,
      edited: edited ? { feed: edited, period: { start: '20261101', end: '20261130' }, draft } : null,
      date,
    })
  })
}

function editedOf(base: GtfsFeed): GtfsFeed {
  const outcome = applyForm2(base, basePlan(), { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result.feed
}

/** 表の本体の行ごとの先頭の停留所名(詳細の行は除く) */
function stopNames(): string[] {
  const table = screen.getByRole('table', { name: '停留所ごとの前後の比較' })
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .filter((r) => r.hasAttribute('data-stop-id'))
    .map((r) => within(r).getByTestId('stop-name').textContent ?? '')
}

function rowOf(name: string): HTMLElement {
  const table = screen.getByRole('table', { name: '停留所ごとの前後の比較' })
  const row = within(table)
    .getAllByRole('row')
    .find((r) => r.hasAttribute('data-stop-id') && within(r).getByTestId('stop-name').textContent === name)
  if (!row) throw new Error(`${name} の行がありません`)
  return row
}

beforeEach(() => {
  const base = smallFeed()
  setReach(base, editedOf(base), '20261104')
})

afterEach(() => {
  cleanup()
  setReach(null, null, null)
})

describe('StopChangesTable', () => {
  it('方針を承認する前(編集後が無い)は、承認を促す', () => {
    const base = smallFeed()
    setReach(base, null, '20261104')
    render(<StopChangesTable />)
    expect(screen.getByText(/減便の方針を承認すると/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('比較する日付を出し、停留所ごとに本数・始発・最終便・最大間隔を前→後で並べる', () => {
    render(<StopChangesTable />)
    expect(screen.getByText('2026年11月4日(水)')).toBeTruthy()
    // 比較する日付を選ぶ場所は、手順の名前で案内する(番号は書かない)
    expect(screen.getByText(/手順「影響\(到達圏\)」の地図で選んでいる日付/)).toBeTruthy()
    const a = within(rowOf('駅前'))
    expect(a.getByText('4 → 3')).toBeTruthy()
    expect(a.getByText('07:00 → 07:00')).toBeTruthy()
    expect(a.getByText('09:00 → 10:00')).toBeTruthy()
    expect(a.getByText('60分 → 115分')).toBeTruthy()
    // 編集後に stop_times から消えた停留所も、基準から数えて出る
    const s9 = within(rowOf('学校前'))
    expect(s9.getByText('1 → 0')).toBeTruthy()
    expect(s9.getAllByText('07:40 → —')).toHaveLength(2) // 始発と最終便
    expect(s9.getByText('発車なし')).toBeTruthy()
    expect(within(rowOf('病院前')).getByText('0 → 1')).toBeTruthy()
  })

  it('掲示を差し替える停留所の件数と、早発の注意を出す', () => {
    render(<StopChangesTable />)
    const counts = screen.getByLabelText('停留所の変化の件数')
    const item = (label: string) => within(counts).getByText(label).parentElement as HTMLElement
    expect(item('掲示を差し替える停留所').textContent).toContain('3件')
    expect(item('掲示を差し替える停留所').textContent).toContain('全3件中')
    expect(item('発車がすべてなくなる停留所').textContent).toContain('1件')
    expect(item('新しく加わる発車時刻がある停留所').textContent).toContain('2件')
    expect(item('なくなる発車時刻がある停留所').textContent).toContain('2件')
    expect(screen.getByText(/掲示より早い発車は早発になりえます/)).toBeTruthy()
  })

  it('新しく加わる発車時刻となくなる発車時刻を、停留所ごとに開いて系統別に見られる', () => {
    render(<StopChangesTable />)
    const button = screen.getByRole('button', { name: '駅前(A)の発車時刻の入れ替えを見る' })
    expect(button.textContent).toBe('加わる 2・なくなる 3')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    const open = screen.getByRole('button', { name: '駅前(A)の発車時刻の入れ替えを閉じる' })
    expect(open.getAttribute('aria-expanded')).toBe('true')
    const detail = document.getElementById(open.getAttribute('aria-controls') ?? '') as HTMLElement
    const added = within(detail).getByText('新しく加わる発車時刻(2本)').parentElement as HTMLElement
    expect(added.textContent).toContain('系統 1: 08:05')
    expect(added.textContent).toContain('系統 2: 10:00')
    const removed = within(detail).getByText('なくなる発車時刻(3本)').parentElement as HTMLElement
    expect(removed.textContent).toContain('系統 1: 08:00')
    expect(removed.textContent).toContain('系統 2: 09:00')
    expect(removed.textContent).toContain('系統 3: 07:30')
    fireEvent.click(open)
    expect(document.getElementById(open.getAttribute('aria-controls') ?? '')).toBeNull()
  })

  it('既定は変化の大きい順で、発車がすべて無くなる停留所が先頭に来る', () => {
    render(<StopChangesTable />)
    expect(stopNames()).toEqual(['学校前', '駅前', '病院前'])
  })

  it('並べ方を最大間隔が広がった順にできる(前に間隔が無い停留所は後ろ)', () => {
    render(<StopChangesTable />)
    fireEvent.click(screen.getByRole('radio', { name: '最大間隔が広がった順' }))
    expect(stopNames()[0]).toBe('駅前')
    fireEvent.click(screen.getByRole('radio', { name: '停留所名順' }))
    expect(stopNames()).toEqual([...stopNames()].sort())
  })

  it('停留所名で絞り込める', () => {
    render(<StopChangesTable />)
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '前' } })
    expect(stopNames()).toHaveLength(3)
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '病院' } })
    expect(stopNames()).toEqual(['病院前'])
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '存在しない名前' } })
    expect(screen.getByText('条件に合う停留所はありません。')).toBeTruthy()
  })

  it('変化の無い停留所は既定では隠し、チェックを外すと出す', () => {
    // 入れ替えの無い日(20261103 は平日が運休で、日曜の便が走る)。停留所 A の1本だけが前後で同じ
    render(<StopChangesTable />)
    act(() => useReachStore.setState({ date: '20261103' }))
    expect(screen.getByText('条件に合う停留所はありません。')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('発車時刻が変わる停留所だけ'))
    expect(stopNames()).toEqual(['駅前'])
    expect(within(rowOf('駅前')).getByText('変化なし')).toBeTruthy()
  })

  it('同じ名前で stop_id の違う停留所(道路の両側の標柱など)は、stop_id で見分けられる', () => {
    const base = smallFeed()
    const stops = base.tables.get('stops')!
    const stopTimes = base.tables.get('stop_times')!
    // 駅前(A)の向かいの標柱 A2 を、R3 の便の始発にする(終点は発車に数えないため)。編集後は R3 が走らないので、A2 は発車が無くなる
    const tables = new Map(base.tables)
    tables.set('stops', { ...stops, rows: [...stops.rows, { stop_id: 'A2', stop_name: '駅前', stop_lat: '43.7601', stop_lon: '142.3601' }] })
    tables.set('stop_times', {
      ...stopTimes,
      rows: [
        ...stopTimes.rows,
        { trip_id: 'R3_0730_WK', arrival_time: '07:25:00', departure_time: '07:25:00', stop_id: 'A2', stop_sequence: '0', pickup_type: '0', drop_off_type: '1' },
      ],
    })
    const twin: GtfsFeed = { tables, warnings: base.warnings }
    setReach(twin, editedOf(twin), '20261104')
    render(<StopChangesTable />)
    const table = screen.getByRole('table', { name: '停留所ごとの前後の比較' })
    const rows = within(table)
      .getAllByRole('row')
      .filter((r) => within(r).queryByTestId('stop-name')?.textContent === '駅前')
    expect(rows.map((r) => within(r).getByTestId('stop-id').textContent).sort()).toEqual(['A', 'A2'])
    expect(screen.getByRole('button', { name: '駅前(A)の発車時刻の入れ替えを見る' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '駅前(A2)の発車時刻の入れ替えを見る' })).toBeTruthy()
  })

  it('承認待ちの下書きで比べているときは、そう知らせる', () => {
    const base = smallFeed()
    setReach(base, editedOf(base), '20261104', true)
    render(<StopChangesTable />)
    expect(screen.getByText(/承認待ちの下書きで比べています/)).toBeTruthy()
  })

  it('行が多いときは先頭の100件だけ出し、「さらに表示」で足す', () => {
    const base = smallFeed()
    const stops = base.tables.get('stops')!
    // 同じ便を通る停留所を足して、停留所を200件にする。基準だけに停留所を足すと編集後は発車が無くなる
    const extraStops = Array.from({ length: 200 }, (_, i) => ({ stop_id: `X${i}`, stop_name: `停留所${String(i).padStart(3, '0')}`, stop_lat: '43.8', stop_lon: '142.4' }))
    const stopTimes = base.tables.get('stop_times')!
    const extraTimes = extraStops.map((s, i) => ({
      trip_id: 'R1_0700_WK',
      arrival_time: '07:05:00',
      departure_time: '07:05:00',
      stop_id: s.stop_id,
      stop_sequence: String(10 + i),
      pickup_type: '0',
      drop_off_type: '0',
    }))
    const tables = new Map(base.tables)
    tables.set('stops', { ...stops, rows: [...stops.rows, ...extraStops] })
    tables.set('stop_times', { ...stopTimes, rows: [...stopTimes.rows, ...extraTimes] })
    const big: GtfsFeed = { tables, warnings: base.warnings }
    setReach(big, editedOf(big), '20261104')
    render(<StopChangesTable />)
    expect(stopNames()).toHaveLength(100)
    fireEvent.click(screen.getByRole('button', { name: /さらに表示/ }))
    expect(stopNames()).toHaveLength(200)
  })
})
