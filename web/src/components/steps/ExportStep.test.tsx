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
})
