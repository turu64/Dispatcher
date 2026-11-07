// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StepPanels from '@/components/layout/StepPanels'
import { TooltipProvider } from '@/components/ui/tooltip'
import { applyForm2 } from '@/gtfs/edit/form2'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import { planOf } from '@/gtfs/edit/ops'
import { serializeTable } from '@/gtfs/write'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useHolidayStore } from '@/store/holidays'
import { selectablePeriod, useReachStore } from '@/store/reach'
import { useStepStore, type StepKey } from '@/store/steps'

/**
 * 画面の流れ(方針の適用 → 対象便の確かめ → 承認 → 前後の比較 → 足し戻し → 元に戻す → 出力)を、
 * 手で作った小さなフィード(gtfs/edit/form2.fixture.ts)で通す。
 * 手順は画面と同じ左の欄(layout/StepPanels)で描き、開いている手順だけが見えるので、確かめる前に openStep で開く。
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
// 読み込みの手順は、サンプルの有無をサーバーに聞く。ここではサーバーに届かないものとする
vi.mock('@/gtfs/sample', () => ({
  fetchSampleGtfsInfo: () => new Promise(() => {}),
  fetchSampleGtfs: () => new Promise(() => {}),
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
      <StepPanels />
    </TooltipProvider>,
  )
}

/** 見えている手順の見出し(「3. 減便の方針」など)のカード */
function step(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title })
  return heading.closest('[data-slot="card"]') as HTMLElement
}

/** 手順を開き(上のステッパーの見出しを押したのと同じ)、その手順の見出しのカードを返す */
function openStep(key: StepKey, title: string): HTMLElement {
  act(() => {
    useStepStore.getState().go(key)
  })
  return step(title)
}

const POLICY = '3. 減便の方針'
const REACH = '4. 影響(到達圏)'
const RESTORE = '5. 平日便を戻す'
/** 出力の手順の中の GTFS のタブ(タブの中の見出しには番号を付けない) */
const EXPORT = 'GTFS を出力'

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

// Radix の Select は jsdom に無い scrollIntoView・ポインターの捕捉を使う
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}

/** shadcn/ui(Radix)の Select をキーボードで開いて、選択肢を選ぶ */
function chooseOption(scope: HTMLElement, selectName: string, optionName: string) {
  const trigger = within(scope).getByRole('combobox', { name: selectName })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(screen.getByRole('option', { name: optionName }))
}

describe('編集の画面の流れ', () => {
  // 手順を通しで描くので、全件を並列で走らせると既定の 5 秒を超えることがある(単独なら 2 秒ほど)
  it('方針の適用 → 確かめ → 承認 → 比較 → 足し戻し → 元に戻す → 出力を、小さなフィードで通す', async () => {
    const base = load()
    renderSteps()

    // ---- 方針:service は曜日の列から推定し、既定の期間は今日から当面の間 ----
    const policy = openStep('policy', POLICY)
    expect(within(policy).getByLabelText('入れ替え元のダイヤ(平日)')).toHaveProperty('value', 'WK')
    expect(within(policy).getByLabelText('入れ替えに使うダイヤ(土曜)')).toHaveProperty('value', 'SA')
    // 方針は1つの文の穴を埋める形。期間は文の日付の穴に出る(カレンダーは穴から Popover で開く)
    expect(within(policy).getByRole('button', { name: '開始日:10月20日(火)' })).toBeTruthy()
    expect(within(policy).getByRole('combobox', { name: '減便の期間の終わり' }).textContent).toBe('当面の間')
    expect(within(policy).getByTestId('holidays-in-period').textContent).toContain('勤労感謝の日')
    fireEvent.click(within(policy).getByRole('button', { name: '対象便を確かめる' }))

    // ---- 対象便を確かめる(下書き)。全曜日で便がなくなる系統(R3)があるので、確かめのチェックまで進めない ----
    const review = within(policy).getByRole('region', { name: '対象便の確認' })
    expect(within(review).getByRole('heading', { name: (n) => n.startsWith('対象便を確かめる(下書き #') })).toBeTruthy()
    const counts = within(review).getByLabelText('平日便の件数').textContent ?? ''
    expect(counts).toContain('なくなる便 3 便・加わる便 3 便・同じ便 1 便')
    expect(counts).toContain('全曜日で便がなくなる系統:1 系統')
    expect(review.textContent).toContain('出力する GTFS の有効期間は 2026年10月20日〜2026年11月30日(42日)です。')
    // 祝日(11/23)に減便後の平日ダイヤが走る警告と、実施日までの日数の注意
    expect(review.querySelector('[data-code="holidayWithoutException"]')).not.toBeNull()
    expect(review.querySelector('[data-code="leadTimeUnder3"]')).not.toBeNull()
    // 下書きの間は、到達圏の表に「下書き」と出す
    await waitFor(() => expect(within(openStep('reach', REACH)).getByText('下書き')).toBeTruthy())
    expect(useEditStore.getState().history).toHaveLength(0)
    // 方針の手順に戻っても、下書きの確かめはそのまま残る(手順は消さずに隠しているため)
    openStep('policy', POLICY)

    const proceed = within(review).getByRole('button', { name: '承認する' })
    expect(proceed).toHaveProperty('disabled', true)
    fireEvent.click(within(review).getByLabelText('全曜日で便がなくなる系統があることを確かめました'))
    expect(proceed).toHaveProperty('disabled', false)
    fireEvent.click(proceed)

    // ---- 承認したあと:適用した方針と件数 ----
    expect(useEditStore.getState().history).toHaveLength(1)
    const summary = within(policy).getByRole('region', { name: '承認した減便の方針' })
    expect(summary.textContent).toContain('平日を土曜ダイヤに')
    expect(summary.textContent).toContain('2026年10月20日(火)〜当面の間')

    // ---- 前後の比較:同じ日付の基準と編集後。S9(学校前)は出力のどの日にも便が来ない ----
    const reach = openStep('reach', REACH)
    await waitFor(() => expect(within(reach).getByRole('heading', { name: '減便の前後' })).toBeTruthy())
    expect(within(reach).queryByText('下書き')).toBeNull()
    const zero = within(reach).getByRole('region', { name: '到達できなくなる区画・発車がなくなる停留所・便がなくなる系統' })
    expect(zero.textContent).toContain('学校前')
    expect(zero.textContent).toContain('便がなくなる系統1うち全日 1')
    // 日付は出力の有効期間の中だけ。選べる範囲は減便後の GTFS の運行期間(期間の開始日から)で、比較する日付もその中にある。
    // 範囲の文は地図の操作盤の Popover に出る(map/BandControl.test.tsx が確かめる)。手順の側には今の設定の1行が出る
    const selectable = selectablePeriod(useReachStore.getState())
    expect(selectable?.start).toBe('20261020')
    const picked = useReachStore.getState().date
    expect(picked).not.toBeNull()
    expect(picked! >= selectable!.start && picked! <= selectable!.end).toBe(true)
    expect(within(openStep('reach', REACH)).getByTestId('reach-setting').textContent).toContain('比較する日付')

    // ---- 足し戻し:候補は手がかりの多い順(平日だけの系統 R3 が先頭)----
    const restore = openStep('restore', RESTORE)
    // 候補は系統ごとにたたんで出る。先頭の系統(全便が消える R3)を開いて、先頭の便を選ぶ
    const candidates = within(restore).getByRole('group', { name: '平日に戻す便の候補' })
    const r3 = within(candidates).getAllByRole('region')[0]
    fireEvent.click(within(r3).getByRole('button', { expanded: false }))
    const first = within(r3).getAllByRole('listitem')[0]
    expect(first.textContent).toContain('R3_0730_WK')
    expect(first.textContent).toContain('平日だけの系統')
    fireEvent.click(within(first).getByRole('checkbox'))
    // 休校日運休(学)の印は、足し戻した便の一覧に出る(GTFS には入れない)
    fireEvent.click(within(restore).getByLabelText('R3_0730_WK を休校日運休(学)にする'))
    fireEvent.change(within(restore).getByLabelText(/平日に戻す理由/), { target: { value: '高校の通学' } })
    fireEvent.click(within(restore).getByRole('button', { name: '選んだ 1 便を平日に戻す' }))

    expect(useEditStore.getState().history).toHaveLength(2)
    const added = within(restore).getByRole('region', { name: '平日に戻した便' })
    expect(added.textContent).toContain('平日に戻した便(1 便)')
    expect(added.textContent).toContain('理由:高校の通学')
    expect(added.textContent).toContain('休校日運休(学)')
    expect(added.textContent).toContain('平日に戻した便 1 便、営業運行時間の合計 0時間20分')
    // 足し戻すと、S9 は運行がゼロの停留所でなくなる
    await waitFor(() => expect(within(openStep('reach', REACH)).getByRole('region', { name: '到達できなくなる区画・発車がなくなる停留所・便がなくなる系統' }).textContent).toContain('発車がなくなる停留所0便がなくなる系統0'))

    // ---- 元に戻す:足し戻しの前(方針だけ)に戻る ----
    openStep('policy', POLICY)
    const history = within(policy).getByRole('region', { name: '編集の履歴' })
    expect(within(history).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(within(history).getByRole('button', { name: '元に戻す' }))
    expect(useEditStore.getState().history).toHaveLength(1)
    openStep('restore', RESTORE)
    expect(within(restore).queryByRole('region', { name: '平日に戻した便' })).toBeNull()

    // ---- 出力:承認済みの計画で作り直して ZIP に書く ----
    const exportStep = openStep('output', EXPORT)
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
  }, 30_000)

  it('方針の下書きを「やめる」と、入れた値のまま入力に戻り、履歴は変わらない', () => {
    load()
    renderSteps()
    const policy = openStep('policy', POLICY)
    chooseOption(policy, '変更後のダイヤ', '日祝')
    expect(within(policy).getByLabelText('入れ替えに使うダイヤ(日祝)')).toHaveProperty('value', 'SU')
    fireEvent.click(within(policy).getByRole('button', { name: '対象便を確かめる' }))
    fireEvent.click(within(policy).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().draft).toBeNull()
    expect(useEditStore.getState().history).toEqual([])
    expect(within(policy).getByRole('combobox', { name: '変更後のダイヤ' }).textContent).toBe('日祝')
  })

  it('期間を 7 日以下にすると、方針の確かめで警告し、承認はできるが出力は止まる', async () => {
    load()
    renderSteps()
    const policy = openStep('policy', POLICY)
    // 文の開始日の穴から開始日のカレンダー(10月・11月を並べる。Popover なので手順の外に出る)を開き、当面の間のまま11月24日を押す。
    // 日を押すと Popover は閉じる
    fireEvent.click(within(policy).getByRole('button', { name: '開始日:10月20日(火)' }))
    const calendar = screen.getByRole('dialog', { name: '減便の開始日を選ぶ' })
    const day24 = calendar.querySelector<HTMLButtonElement>('td[data-day="2026-11-24"] button')
    if (!day24) throw new Error('11月24日のボタンがありません')
    fireEvent.click(day24)
    expect(screen.queryByRole('dialog', { name: '減便の開始日を選ぶ' })).toBeNull()
    expect(within(policy).getByRole('button', { name: '開始日:11月24日(火)' })).toBeTruthy()
    expect(within(policy).getByRole('combobox', { name: '減便の期間の終わり' }).textContent).toBe('当面の間')
    expect(within(policy).getByRole('region', { name: '減便内容の確認' }).textContent).toContain('このままでは出力できません')
    fireEvent.click(within(policy).getByRole('button', { name: '対象便を確かめる' }))
    const review = within(policy).getByRole('region', { name: '対象便の確認' })
    fireEvent.click(within(review).getByLabelText('全曜日で便がなくなる系統があることを確かめました'))
    fireEvent.click(within(review).getByRole('button', { name: '承認する' }))
    expect(useEditStore.getState().history).toHaveLength(1)

    const exportStep = openStep('output', EXPORT)
    expect(within(exportStep).getByRole('button', { name: 'GTFS を出力する' })).toHaveProperty('disabled', true)
    expect(exportStep.textContent).toContain('誤りがあるため出力できません')
    expect(exportStep.querySelector('[data-code="shortValidity"]')).not.toBeNull()
  })
})
