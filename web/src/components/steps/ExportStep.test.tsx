// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyForm2 } from '@/gtfs/edit/form2'
import { basePlan, smallFeed, withRows } from '@/gtfs/edit/form2.fixture'
import type { EditOp } from '@/gtfs/edit/ops'
import type { GtfsFeed } from '@/gtfs/load'
import { serializeTable } from '@/gtfs/write'
import { useEditStore } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import ExportStep from './ExportStep'

const writeGtfsZip = vi.hoisted(() =>
  vi.fn(async (_input: { edited: GtfsFeed; generatedAt: string; attribution: string }) => new Blob(['zip'])),
)
vi.mock('@/gtfs/write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/gtfs/write')>()),
  writeGtfsZip,
}))
// 到達圏の store への受け渡し(setEdited)は、この画面では計算しない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

const SAMPLE = { available: true, name: '道北バス', source: '北海道オープンデータプラットフォーム(gtfs-data)', license: 'CC BY 4.0' }

function policy(): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan()
  return { type: 'applyPolicy', settings, reason: { category: null, note: '' } }
}

function tripsText(feed: GtfsFeed): string {
  return new TextDecoder().decode(serializeTable(feed.tables.get('trips')!))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T03:00:00Z') })
  useHolidayStore.setState({ holidays: { status: 'missing' } })
  URL.createObjectURL = vi.fn(() => 'blob:dispatcher-test')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  writeGtfsZip.mockClear()
  act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'dohoku.zip', sample: SAMPLE }))
})

afterEach(() => {
  cleanup()
  act(() => useEditStore.getState().setBase(null))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ExportStep', () => {
  it('下書きがあっても、出力は承認済みの計画で作る(下書きがある間は押せない)', async () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
      // Claude の足し戻しの下書き(承認前)
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<ExportStep />)
    const button = screen.getByRole('button', { name: 'GTFS を出力する' })
    expect(button).toHaveProperty('disabled', true)
    const draftId = useEditStore.getState().draft!.id
    expect(screen.getByText(`下書き ${draftId} を承認するか、やめてから出力してください。`)).toBeTruthy()

    // 下書きをやめると押せる。出力は承認済みの計画(方針だけ)で、押した時刻で作り直す
    act(() => useEditStore.getState().discard())
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    await waitFor(() => expect(writeGtfsZip).toHaveBeenCalledTimes(1))
    const input = writeGtfsZip.mock.calls[0][0]
    expect(input.generatedAt).toBe('202610201200')
    const expected = applyForm2(smallFeed(), basePlan(), { generatedAt: '202610201200' })
    if (!expected.ok) throw new Error(expected.message)
    expect(tripsText(input.edited)).toBe(tripsText(expected.result.feed))
    expect(tripsText(input.edited)).not.toContain('R3_0730_WK')
    // サンプル(道北バス)の出典を ZIP に入れる
    expect(input.attribution).toContain('元データ:道北バス GTFS(北海道オープンデータプラットフォーム)。ライセンス:CC BY 4.0')
    expect(input.attribution).toContain('加工日時 2026年10月20日 12:00')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('dohoku_dispatcher_202610201200.zip'))
  })

  it('出力したあとに承認済みの版が変わったら(元に戻す・すべて戻す)、前の出力の表示とダウンロードの URL を消す', async () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'user')
      useEditStore.getState().commit()
    })
    render(<ExportStep />)
    fireEvent.click(screen.getByRole('button', { name: 'GTFS を出力する' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('出力しました'))
    expect(screen.getByRole('link', { name: 'もう一度ダウンロードする' })).toBeTruthy()

    // 元に戻す(足し戻しを除く):出力した ZIP は今の内容と違うので、表示を消して URL を片付ける
    act(() => useEditStore.getState().undo())
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('link', { name: 'もう一度ダウンロードする' })).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:dispatcher-test')

    // 出力し直してから、すべて戻す:履歴が空なので、前の出力は残さず「方針を適用してから」だけを出す
    fireEvent.click(screen.getByRole('button', { name: 'GTFS を出力する' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('出力しました'))
    act(() => useEditStore.getState().undoAll())
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('方針を適用してから出力できます。')).toBeTruthy()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('ZIP を書いている間に元に戻したら、古い内容の ZIP はダウンロードさせない', async () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'user')
      useEditStore.getState().commit()
    })
    let finish!: (blob: Blob) => void
    writeGtfsZip.mockImplementationOnce(() => new Promise<Blob>((resolve) => (finish = resolve)))
    render(<ExportStep />)
    fireEvent.click(screen.getByRole('button', { name: 'GTFS を出力する' }))
    await waitFor(() => expect(writeGtfsZip).toHaveBeenCalledTimes(1))
    act(() => useEditStore.getState().undo())
    await act(async () => finish(new Blob(['zip'])))
    expect(screen.queryByRole('status')).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(screen.getByText('出力の途中で編集の内容が変わったため、出力をやめました。もう一度押してください。')).toBeTruthy()
  })

  it('履歴が空なら出力を押せない', () => {
    render(<ExportStep />)
    expect(screen.getByRole('button', { name: 'GTFS を出力する' })).toHaveProperty('disabled', true)
    expect(screen.getByText('方針を適用してから出力できます。')).toBeTruthy()
  })

  it('出力の前に、有効期間・§5.10 の文言・実施日までの日数の注意・出典を出す', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    render(<ExportStep />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('有効期間:2026年11月1日(日)〜2026年11月30日(月)(30日)')
    expect(text).toContain('期間の中で平日ダイヤが走る日')
    expect(text).toContain('出力した GTFS だけでは元に戻せません')
    // 開始日(11/1)が今日(10/20)より先:公開の時期の注意と、実施まで 12 日の注意
    expect(document.querySelector('[data-code="futureStart"]')).not.toBeNull()
    expect(document.querySelector('[data-code="leadTimeUnder30"]')?.textContent).toContain('実施まで 12 日です')
    expect(text).toContain('全曜日で便がなくなる系統:1 系統(3)')
    expect(text).toContain('Dispatcher で減便を反映して加工しています')
  })

  it('feed_version の入力欄:既定は空で出力の日時、入れた値が出力と ZIP の feed_info に入る', async () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    render(<ExportStep />)
    const field = screen.getByLabelText('出力する feed_version') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toContain('202610201200')
    expect(screen.getByText(/入力の feed_version は 202609171038/)).toBeTruthy()

    fireEvent.change(field, { target: { value: '202611050900' } })
    expect(useEditStore.getState().feedVersion).toBe('202611050900')
    expect(document.body.textContent).toContain('202609171038 → 202611050900')
    fireEvent.click(screen.getByRole('button', { name: 'GTFS を出力する' }))
    await waitFor(() => expect(writeGtfsZip).toHaveBeenCalledTimes(1))
    const input = writeGtfsZip.mock.calls[0][0]
    expect(input.edited.tables.get('feed_info')?.rows[0].feed_version).toBe('202611050900')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('feed_version 202611050900'))
  })

  it('入れた feed_version が入力以下なら注意を出し、同じなら出力を止める。読み込み直すと空に戻る', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    render(<ExportStep />)
    const field = screen.getByLabelText('出力する feed_version')
    const button = screen.getByRole('button', { name: 'GTFS を出力する' })

    fireEvent.change(field, { target: { value: '202501010000' } })
    expect(document.querySelector('[data-code="form2.feedVersionNotIncreasing"]')?.textContent).toContain('以下です')
    expect(button).toHaveProperty('disabled', false)

    // 入力と同じ値は検証の誤り(基準と同じ feed_version)。出力を止める
    fireEvent.change(field, { target: { value: '202609171038' } })
    expect(button).toHaveProperty('disabled', true)

    // 改行などは入れられない
    fireEvent.change(field, { target: { value: 'a\tb' } })
    expect(button).toHaveProperty('disabled', true)
    expect(screen.getAllByText('feed_version に改行や制御文字は使えません。').length).toBeGreaterThan(0)

    fireEvent.change(field, { target: { value: '202611050900' } })
    expect(document.querySelector('[data-code="form2.feedVersionNotIncreasing"]')).toBeNull()
    expect(button).toHaveProperty('disabled', false)

    act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'dohoku.zip', sample: SAMPLE }))
    expect(useEditStore.getState().feedVersion).toBe('')
  })

  it('trip_id の注意を出す。写す元のダイヤは方針に合わせる(方針が無いときは「入れ替え先」)', () => {
    render(<ExportStep />)
    expect(screen.getByTestId('trip-id-note').textContent).toBe(
      '足し戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は入れ替え先のダイヤの運用とは対応しません。',
    )
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    expect(screen.getByTestId('trip-id-note').textContent).toBe(
      '足し戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は出力の土曜ダイヤの運用とは対応しません。',
    )
  })

  it('方針が「平日を日祝ダイヤに」なら、trip_id の注意は日祝ダイヤと書く', () => {
    const op = policy()
    if (op.type !== 'applyPolicy') throw new Error('方針の操作ではありません')
    act(() => {
      useEditStore.getState().propose({ ...op, settings: { ...op.settings, kind: 'weekdayToSundayHoliday', replacementService: 'SU' } }, 'user')
      useEditStore.getState().commit()
    })
    render(<ExportStep />)
    expect(screen.getByTestId('trip-id-note').textContent).toBe(
      '足し戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は出力の日祝ダイヤの運用とは対応しません。',
    )
  })

  describe('減便をやめる版', () => {
    function openRevert(): HTMLElement {
      fireEvent.click(screen.getByRole('button', { name: '減便をやめる版を作る' }))
      return document.getElementById('revert-body')!
    }

    /**
     * 日付('YYYYMMDD')のセルを、表示している月の日付の数字で探す(セルには日付の数字だけが入る。
     * HolidayCalendar は前後の月の日を出さないので、数字は表示している月の中で1つに決まる)
     */
    function dayCell(container: HTMLElement, date: string): HTMLButtonElement {
      const day = String(Number(date.slice(6, 8)))
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-kind]')).find((b) => b.textContent === day)
      if (!button) throw new Error(`${date} のセルが見つかりません`)
      return button
    }

    it('履歴が空でも、戻す日を選んで出力できる。便は読み込んだ GTFS のまま、有効期間は戻す日〜入力の末日、feed_version は新しくする', async () => {
      render(<ExportStep />)
      const body = openRevert()
      // 既定の戻す日は今日(10/20)
      expect(body.textContent).toContain('有効期間:2026年10月20日(火)〜2026年11月30日(月)(42日)')
      fireEvent.click(screen.getByRole('button', { name: '次の月へ' }))
      fireEvent.click(dayCell(body, '20261115'))
      expect(body.textContent).toContain('有効期間:2026年11月15日(日)〜2026年11月30日(月)(16日)')
      expect(body.textContent).toContain('2026年10月1日(木)〜2026年11月14日(土) は出力に含まれません')
      expect(body.textContent).toContain('便と時刻は読み込んだ GTFS のままで、減便の方針と足し戻しは入りません')
      // 形2の文言は言い換え・除く(方針の対象・形2の理由の文を出さない)
      expect(body.querySelector('[data-code="weekdayNotRunning"]')).toBeNull()
      expect(body.querySelector('[data-code="validityGapBefore"]')).toBeNull()
      expect(body.textContent).not.toContain('減便後の平日ダイヤ')
      // 16 日(30 日未満)の注意と、開始日が今日より先の注意
      expect(body.querySelector('[data-code="validityUnder30"]')).not.toBeNull()
      expect(body.querySelector('[data-code="futureStart"]')).not.toBeNull()
      expect(body.querySelector('[data-severity="error"]')).toBeNull()
      // 便を消さない版なので、便の削除の審査の注意は出さない
      expect(body.textContent).not.toContain('便の削除')

      fireEvent.click(screen.getByRole('button', { name: '減便をやめる版を出力する' }))
      await waitFor(() => expect(writeGtfsZip).toHaveBeenCalledTimes(1))
      const input = writeGtfsZip.mock.calls[0][0]
      const baseFeed = useEditStore.getState().base!.feed
      // 便は変えない(元のバイト列のまま書く)
      expect(input.edited.tables.get('trips')).toBe(baseFeed.tables.get('trips'))
      expect(input.edited.tables.get('stop_times')).toBe(baseFeed.tables.get('stop_times'))
      const info = input.edited.tables.get('feed_info')!.rows[0]
      expect([info.feed_start_date, info.feed_end_date, info.feed_version]).toEqual(['20261115', '20261130', '202610201200'])
      expect(input.edited.tables.get('calendar')!.rows.every((r) => r.start_date === '20261115' && r.end_date === '20261130')).toBe(true)
      expect(input.attribution).toContain('Dispatcher で有効期間と feed_version を書き換えています(便は元のまま。加工日時 2026年10月20日 12:00)')
      expect(input.attribution).not.toContain('減便を反映して')
      const status = await screen.findByRole('status', { name: '減便をやめる版の出力' })
      expect(status.textContent).toContain('dohoku_dispatcher_202610201200_restore.zip')
      expect(status.textContent).toContain('戻す日 2026年11月15日(日)')
      // 減便の出力(承認済みの計画)は、履歴が空なので押せないまま
      expect(screen.getByRole('button', { name: 'GTFS を出力する' })).toHaveProperty('disabled', true)
    })

    it('新しい有効期間に走らなくなる service の便を除くときは、便の削除の審査の注意を出す', () => {
      // 10/31 で終わる平日の service(S11)の便を足す。戻す日を 11/15 にすると S11 は走らなくなり、便ごと除く
      let feed = smallFeed()
      feed = withRows(feed, 'calendar', [
        ...feed.tables.get('calendar')!.rows,
        { service_id: 'S11', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20261031' },
      ])
      feed = withRows(feed, 'trips', [...feed.tables.get('trips')!.rows, { route_id: 'R1', service_id: 'S11', trip_id: 'R1_1200_S11', trip_headsign: '市役所', block_id: '' }])
      feed = withRows(feed, 'stop_times', [
        ...feed.tables.get('stop_times')!.rows,
        { trip_id: 'R1_1200_S11', arrival_time: '12:00:00', departure_time: '12:00:00', stop_id: 'A', stop_sequence: '1', pickup_type: '0', drop_off_type: '1' },
        { trip_id: 'R1_1200_S11', arrival_time: '12:10:00', departure_time: '12:10:00', stop_id: 'B', stop_sequence: '2', pickup_type: '1', drop_off_type: '0' },
      ])
      act(() => useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'dohoku.zip', sample: SAMPLE }))
      render(<ExportStep />)
      const body = openRevert()
      // 既定の戻す日(今日 10/20)では S11 はまだ走るので、便は除かず注意も出さない
      expect(body.textContent).not.toContain('便の削除')
      fireEvent.click(screen.getByRole('button', { name: '次の月へ' }))
      fireEvent.click(dayCell(body, '20261115'))
      expect(body.textContent).toContain('S11:1 便')
      const notes = [...body.querySelectorAll('[data-code="publishNotes"]')].map((e) => e.textContent ?? '')
      expect(notes.some((t) => t.includes('便の削除が大きいと、公開先の審査が長引くことがあります。'))).toBe(true)
    })

    it('年末年始と祝日の文言は「減便後の平日ダイヤ」を「平日ダイヤ」に言い換える(validate/edit.ts の文言が変わったら気づけるように)', () => {
      // 有効期間を 2027/1/31 まで延ばし、戻す日(今日 10/20)からの有効期間に年末年始と平日の祝日を入れる
      let feed = smallFeed()
      feed = withRows(feed, 'calendar', feed.tables.get('calendar')!.rows.map((r) => ({ ...r, end_date: '20270131' })))
      feed = withRows(feed, 'feed_info', feed.tables.get('feed_info')!.rows.map((r) => ({ ...r, feed_end_date: '20270131' })))
      act(() => {
        useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'dohoku.zip', sample: SAMPLE })
        useHolidayStore.setState({
          holidays: { status: 'ready', list: { names: new Map([['20261123', '勤労感謝の日']]), first: '19550101', coveredUntil: '20271231', source: 'test' } },
        })
      })
      render(<ExportStep />)
      const body = openRevert()
      const yearEnd = body.querySelector('[data-code="yearEnd"]')
      expect(yearEnd?.textContent).toContain('は平日ダイヤで走ります。年末年始の運行を確かめてください。')
      const holiday = body.querySelector('[data-code="holidayWithoutException"]')
      expect(holiday?.textContent).toContain('平日ダイヤ(WK)')
      expect(body.textContent).not.toContain('減便後')
    })

    it('承認した方針に期間の終わりがあれば、既定の戻す日はその翌日。下書きがあっても出力でき、7 日以下の有効期間は止める', async () => {
      const op = policy()
      if (op.type !== 'applyPolicy') throw new Error('方針の操作ではありません')
      act(() => {
        useEditStore.getState().propose({ ...op, settings: { ...op.settings, period: { start: '20261101', end: '20261115' } } }, 'user')
        useEditStore.getState().commit()
        useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
      })
      render(<ExportStep />)
      // 減便の出力の要約から、この版へ案内する
      expect(document.body.textContent).toContain('元のダイヤに戻す版は、この画面の下の「減便をやめる版」で作れます。')
      const body = openRevert()
      expect(body.textContent).toContain('既定は、承認した方針の期間の終わり(2026年11月15日(日))の翌日です。')
      expect(body.textContent).toContain('有効期間:2026年11月16日(月)〜2026年11月30日(月)(15日)')
      const button = screen.getByRole('button', { name: '減便をやめる版を出力する' })
      expect(button).toHaveProperty('disabled', false)

      // 11/28(土)からでは 3 日しかなく、出力を止める
      fireEvent.click(dayCell(body, '20261128'))
      expect(body.querySelector('[data-code="shortValidity"]')?.getAttribute('data-severity')).toBe('error')
      expect(button).toHaveProperty('disabled', true)

      // feed_version は自分で入れられる。制御文字は止める
      const field = screen.getByLabelText('減便をやめる版の feed_version')
      fireEvent.click(dayCell(body, '20261121'))
      fireEvent.change(field, { target: { value: 'a\tb' } })
      expect(button).toHaveProperty('disabled', true)
      fireEvent.change(field, { target: { value: '202611300000' } })
      expect(button).toHaveProperty('disabled', false)
      fireEvent.click(button)
      await waitFor(() => expect(writeGtfsZip).toHaveBeenCalledTimes(1))
      const info = writeGtfsZip.mock.calls[0][0].edited.tables.get('feed_info')!.rows[0]
      expect([info.feed_start_date, info.feed_version]).toEqual(['20261121', '202611300000'])
      // 減便の出力の feed_version の欄は変えない
      expect(useEditStore.getState().feedVersion).toBe('')
    })
  })
})

