// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { applyForm2 } from '@/gtfs/edit/form2'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import { planOf } from '@/gtfs/edit/ops'
import { serializeTable } from '@/gtfs/write'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useHolidayStore } from '@/store/holidays'
import { useReachStore } from '@/store/reach'
import DateBandStep from './DateBandStep'
import ExportStep from './ExportStep'
import PolicyStep from './PolicyStep'
import ReachStep from './ReachStep'
import RestoreStep from './RestoreStep'

/**
 * 画面の流れ(方針の適用 → 対象便の確かめ → 承認 → 前後の比較 → 足し戻し → 元に戻す → 出力)を、
 * 手で作った小さなフィード(gtfs/edit/form2.fixture.ts)で通す。
 * 到達圏は Web Worker の代わりにその場で computeReach を呼び、参照データは無い(fallback)ものとする。ZIP の書き出しは偽物にする
 * (ZIP の中身は gtfs/write.test.ts が確かめる)。
 */

const writeGtfsZip = vi.hoisted(() => vi.fn(async (_input: unknown) => new Blob(['zip'])))

vi.mock('@/reach/workerClient', async () => {
  const { computeReach } = await import('@/reach/reach')
  return { computeReachInWorker: async (input: Parameters<typeof computeReach>[0]) => computeReach(input) }
})
vi.mock('@/reach/refData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/reach/refData')>()),
  fetchRefData: async (mesh1s: string[]) => ({ ok: false, mesh1s, missing: mesh1s, message: '参照データがありません(テスト)。' }),
}))
vi.mock('@/gtfs/write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/gtfs/write')>()),
  writeGtfsZip,
}))

/** 手順1の読み込み(LoadStep の open() と同じ順に store を呼ぶ) */
function load() {
  const feed = smallFeed()
  act(() => {
    useGtfsStore.getState().setLoaded({ label: 'test.zip', feed })
    const { stops, servicePeriod } = useGtfsStore.getState()
    useReachStore.getState().setSource({ feed, stops, period: servicePeriod })
    useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
  })
  return feed
}

function renderSteps() {
  return render(
    <TooltipProvider>
      <PolicyStep />
      <DateBandStep />
      <ReachStep />
      <RestoreStep />
      <ExportStep />
    </TooltipProvider>,
  )
}

/** 手順の見出し(「2. 減便の方針」など)のカード */
function step(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title })
  return heading.closest('[data-slot="card"]') as HTMLElement
}

beforeEach(() => {
  // 今日は 2026-10-20(日本時間)。小さなフィードの有効期間は 2026-10-01〜2026-11-30
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T00:30:00Z') })
  useHolidayStore.setState({
    holidays: {
      status: 'ready',
      list: {
        names: new Map([
          ['20261103', '文化の日'],
          ['20261123', '勤労感謝の日'],
        ]),
        first: '19550101',
        coveredUntil: '20271231',
        source: '内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成',
      },
    },
  })
  URL.createObjectURL = vi.fn(() => 'blob:dispatcher-test')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  writeGtfsZip.mockClear()
})

afterEach(() => {
  cleanup()
  act(() => {
    useEditStore.getState().setBase(null)
    useReachStore.getState().setSource(null)
    useGtfsStore.getState().clear()
  })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('編集の画面の流れ', () => {
  it('方針の適用 → 確かめ → 承認 → 比較 → 足し戻し → 元に戻す → 出力を、小さなフィードで通す', async () => {
    const base = load()
    renderSteps()

    // ---- 方針:service は曜日の列から推定し、既定の期間は今日から当面の間 ----
    const policy = step('2. 減便の方針')
    expect(within(policy).getByLabelText('平日のダイヤ(入れ替える側)')).toHaveProperty('value', 'WK')
    expect(within(policy).getByLabelText('土曜のダイヤ(写す元)')).toHaveProperty('value', 'SA')
    expect(within(policy).getByLabelText('開始日')).toHaveProperty('value', '2026-10-20')
    expect(within(policy).getByText(/期間の中の祝日:/).textContent).toContain('勤労感謝の日')
    fireEvent.click(within(policy).getByRole('button', { name: '対象便を確かめる' }))

    // ---- 対象便を確かめる(下書き)。全曜日で便がなくなる系統(R3)があるので、確かめのチェックまで進めない ----
    const review = within(policy).getByRole('region', { name: '対象便の確かめ' })
    expect(within(review).getByRole('heading', { name: (n) => n.startsWith('対象便を確かめる(下書き d') })).toBeTruthy()
    const counts = within(review).getByLabelText('平日便の件数').textContent ?? ''
    expect(counts).toContain('消える 3 便・入る 3 便・残る 1 便')
    expect(counts).toContain('全曜日で便がなくなる系統:1 系統')
    expect(review.textContent).toContain('出力する GTFS の有効期間は 2026年10月20日〜2026年11月30日(42日)です。')
    // 祝日(11/23)に減便後の平日ダイヤが走る警告と、実施日までの日数の注意
    expect(review.querySelector('[data-code="holidayWithoutException"]')).not.toBeNull()
    expect(review.querySelector('[data-code="leadTimeUnder3"]')).not.toBeNull()
    // 下書きの間は、到達圏の表に「下書き」と出す
    await waitFor(() => expect(within(step('4. 到達圏(減便の前後)')).getByText('下書き')).toBeTruthy())
    expect(useEditStore.getState().history).toHaveLength(0)

    const proceed = within(review).getByRole('button', { name: 'この内容で進める' })
    expect(proceed).toHaveProperty('disabled', true)
    fireEvent.click(within(review).getByLabelText('全曜日で便がなくなる系統があることを確かめました'))
    expect(proceed).toHaveProperty('disabled', false)
    fireEvent.click(proceed)

    // ---- 承認したあと:適用した方針と件数 ----
    expect(useEditStore.getState().history).toHaveLength(1)
    const summary = within(policy).getByRole('region', { name: '適用した方針' })
    expect(summary.textContent).toContain('平日を土曜ダイヤに')
    expect(summary.textContent).toContain('2026年10月20日(火)〜当面の間')

    // ---- 前後の比較:同じ日付の基準と編集後。S9(学校前)は出力のどの日にも便が来ない ----
    const reach = step('4. 到達圏(減便の前後)')
    await waitFor(() => expect(within(reach).getByRole('heading', { name: '減便の前後' })).toBeTruthy())
    expect(within(reach).queryByText('下書き')).toBeNull()
    const zero = within(reach).getByRole('region', { name: '運行がゼロになる場所' })
    expect(zero.textContent).toContain('学校前')
    expect(zero.textContent).toContain('運行がゼロになる系統:1 系統')
    // 日付は出力の有効期間の中だけ
    expect(within(step('3. 日付と時間帯')).getByText(/比べられるのは出力の有効期間/)).toBeTruthy()

    // ---- 足し戻し:候補は手がかりの多い順(平日だけの系統 R3 が先頭)----
    const restore = step('5. 足し戻し')
    const candidates = within(restore).getByRole('list', { name: '足し戻す便の候補' })
    const first = within(candidates).getAllByRole('listitem')[0]
    expect(first.textContent).toContain('R3_0730_WK')
    expect(first.textContent).toContain('平日だけの系統')
    fireEvent.click(within(first).getByRole('checkbox'))
    fireEvent.change(within(restore).getByLabelText(/足し戻す理由/), { target: { value: '高校の通学' } })
    fireEvent.click(within(restore).getByRole('button', { name: '選んだ 1 便を足し戻す' }))

    expect(useEditStore.getState().history).toHaveLength(2)
    const added = within(restore).getByRole('region', { name: '足し戻した便' })
    expect(added.textContent).toContain('足し戻した便(1 便)')
    expect(added.textContent).toContain('理由:高校の通学')
    expect(added.textContent).toContain('足し戻した便 1 便、営業運行時間の合計 0時間20分')
    // 足し戻すと、S9 は運行がゼロの停留所でなくなる
    await waitFor(() => expect(within(step('4. 到達圏(減便の前後)')).getByRole('region', { name: '運行がゼロになる場所' }).textContent).toContain('運行がゼロになる停留所:0 件'))

    // ---- 元に戻す:足し戻しの前(方針だけ)に戻る ----
    const history = within(policy).getByRole('region', { name: '編集の履歴' })
    expect(within(history).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(within(history).getByRole('button', { name: '元に戻す' }))
    expect(useEditStore.getState().history).toHaveLength(1)
    expect(within(restore).queryByRole('region', { name: '足し戻した便' })).toBeNull()

    // ---- 出力:承認済みの計画で作り直して ZIP に書く ----
    const exportStep = step('6. GTFS を出力')
    expect(exportStep.textContent).toContain('有効期間:2026年10月20日(火)〜2026年11月30日(月)(42日)')
    fireEvent.click(within(exportStep).getByRole('button', { name: 'GTFS を出力する' }))
    await waitFor(() => expect(within(exportStep).getByRole('status').textContent).toContain('出力しました:test_dispatcher_202610200930.zip'))
    expect(writeGtfsZip).toHaveBeenCalledTimes(1)
    const input = writeGtfsZip.mock.calls[0][0] as { base: unknown; edited: { tables: Map<string, never> }; generatedAt: string; attribution: string }
    expect(input.base).toBe(base)
    expect(input.generatedAt).toBe('202610200930')
    // 出力は承認済みの計画(方針だけ。取り消した足し戻しは入らない)
    const expected = applyForm2(base, planOf(useEditStore.getState().history)!, { generatedAt: '202610200930' })
    if (!expected.ok) throw new Error(expected.message)
    const decode = (t: never) => new TextDecoder().decode(serializeTable(t))
    expect(decode(input.edited.tables.get('trips')!)).toBe(decode(expected.result.feed.tables.get('trips') as never))
    expect(input.attribution).toContain('Dispatcher で減便を反映して加工したもの')
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('方針の下書きを「やめる」と、入れた値のまま入力に戻り、履歴は変わらない', () => {
    load()
    renderSteps()
    const policy = step('2. 減便の方針')
    fireEvent.click(within(policy).getByLabelText('平日を日祝ダイヤに'))
    expect(within(policy).getByLabelText('日祝のダイヤ(写す元)')).toHaveProperty('value', 'SU')
    fireEvent.click(within(policy).getByRole('button', { name: '対象便を確かめる' }))
    fireEvent.click(within(policy).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().draft).toBeNull()
    expect(useEditStore.getState().history).toEqual([])
    expect(within(policy).getByLabelText('平日を日祝ダイヤに')).toHaveProperty('checked', true)
  })

  it('期間を 7 日以下にすると、方針の確かめで警告し、承認はできるが出力は止まる', async () => {
    load()
    renderSteps()
    const policy = step('2. 減便の方針')
    fireEvent.change(within(policy).getByLabelText('開始日'), { target: { value: '2026-11-24' } })
    expect(within(policy).getByRole('region', { name: '方針の確かめ' }).textContent).toContain('このままでは出力できません')
    fireEvent.click(within(policy).getByRole('button', { name: '対象便を確かめる' }))
    const review = within(policy).getByRole('region', { name: '対象便の確かめ' })
    fireEvent.click(within(review).getByLabelText('全曜日で便がなくなる系統があることを確かめました'))
    fireEvent.click(within(review).getByRole('button', { name: 'この内容で進める' }))
    expect(useEditStore.getState().history).toHaveLength(1)

    const exportStep = step('6. GTFS を出力')
    expect(within(exportStep).getByRole('button', { name: 'GTFS を出力する' })).toHaveProperty('disabled', true)
    expect(exportStep.textContent).toContain('誤りがあるため出力できません')
    expect(exportStep.querySelector('[data-code="shortValidity"]')).not.toBeNull()
  })
})
