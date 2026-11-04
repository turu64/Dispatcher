// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyForm2 } from '@/gtfs/edit/form2'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
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
    expect(screen.getByText(`承認待ちの下書き #${draftId} があります。「承認する」または「やめる」を押してから出力してください。`)).toBeTruthy()

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

    // 出力し直してから、すべて戻す:履歴が空なので、前の出力は残さず「減便の方針を承認すると」だけを出す
    fireEvent.click(screen.getByRole('button', { name: 'GTFS を出力する' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('出力しました'))
    act(() => useEditStore.getState().undoAll())
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('減便の方針を承認すると出力できます。')).toBeTruthy()
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

  it('ZIP を書いている間は、押した出力のボタンだけが処理中の形になり、文字の「出力中…」は出さない', async () => {
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
    const busy = screen.getByRole('button', { name: '出力中' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('出力中…')).toBeNull()
    await act(async () => finish(new Blob(['zip'])))
    await waitFor(() => expect(screen.getByRole('button', { name: 'GTFS を出力する' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'GTFS を出力する' }).hasAttribute('aria-busy')).toBe(false)
  })

  it('履歴が空なら出力を押せない', () => {
    render(<ExportStep />)
    expect(screen.getByRole('button', { name: 'GTFS を出力する' })).toHaveProperty('disabled', true)
    expect(screen.getByText('減便の方針を承認すると出力できます。')).toBeTruthy()
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

  it('trip_id の注意を出す。入れ替えに使うダイヤは方針に合わせる(方針が無いときは「入れ替えに使うダイヤ」)', () => {
    render(<ExportStep />)
    expect(screen.getByTestId('trip-id-note').textContent).toBe(
      '平日に戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は入れ替えに使うダイヤの運用とは対応しません。',
    )
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    expect(screen.getByTestId('trip-id-note').textContent).toBe(
      '平日に戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は出力の土曜ダイヤの運用とは対応しません。',
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
      '平日に戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は出力の日祝ダイヤの運用とは対応しません。',
    )
  })

  it('期間の後のダイヤは出力しない:元のダイヤに戻す版は作れず、期間に終わりがあれば公開し直す旨を出す', () => {
    const op = policy()
    if (op.type !== 'applyPolicy') throw new Error('方針の操作ではありません')
    act(() => {
      useEditStore.getState().propose({ ...op, settings: { ...op.settings, period: { start: '20261101', end: '20261115' } } }, 'user')
      useEditStore.getState().commit()
    })
    render(<ExportStep />)
    const notes = screen.getByRole('list', { name: '有効期間と期間の外' })
    expect(notes.textContent).toContain(
      '2026年11月16日 以降は出力に含まれず、経路検索に便が出なくなります。元のダイヤには自動で戻りません。Dispatcher は期間の後のダイヤを出力しないため、期間が終わる前に、事業者のふだんの手順で元のダイヤの GTFS を公開し直してください。元の ZIP は保存しておいてください。',
    )
    expect(document.body.textContent).not.toContain('戻す版')
    expect(screen.queryByRole('button', { name: /元のダイヤに戻す/ })).toBeNull()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['GTFS を出力する'])
  })

  it('当面の間なら、期間の後の文は入力の末日までの文のまま', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    render(<ExportStep />)
    const notes = screen.getByRole('list', { name: '有効期間と期間の外' })
    expect(notes.textContent).toContain('出力の有効期間は 2026年11月30日(入力の GTFS の末日)までです。減便が続くときは、次の版でも同じ減便の方針を承認してください。')
    expect(notes.textContent).not.toContain('公開し直して')
  })
})
