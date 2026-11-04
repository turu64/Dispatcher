// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { multiFeed, smallFeed } from '@/gtfs/edit/form2.fixture'
import { computeServiceFeatures } from '@/gtfs/groups/features'
import { editGroups } from '@/gtfs/groups/edit'
import { proposeGroups } from '@/gtfs/groups/rules'
import { groupedPolicyServices } from '@/gtfs/groups/view'
import { useEditStore, type BaseGtfs } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import { useServiceGroupsStore } from '@/store/serviceGroups'
import { useStepStore } from '@/store/steps'
import { PolicyForm } from './policy/PolicyForm'
import PolicyStep from './PolicyStep'

// 減便の方針の手順を、読み込みの手順で確定したダイヤのグループ分けで選ぶ(docs/design-service-groups.md §5.2)

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}

vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

function sentenceText(): string {
  const copy = screen.getByTestId('policy-sentence').cloneNode(true) as HTMLElement
  for (const el of copy.querySelectorAll('select[aria-hidden="true"]')) el.remove()
  return copy.textContent ?? ''
}

function load(feed = multiFeed(), confirmed = true) {
  const base: BaseGtfs = { feed, zip: new ArrayBuffer(0), label: 'multi.zip', sample: null }
  act(() => {
    useEditStore.getState().setBase(base)
    useServiceGroupsStore.setState({ status: 'ready', groups: proposeGroups(computeServiceFeatures(feed, null)), confirmed })
  })
  return base
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T03:00:00Z') })
  useHolidayStore.setState({ holidays: { status: 'missing' } })
})

afterEach(() => {
  cleanup()
  act(() => {
    useEditStore.getState().setBase(null)
    useServiceGroupsStore.getState().reset()
  })
  vi.useRealTimers()
})

describe('確定したグループ分けがあるとき', () => {
  it('単純な GTFS で入れ替えに使う service を「使わない」に直したら、平日の便が期間の間すべてなくなると目立つ形で出す', () => {
    const feed = smallFeed()
    const groups = editGroups(proposeGroups(computeServiceFeatures(feed, null)), { kind: 'weekdayToSaturday', serviceId: 'SA', into: null })
    expect(groups.simple).toBe(true)
    expect(groupedPolicyServices(groups, true)?.status).toBe('confirmed')
    const base: BaseGtfs = { feed, zip: new ArrayBuffer(0), label: 'small.zip', sample: null }
    act(() => {
      useEditStore.getState().setBase(base)
      useServiceGroupsStore.setState({ status: 'ready', groups, confirmed: true })
    })
    render(<PolicyStep />)
    const note = screen.getByTestId('groups-erase-only')
    expect(note.textContent).toContain('土曜のダイヤに入れ替える便がないため、平日のダイヤ(WK)の便は、期間の間すべてなくなります')
  })

  it('文の穴をダイヤの語にし、詳しい設定に組の内訳を出し、組の表で下書きを作る', () => {
    load()
    render(<PolicyStep />)
    // 選択肢の数え方は、対象便の確認の文(groupSentence)と同じ:入れ替える組だけを数え、なくす service は数えない
    expect(sentenceText()).toContain('平日のダイヤ(01001 ほか 2)を土曜のダイヤ(03001 ほか 4)に変更する。')
    const details = screen.getByTestId('policy-details')
    expect(details.querySelector('summary')!.textContent).toContain('ダイヤ:組 3・なくす 2・残す 1')
    const groups = within(details).getByTestId('policy-groups')
    expect(within(groups).getByRole('list', { name: '組の内訳' }).textContent).toContain('平日 01001 ←に入れる便: 土曜 03001・SB1・SB2')
    expect(groups.textContent).toContain('平日のまま残す:01002_RIT')
    // 1つの service を選ぶ欄は出さない
    expect(screen.queryByLabelText('入れ替え元のダイヤ(平日)')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const draft = useEditStore.getState().draft
    if (draft?.kind !== 'op' || draft.record.op.type !== 'applyPolicy') throw new Error('下書きのはず')
    const settings = draft.record.op.settings
    expect(settings.weekdayService).toBe('01001')
    expect(settings.pairs?.map((p) => p.weekday)).toEqual(['01001', '01001_A', '01001_C', '01005_MSN', 'WB'])
    expect(settings.keptWeekdayServices).toEqual(['01002_RIT'])
    expect('notApplied' in settings).toBe(false)
    // 対象便の確認にも、ダイヤの語の文と組の内訳を出す
    const review = screen.getByRole('region', { name: '対象便の確認' })
    expect(review.textContent).toContain('平日のダイヤ(01001 ほか 2)を土曜のダイヤ(03001 ほか 4)の便に入れ替えます。')
    expect(within(review).getByRole('list', { name: '組の内訳' }).textContent).toContain('なくなる便')
  })

  it('その種類のグループ分けが作れない(形2で表せない service)なら、理由を出して「対象便を確かめる」を押せない', () => {
    const base = load()
    render(
      <PolicyForm
        base={base}
        initial={{ kind: 'weekdayToSundayHoliday', weekdayService: '01001', replacementService: '', period: { start: '20261103', end: null }, excludedRoutes: [] }}
        initialReason={null}
      />,
    )
    expect(screen.getByTestId('groups-error').textContent).toContain('形2で表せない service が 1 つあります(MS)')
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', true)
  })

  it('期間 11/1〜:期間に走らない 03001_C を加えないことを、詳しい設定の数・組の内訳・文の数・全曜日で便がなくなる系統に出す(承認の前)', () => {
    // 01001_C と 03001_C の便だけを持つ系統 R5 を作る(10/31 だけ走る 03001_C を加えないと、R5 は全曜日で便がなくなる)
    const feed = multiFeed()
    const routes = feed.tables.get('routes')!.rows
    routes.push({ ...routes[0], route_id: 'R5', route_short_name: '5', route_long_name: '迂回線' })
    for (const t of feed.tables.get('trips')!.rows) if ((t.trip_id ?? '').endsWith('_C')) t.route_id = 'R5'
    const base = load(feed)
    const form = (start: string) =>
      render(
        <PolicyForm
          base={base}
          initial={{ kind: 'weekdayToSaturday', weekdayService: '01001', replacementService: '03001', period: { start, end: null }, excludedRoutes: [] }}
          initialReason={null}
        />,
      )

    // 10/26〜 では 03001_C が 10/31 に走るので加える(比べるため)
    const before = form('20261026')
    expect(screen.getByTestId('policy-details').querySelector('summary')!.textContent).toContain('ダイヤ:組 3・なくす 2・残す 1、')
    expect(sentenceText()).toContain('平日のダイヤ(01001 ほか 2)を土曜のダイヤ(03001 ほか 4)に変更する。')
    expect(document.body.textContent).toContain('土曜の便がない系統が 1 系統あり')
    expect(document.body.textContent).not.toContain('期間に走らないため加えません')
    before.unmount()

    form('20261101')
    const details = screen.getByTestId('policy-details')
    // 01001_C の組は入れ替えに使う service がすべて加わらないので「なくす」に数え、加えない service の数を出す
    expect(details.querySelector('summary')!.textContent).toContain('ダイヤ:組 2・なくす 3・残す 1・期間に走らず加えない 1、')
    // 文の選択肢も、01001_C と 03001_C を数えない
    expect(sentenceText()).toContain('平日のダイヤ(01001 ほか 1)を土曜のダイヤ(03001 ほか 3)に変更する。')
    const list = within(details).getByRole('list', { name: '組の内訳' })
    expect(list.textContent).toContain('平日 01001_C ←に入れる便: 土曜 03001_C(期間に走らないため加えません)(平日 1 便)')
    expect(within(list).getByText('03001_C').className).toContain('line-through')
    // 加えない 03001_C の便は系統の便数に数えないので、R5 も全曜日で便がなくなる系統に数える
    expect(document.body.textContent).toContain('土曜の便がない系統が 2 系統あり')
  })

  it('「読み込みの手順の表で直す」で、読み込みの手順へ移り、表を開くよう頼む', () => {
    load()
    act(() => useStepStore.setState({ current: 'policy' }))
    render(<PolicyStep />)
    const before = useServiceGroupsStore.getState().tableRequest
    fireEvent.click(within(screen.getByTestId('policy-groups')).getByRole('button', { name: '読み込みの手順の表で直す' }))
    expect(useStepStore.getState().current).toBe('load')
    expect(useServiceGroupsStore.getState().tableRequest).toBe(before + 1)
  })
})

describe('確定していないとき・単純な GTFS', () => {
  it('単純でない GTFS で確定していなければ、確定を促し、今の service の選び方で選べる', () => {
    load(multiFeed(), false)
    render(<PolicyStep />)
    expect(screen.getByTestId('groups-unconfirmed').textContent).toContain('ダイヤ単位で選べます')
    expect(sentenceText()).toContain('平日を土曜ダイヤに変更する。')
    expect(screen.getByLabelText('入れ替え元のダイヤ(平日)')).toBeTruthy()
  })

  it('単純な GTFS(1組の形で足りる)では今の見た目のまま', () => {
    load(smallFeed())
    render(<PolicyStep />)
    expect(screen.queryByTestId('groups-unconfirmed')).toBeNull()
    expect(screen.queryByTestId('policy-groups')).toBeNull()
    expect(sentenceText()).toContain('平日を土曜ダイヤに変更する。')
  })
})
