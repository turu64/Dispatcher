// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import type { GtfsFeed } from '@/gtfs/load'
import { useGtfsStore } from '@/store/gtfs'
import LoadStep from './LoadStep'

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
})

afterEach(() => {
  cleanup()
  act(() => useGtfsStore.getState().clear())
})

function show(feed: GtfsFeed) {
  act(() => useGtfsStore.getState().setLoaded({ label: 'dohoku.zip', feed }))
  render(<LoadStep />)
}

describe('LoadStep の版と期間', () => {
  it('feed_version・有効期間・service_id ごとの便数を出す', () => {
    show(smallFeed())
    const text = screen.getByLabelText('読み込んだ GTFS の版と期間').textContent ?? ''
    expect(text).toContain('feed_version:202609171038')
    expect(text).toContain('有効期間:2026年10月1日(木)〜2026年11月30日(月)')
    expect(text).not.toContain('求めました')
    expect(text).toContain('WK(平日):')
    expect(text).toContain('SA(土曜):')
    expect(text).toContain('SU(日曜):')
    // 平日の便は R1 が 2 便、R2 と R3 が 1 便ずつ
    expect(text).toContain('WK(平日):4 便')
  })

  it('feed_info が無ければ calendar から求めたと添え、feed_version は (空)', () => {
    const feed = smallFeed()
    const tables = new Map(feed.tables)
    tables.delete('feed_info')
    show({ ...feed, tables })
    const text = screen.getByLabelText('読み込んだ GTFS の版と期間').textContent ?? ''
    expect(text).toContain('feed_version:(空)')
    expect(text).toContain('2026年10月1日(木)〜2026年11月30日(月)(feed_info に無いため、calendar・calendar_dates から求めました)')
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
