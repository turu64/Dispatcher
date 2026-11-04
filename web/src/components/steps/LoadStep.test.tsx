// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { GtfsFeed } from '@/gtfs/load'
import { useChatStore } from '@/store/chat'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useHolidayStore } from '@/store/holidays'
import { useReachStore } from '@/store/reach'
import { useResearchStore } from '@/store/research'
import { resetAll } from '@/store/reset'
import { useSidePanelStore } from '@/store/sidePanel'
import { useStepStore } from '@/store/steps'
import LoadStep from './LoadStep'
import { deleteConfirmMessage } from './loadText'

// Radix の Select は jsdom に無い scrollIntoView・ポインターの捕捉を使う
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}

// 読み込みの手順は、サンプルの有無をサーバーに聞く。既定ではサーバーに届かないものとし、読み込みの試験では mock を差し替える
const mocks = vi.hoisted(() => ({
  fetchSampleGtfsInfo: vi.fn(),
  fetchSampleGtfs: vi.fn(),
  loadGtfsInWorker: vi.fn(),
}))
vi.mock('@/gtfs/sample', () => ({
  fetchSampleGtfsInfo: mocks.fetchSampleGtfsInfo,
  fetchSampleGtfs: mocks.fetchSampleGtfs,
}))
vi.mock('@/gtfs/workerClient', () => ({ loadGtfsInWorker: mocks.loadGtfsInWorker }))

beforeEach(() => {
  // jsdom の Blob には arrayBuffer が無い。中身は使わない(Worker の mock が受け取るだけ)ので、大きさだけ合わせる
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = function (this: Blob) {
      return Promise.resolve(new ArrayBuffer(this.size))
    }
  }
  mocks.fetchSampleGtfsInfo.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.fetchSampleGtfs.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.loadGtfsInWorker.mockReset().mockImplementation(() => new Promise(() => {}))
  // ダイヤのグループ分けは祝日一覧の状態が決まってから計算する。祝日の無い一覧を読めたことにする
  useHolidayStore.setState({ holidays: { status: 'ready', list: { names: new Map(), first: '20200101', coveredUntil: '20291231', source: '' } } })
})

afterEach(() => {
  cleanup()
  act(() => resetAll('delete'))
})

function show(feed: GtfsFeed) {
  act(() => useGtfsStore.getState().setLoaded({ label: 'dohoku.zip', feed }))
  render(<LoadStep />)
}

describe('LoadStep の版と期間', () => {
  it('feed_version・有効期間と、ダイヤのグループ分けの要約を出す。service_id ごとの便数は「表を開く」で出す', () => {
    show(smallFeed())
    const text = screen.getByLabelText('読み込んだ GTFS の版と期間').textContent ?? ''
    expect(text).toContain('feed_version:202609171038')
    expect(text).toContain('有効期間:2026年10月1日(木)〜2026年11月30日(月)')
    expect(text).not.toContain('求めました')
    // 単純な GTFS は1行の要約
    expect(screen.getByTestId('service-groups-summary').textContent).toBe('平日 WK・土曜 SA・日祝 SU に分かれています(走る日から判定しました)。')
    // 単純な GTFS(道北バスなど)では、Jev に送るかを聞かない。Jev に送るかのスイッチも無い
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('table', { name: /ダイヤのグループ分け/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '表を開く' }))
    const table = screen.getByRole('table', { name: 'ダイヤのグループ分け(平日を土曜ダイヤに)' })
    // 平日の便は R1 が 2 便、R2 と R3 が 1 便ずつ
    const wk = table.querySelector('[data-service="WK"]')!
    expect(wk.textContent).toContain('4 便・3 系統')
    expect(table.querySelector('[data-service="SA"]')!.textContent).toContain('入れ替えに使う')

    // 表で直したら、要約は「走る日から判定しました」と言わず、直した分け方と書く
    fireEvent.keyDown(within(table).getByRole('combobox', { name: 'SA の便を入れる平日の service' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: '使わない' }))
    expect(screen.getByTestId('service-groups-summary').textContent).toBe(
      '直した分け方:平日 WK・日祝 SU。土曜ダイヤに変えるときは、入れ替えに使う service がないため、WK の便を期間の間なくします。',
    )
  })

  it('feed_info が無ければ calendar から求めたと添え、feed_version は (空)', () => {
    const feed = smallFeed()
    const tables = new Map(feed.tables)
    tables.delete('feed_info')
    show({ ...feed, tables })
    const text = screen.getByLabelText('読み込んだ GTFS の版と期間').textContent ?? ''
    expect(text).toContain('feed_version:(空)')
    expect(text).toContain('2026年10月1日(木)〜2026年11月30日(月)(feed_info にないため、calendar・calendar_dates から求めました)')
  })
})

/** 外から解決できる Promise */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function zipFile(name: string, bytes: number) {
  return new File([new Uint8Array(bytes)], name, { type: 'application/zip' })
}

const SAMPLE_INFO = { available: true, name: '道北バス', source: '出典', license: 'CC BY 4.0' }
const ATTACHMENT = '読み込んだ GTFS のファイル'

describe('LoadStep の読み込みの欄', () => {
  it('「ファイルを選ぶ」と「サンプルを読み込む」の間に「または」の区切りを出す', () => {
    render(<LoadStep />)
    const row = screen.getByText('または').parentElement!
    expect(row.querySelectorAll('[data-slot="separator"]')).toHaveLength(2)
    // 文字の順:ファイルを選ぶ → または → サンプルを読み込む
    const text = document.body.textContent ?? ''
    expect(text.indexOf('ファイルを選ぶ')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('ファイルを選ぶ')).toBeLessThan(text.indexOf('または'))
    expect(text.indexOf('または')).toBeLessThan(text.indexOf('サンプルを読み込む'))
  })

  it('input は「GTFS の ZIP ファイル」の名前で引け、隠れている。「ファイルを選ぶ」で開く', () => {
    render(<LoadStep />)
    const input = screen.getByLabelText('GTFS の ZIP ファイル') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.hidden).toBe(true)
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'ファイルを選ぶ' }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('ファイルを読み込む間は、押したボタンだけが処理中になり、もう一方は無効。「読み込み中…」の行は無い', async () => {
    mocks.fetchSampleGtfsInfo.mockResolvedValue(SAMPLE_INFO)
    const worker = deferred<GtfsFeed>()
    mocks.loadGtfsInWorker.mockReturnValue(worker.promise)
    render(<LoadStep />)
    await waitFor(() => expect((screen.getByRole('button', { name: /サンプルを読み込む/ }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.change(screen.getByLabelText('GTFS の ZIP ファイル'), { target: { files: [zipFile('a.zip', 2048)] } })

    // 押した「ファイルを選ぶ」:処理中(読み上げの名前は「読み込み中」)
    const picking = await screen.findByRole('button', { name: '読み込み中' })
    expect(picking.getAttribute('aria-busy')).toBe('true')
    expect((picking as HTMLButtonElement).disabled).toBe(true)
    expect(picking.textContent).toContain('ファイルを選ぶ')
    // もう一方:無効だが処理中ではない
    const other = screen.getByRole('button', { name: /サンプルを読み込む/ }) as HTMLButtonElement
    expect(other.disabled).toBe(true)
    expect(other.getAttribute('aria-busy')).toBeNull()
    expect(screen.queryByText('読み込み中…')).toBeNull()
    // Attachment:ファイル名・大きさ・読み込み中
    const attachment = screen.getByRole('group', { name: ATTACHMENT })
    expect(attachment.getAttribute('data-state')).toBe('processing')
    expect(within(attachment).getByText('a.zip')).toBeTruthy()
    expect(attachment.textContent).toContain('2 KB・読み込み中')

    await act(async () => worker.resolve(smallFeed()))
    await waitFor(() => expect(screen.queryByRole('button', { name: '読み込み中' })).toBeNull())
  })

  it('サンプルを読み込む間は、サンプルのボタンだけが処理中になる', async () => {
    mocks.fetchSampleGtfsInfo.mockResolvedValue(SAMPLE_INFO)
    render(<LoadStep />)
    const sampleButton = await screen.findByRole('button', { name: /サンプルを読み込む/ })
    await waitFor(() => expect((sampleButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(sampleButton)

    const busy = await screen.findByRole('button', { name: '読み込み中' })
    expect(busy.textContent).toContain('サンプルを読み込む')
    expect(busy.getAttribute('aria-busy')).toBe('true')
    const file = screen.getByRole('button', { name: 'ファイルを選ぶ' }) as HTMLButtonElement
    expect(file.disabled).toBe(true)
    expect(file.getAttribute('aria-busy')).toBeNull()
  })

  it('読み込めたら、Attachment にファイル名・大きさ・読み込み済み・時刻を出し、手順を移って戻っても残る', async () => {
    mocks.loadGtfsInWorker.mockResolvedValue(smallFeed())
    const { unmount } = render(<LoadStep />)
    fireEvent.change(screen.getByLabelText('GTFS の ZIP ファイル'), { target: { files: [zipFile('dohoku.zip', 3 * 1024 * 1024)] } })

    await waitFor(() => expect(screen.getByRole('group', { name: ATTACHMENT }).getAttribute('data-state')).toBe('done'))
    const text = screen.getByRole('group', { name: ATTACHMENT }).textContent ?? ''
    expect(text).toContain('dohoku.zip')
    expect(text).toMatch(/3\.0 MB・読み込み済み・\d{2}:\d{2}/)
    expect(text).not.toContain('サンプル')

    // 手順を離れて戻る(部品を作り直す)
    unmount()
    render(<LoadStep />)
    const again = screen.getByRole('group', { name: ATTACHMENT }).textContent ?? ''
    expect(again).toMatch(/dohoku\.zip.*3\.0 MB・読み込み済み・\d{2}:\d{2}/)
  })

  it('サンプルを読み込んだら「サンプル」の印を出し、大きさは取ってきた ZIP のバイト数から出す', async () => {
    mocks.fetchSampleGtfsInfo.mockResolvedValue(SAMPLE_INFO)
    mocks.fetchSampleGtfs.mockResolvedValue(new Blob([new Uint8Array(512 * 1024)]))
    mocks.loadGtfsInWorker.mockResolvedValue(smallFeed())
    render(<LoadStep />)
    const sampleButton = await screen.findByRole('button', { name: /サンプルを読み込む/ })
    await waitFor(() => expect((sampleButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(sampleButton)

    await waitFor(() => expect(screen.getByRole('group', { name: ATTACHMENT }).getAttribute('data-state')).toBe('done'))
    const attachment = screen.getByRole('group', { name: ATTACHMENT })
    expect(within(attachment).getByText('サンプル')).toBeTruthy()
    expect(attachment.textContent).toContain('512 KB・読み込み済み')
    expect(useGtfsStore.getState().size).toBe(512 * 1024)
  })

  it('失敗したら、Attachment を error にして「失敗」を出し、理由はその下に出す', async () => {
    mocks.loadGtfsInWorker.mockRejectedValue(new Error('ZIP として開けませんでした。'))
    render(<LoadStep />)
    fireEvent.change(screen.getByLabelText('GTFS の ZIP ファイル'), { target: { files: [zipFile('bad.zip', 100)] } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('ZIP として開けませんでした。')
    const attachment = screen.getByRole('group', { name: ATTACHMENT })
    expect(attachment.getAttribute('data-state')).toBe('error')
    expect(attachment.textContent).toContain('bad.zip')
    expect(attachment.textContent).toContain('1 KB・失敗')
    // Attachment の下に理由がある
    expect(attachment.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 処理中の状態は残らない
    expect(screen.queryByRole('button', { name: '読み込み中' })).toBeNull()
    expect((screen.getByRole('button', { name: 'ファイルを選ぶ' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

const DELETE = '読み込んだ GTFS を削除'
const CONFIRM = '読み込んだ GTFS の削除の確認'

async function loadFile(name = 'dohoku.zip') {
  const file = zipFile(name, 2048)
  fireEvent.change(screen.getByLabelText('GTFS の ZIP ファイル'), { target: { files: [file] } })
  await waitFor(() => expect(screen.getByRole('group', { name: ATTACHMENT }).getAttribute('data-state')).toBe('done'))
  return file
}

function policyOp() {
  const { addBackTripIds: _a, ...settings } = basePlan()
  return { type: 'applyPolicy' as const, settings, reason: { category: null, note: '' } }
}

describe('読み込んだ GTFS の削除', () => {
  it('読み込む前と、読み込んでいる間は、削除のボタンを出さない', async () => {
    const worker = deferred<GtfsFeed>()
    mocks.loadGtfsInWorker.mockReturnValue(worker.promise)
    render(<LoadStep />)
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull()
    fireEvent.change(screen.getByLabelText('GTFS の ZIP ファイル'), { target: { files: [zipFile('a.zip', 2048)] } })
    await screen.findByRole('button', { name: '読み込み中' })
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull()
    await act(async () => worker.resolve(smallFeed()))
    expect(await screen.findByRole('button', { name: DELETE })).toBeTruthy()
  })

  it('押すとすぐには消さず、画面の中で確かめる。「やめる」なら何も消えない', async () => {
    mocks.loadGtfsInWorker.mockResolvedValue(smallFeed())
    render(<LoadStep />)
    await loadFile()
    const base = useEditStore.getState().base
    const button = screen.getByRole('button', { name: DELETE })
    fireEvent.click(button)

    const confirm = screen.getByRole('group', { name: CONFIRM })
    expect(confirm.textContent).toContain(
      '読み込んだ GTFS と、減便の方針・平日に戻した便などの編集、前提情報の調査の結果、AI との会話を消して、最初の状態に戻します。パソコンの中の元のファイルは消えません。',
    )
    expect(within(confirm).getByRole('button', { name: '削除する' })).toBeTruthy()
    expect(button.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(within(confirm).getByRole('button', { name: 'やめる' }))
    expect(screen.queryByRole('group', { name: CONFIRM })).toBeNull()
    expect(useEditStore.getState().base).toBe(base)
    expect(useGtfsStore.getState().label).toBe('dohoku.zip')
    expect(screen.getByRole('group', { name: ATTACHMENT }).getAttribute('data-state')).toBe('done')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: DELETE }))
  })

  it('確かめの文に、承認待ちの下書きと承認済みの編集の数を添える', async () => {
    mocks.loadGtfsInWorker.mockResolvedValue(smallFeed())
    render(<LoadStep />)
    await loadFile()
    act(() => {
      expect(useEditStore.getState().propose(policyOp(), 'user').ok).toBe(true)
      expect(useEditStore.getState().commit()).toEqual({ ok: true })
      expect(useEditStore.getState().propose(policyOp(), 'user').ok).toBe(true)
    })
    const draftId = useEditStore.getState().draft!.id
    fireEvent.click(screen.getByRole('button', { name: DELETE }))
    expect(screen.getByRole('group', { name: CONFIRM }).textContent).toContain(`承認待ちの下書き #${draftId} と、承認済みの編集 1 件も消えます。`)
  })

  it('「削除する」で、画面を開いた直後と同じに戻り、ファイルの選択が空に戻る。そのあと同じファイルをもう一度読み込める', async () => {
    mocks.loadGtfsInWorker.mockResolvedValue(smallFeed())
    render(<LoadStep />)
    const file = await loadFile()
    act(() => {
      useEditStore.getState().propose(policyOp(), 'user')
      useEditStore.getState().commit()
      useChatStore.setState({ items: [{ id: 1, kind: 'user', text: 'こんにちは' } as never] })
      useResearchStore.setState({ selected: ['school:1'] })
      useStepStore.getState().go('policy')
      useSidePanelStore.getState().show('chat')
    })

    fireEvent.click(screen.getByRole('button', { name: DELETE }))
    fireEvent.click(within(screen.getByRole('group', { name: CONFIRM })).getByRole('button', { name: '削除する' }))

    // 画面:ファイルの欄・読み込んだ GTFS の表・確かめが消え、「ファイルを選ぶ」に焦点が移る
    expect(screen.queryByRole('group', { name: ATTACHMENT })).toBeNull()
    expect(screen.queryByRole('group', { name: CONFIRM })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'dohoku.zip' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'ファイルを選ぶ' }))
    expect((screen.getByLabelText('GTFS の ZIP ファイル') as HTMLInputElement).value).toBe('')
    // store:GTFS・編集・到達圏・会話・前提情報・手順・タブ
    expect(useGtfsStore.getState().feed).toBeNull()
    expect(useEditStore.getState()).toMatchObject({ base: null, history: [], versions: [], draft: null })
    expect(useReachStore.getState()).toMatchObject({ source: null, edited: null, snapshot: null })
    expect(useChatStore.getState().items).toEqual([])
    expect(useResearchStore.getState().selected).toBeNull()
    expect(useStepStore.getState().current).toBe('load')
    expect(useSidePanelStore.getState().tab).toBe('edit')

    // 同じファイルをもう一度選ぶ
    fireEvent.change(screen.getByLabelText('GTFS の ZIP ファイル'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('group', { name: ATTACHMENT }).getAttribute('data-state')).toBe('done'))
    expect(mocks.loadGtfsInWorker).toHaveBeenCalledTimes(2)
    expect(useEditStore.getState().base?.label).toBe('dohoku.zip')
    // 削除のあとに読み込んでも、「読み込み直したため…」の知らせは出さない
    expect(useChatStore.getState().items).toEqual([])
  })

  it('読み込みに失敗した後は削除のボタンを出さない', async () => {
    mocks.loadGtfsInWorker.mockRejectedValue(new Error('ZIP として開けませんでした。'))
    render(<LoadStep />)
    fireEvent.change(screen.getByLabelText('GTFS の ZIP ファイル'), { target: { files: [zipFile('bad.zip', 100)] } })
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull()
  })

  it('サンプルなら、元のファイルではなく、もう一度読み込めることを添える', () => {
    expect(deleteConfirmMessage({ draft: null, committed: 0, sample: true })).toBe(
      '読み込んだ GTFS と、減便の方針・平日に戻した便などの編集、前提情報の調査の結果、AI との会話を消して、最初の状態に戻します。サンプルは、もう一度読み込めます。',
    )
    expect(deleteConfirmMessage({ draft: { id: '3' }, committed: 0, sample: false })).toContain('承認待ちの下書き #3 も消えます。')
    expect(deleteConfirmMessage({ draft: null, committed: 2, sample: false })).toContain('承認済みの編集 2 件も消えます。')
  })
})
