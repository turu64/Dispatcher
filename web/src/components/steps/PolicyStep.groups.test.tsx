// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { multiFeed, smallFeed } from '@/gtfs/edit/form2.fixture'
import { computeServiceFeatures } from '@/gtfs/groups/features'
import { editGroups } from '@/gtfs/groups/edit'
import { featuresOf, svc } from '@/gtfs/groups/groups.fixture'
import { proposeGroups } from '@/gtfs/groups/rules'
import type { ServiceGroups } from '@/gtfs/groups/types'
import { groupedPolicyServices } from '@/gtfs/groups/view'
import { useEditStore, type BaseGtfs } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import { useServiceGroupsStore, type JevState } from '@/store/serviceGroups'
import { PolicyForm } from './policy/PolicyForm'
import PolicyStep from './PolicyStep'

// 減便の方針の手順を、ダイヤのグループ分けで選ぶ(docs/design-service-groups.md §5.2)。グループ分けを確定する操作は無く、
// 既定は案のまま一括で入れ替え、詳しい設定の「手動で選ぶ」で service ごとに直す(指摘19。docs/tasks-1105.md の U04)

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}

vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

function sentenceText(): string {
  const copy = screen.getByTestId('policy-sentence').cloneNode(true) as HTMLElement
  for (const el of copy.querySelectorAll('select[aria-hidden="true"]')) el.remove()
  return copy.textContent ?? ''
}

function jevOf(state: JevState) {
  return { state, status: null, response: null, omitted: [], asking: 0, message: null, sent: false }
}

/** GTFS とグループ分けを入れる。jev は Jev の欄の状態(既定は使えなかった。待っていない) */
function load(feed = multiFeed(), jev: JevState = 'unavailable', groups?: ServiceGroups) {
  const base: BaseGtfs = { feed, zip: new ArrayBuffer(0), label: 'multi.zip', sample: null }
  act(() => {
    useEditStore.getState().setBase(base)
    useServiceGroupsStore.setState({ status: 'ready', groups: groups ?? proposeGroups(computeServiceFeatures(feed, null)), jev: jevOf(jev) })
  })
  return base
}

/** 「対象便を確かめる」で作った下書きの減便の方針 */
function submitted() {
  fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
  const draft = useEditStore.getState().draft
  if (draft?.kind !== 'op' || draft.record.op.type !== 'applyPolicy') throw new Error('下書きのはず')
  return draft.record.op.settings
}

function manualRow(serviceId: string): HTMLElement {
  const el = screen.getByTestId('group-replace-manual').querySelector(`[data-service="${serviceId}"]`)
  if (!el) throw new Error(`${serviceId} の行が無い`)
  return el as HTMLElement
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

describe('ダイヤ単位で選ぶとき(Jev を待っていない)', () => {
  it('単純な GTFS で入れ替えに使う service を「使わない」に直したら、平日の便が期間の間すべてなくなると目立つ形で出す', () => {
    const feed = smallFeed()
    const groups = editGroups(proposeGroups(computeServiceFeatures(feed, null)), { kind: 'weekdayToSaturday', serviceId: 'SA', into: null })
    expect(groups.simple).toBe(true)
    expect(groupedPolicyServices(groups, true)?.status).toBe('confirmed')
    const base: BaseGtfs = { feed, zip: new ArrayBuffer(0), label: 'small.zip', sample: null }
    act(() => {
      useEditStore.getState().setBase(base)
      useServiceGroupsStore.setState({ status: 'ready', groups })
    })
    render(<PolicyStep />)
    const note = screen.getByTestId('groups-erase-only')
    expect(note.textContent).toContain('土曜のダイヤに入れ替える便がないため、平日のダイヤ(WK)の便は、期間の間すべてなくなります')
  })

  it('確定を押さずに、文の穴をダイヤの語にし、詳しい設定に組の内訳を出し、組の表で下書きを作る(既定は自動)', () => {
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
    // 既定は自動(グループ分けのとおりに一括で入れ替える)。読み込みの手順へ戻るボタンは無い
    expect(within(groups).getByRole('radio', { name: '自動(グループ分けのとおり。既定)' }).getAttribute('aria-checked')).toBe('true')
    expect(within(groups).queryByTestId('group-replace-manual')).toBeNull()
    expect(screen.queryByRole('button', { name: '読み込みの手順の表で直す' })).toBeNull()

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
})

describe('手動で選ぶ', () => {
  it('手動で「入れ替えない」にした平日の service は keptWeekdayServices に入り、組から外れる', () => {
    load()
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('radio', { name: '手動で選ぶ' }))
    // 平日の側の service ごとの行(主の平日の service が先頭)
    const items = within(screen.getByTestId('group-replace-manual')).getAllByRole('listitem').map((li) => li.getAttribute('data-service'))
    expect(items.slice(0, 1)).toEqual(['01001'])
    expect(items).toEqual(expect.arrayContaining(['01001_A', '01001_C', '01002_RIT', '01005_MSN', 'WB']))
    fireEvent.click(within(manualRow('WB')).getByRole('radio', { name: '入れ替えない' }))
    expect(useServiceGroupsStore.getState().groups!.byKind.weekdayToSaturday.rows.find((r) => r.serviceId === 'WB')).toMatchObject({
      treatment: 'keep',
      basisMark: 'edited',
    })
    const settings = submitted()
    expect(settings.keptWeekdayServices).toEqual(['01002_RIT', 'WB'])
    expect(settings.pairs?.map((p) => p.weekday)).not.toContain('WB')
  })

  it('手動で入れ替え先を変えた組が pairs に出る。入れ替え先が複数なら「03001 ほか 1」と出す', () => {
    load()
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('radio', { name: '手動で選ぶ' }))
    const main = within(manualRow('01001')).getByRole('combobox', { name: '01001 の入れ替え先(土曜)' }) as HTMLSelectElement
    // 自動の案で 01001 には 03001・SB1・SB2 が入る
    expect(main.selectedOptions[0].textContent).toBe('03001 ほか 2')
    const wb = within(manualRow('WB')).getByRole('combobox', { name: 'WB の入れ替え先(土曜)' }) as HTMLSelectElement
    expect(wb.value).toBe('__none__')
    fireEvent.change(wb, { target: { value: 'SB1' } })
    expect(main.selectedOptions[0].textContent).toBe('03001 ほか 1')
    const settings = submitted()
    expect(settings.pairs).toContainEqual({ weekday: 'WB', replacements: ['SB1'] })
    expect(settings.pairs?.find((p) => p.weekday === '01001')?.replacements).toEqual(['03001', 'SB2'])
  })

  it('入れ替え先を「便をなくす」にすると、外した入れ替えに使う service は下の欄に出て、案に戻せる', () => {
    load()
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('radio', { name: '手動で選ぶ' }))
    fireEvent.change(within(manualRow('01001_A')).getByRole('combobox', { name: '01001_A の入れ替え先(土曜)' }), { target: { value: '__none__' } })
    expect(manualRow('03001_A').textContent).toContain('使わない')
    expect(screen.getByTestId('policy-details').querySelector('summary')!.textContent).toContain('ダイヤ:組 2・なくす 3・残す 1')
    fireEvent.click(within(manualRow('01001_A')).getByRole('button', { name: '案に戻す' }))
    expect(screen.getByTestId('policy-details').querySelector('summary')!.textContent).toContain('ダイヤ:組 3・なくす 2・残す 1')
  })

  it('「自動」に戻すと、この種類で手動で選んだ値を捨てる', () => {
    load()
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('radio', { name: '手動で選ぶ' }))
    fireEvent.click(within(manualRow('WB')).getByRole('radio', { name: '入れ替えない' }))
    fireEvent.click(screen.getByRole('radio', { name: '自動(グループ分けのとおり。既定)' }))
    expect(useServiceGroupsStore.getState().groups!.byKind.weekdayToSaturday.rows.find((r) => r.serviceId === 'WB')!.basisMark).not.toBe('edited')
    expect(screen.getByTestId('policy-details').querySelector('summary')!.textContent).toContain('ダイヤ:組 3・なくす 2・残す 1')
  })

  it('決まらない行があれば groupErrors の文と「手動で選ぶ」を出し、押すと手動の欄を開いて焦点を移す。選べば進める', () => {
    const feed = multiFeed()
    // 決まらない形(接尾辞 X の平日だけの service が2つ)。GTFS は multiFeed のまま(文と手動の欄だけを確かめる)
    const groups = proposeGroups(
      featuresOf([
        svc('01001', { weekday: 98 }, { trips: 500 }),
        svc('11001_X', { weekday: 98 }, { trips: 30 }),
        svc('12001_X', { weekday: 98 }, { trips: 30 }),
        svc('03001', { saturday: 19 }, { trips: 400 }),
        svc('03001_X', { saturday: 19 }, { trips: 30 }),
        svc('02001', { sundayHoliday: 25 }, { trips: 380 }),
      ]),
    )
    load(feed, 'off', groups)
    render(<PolicyStep />)
    const error = screen.getByTestId('groups-error')
    expect(error.textContent).toContain('便を入れる平日の service が決まらない service があります(03001_X)')
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', true)
    fireEvent.click(within(error).getByRole('button', { name: '手動で選ぶ' }))
    expect((screen.getByTestId('policy-details') as HTMLDetailsElement).open).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('group-replace-manual'))
    // 開いたら「手動で選ぶ」のボタンは出さない
    expect(within(screen.getByTestId('groups-error')).queryByRole('button', { name: '手動で選ぶ' })).toBeNull()
    fireEvent.change(within(manualRow('03001_X')).getByRole('combobox', { name: '03001_X の便を入れる平日の service' }), {
      target: { value: '11001_X' },
    })
    expect(screen.queryByTestId('groups-error')).toBeNull()
  })

  it('形2で表せない service(日祝の MS)は、手動で「入れ替えない」にすると進める', () => {
    const base = load()
    render(
      <PolicyForm
        base={base}
        initial={{ kind: 'weekdayToSundayHoliday', weekdayService: '01001', replacementService: '', period: { start: '20261103', end: null }, excludedRoutes: [] }}
        initialReason={null}
      />,
    )
    fireEvent.click(within(screen.getByTestId('groups-error')).getByRole('button', { name: '手動で選ぶ' }))
    const ms = manualRow('MS')
    expect(within(ms).getByRole('radio', { name: '入れ替える' })).toHaveProperty('disabled', true)
    fireEvent.click(within(ms).getByRole('radio', { name: '入れ替えない' }))
    expect(screen.queryByTestId('groups-error')).toBeNull()
  })
})

describe('Jev を待っている間・単純な GTFS', () => {
  it('Jev の答えを待っている間は、待っていることを出し、今の service の選び方で選べる。待たずに進めるとダイヤ単位になる', () => {
    load(multiFeed(), 'sending')
    render(<PolicyStep />)
    const note = screen.getByTestId('groups-unconfirmed')
    expect(note.textContent).toContain('Jev の答えが届くと、ダイヤ単位で選べます')
    expect(note.textContent).not.toContain('確定')
    expect(sentenceText()).toContain('平日を土曜ダイヤに変更する。')
    expect(screen.getByLabelText('入れ替え元のダイヤ(平日)')).toBeTruthy()
    fireEvent.click(within(note).getByRole('button', { name: 'Jev を待たずに規則だけで進める' }))
    expect(useServiceGroupsStore.getState().jev.state).toBe('stopped')
    expect(screen.queryByTestId('groups-unconfirmed')).toBeNull()
    expect(screen.getByTestId('policy-groups')).toBeTruthy()
  })

  it('Jev に送るかを聞いている間は、読み込みの手順で選ぶよう出す', () => {
    load(multiFeed(), 'awaitingConsent')
    render(<PolicyStep />)
    expect(screen.getByTestId('groups-unconfirmed').textContent).toContain('手順「読み込み」で Jev に送るかを選ぶと、ダイヤ単位で選べます')
    expect(screen.queryByRole('button', { name: 'Jev を待たずに規則だけで進める' })).toBeNull()
  })

  it('単純な GTFS(1組の形で足りる。道北バスの形)では今の見た目のまま。自動・手動の欄も出さない', () => {
    load(smallFeed(), 'notNeeded')
    render(<PolicyStep />)
    expect(screen.queryByTestId('groups-unconfirmed')).toBeNull()
    expect(screen.queryByTestId('policy-groups')).toBeNull()
    expect(screen.queryByRole('radio', { name: '手動で選ぶ' })).toBeNull()
    expect(screen.getByLabelText('入れ替え元のダイヤ(平日)')).toBeTruthy()
    expect(sentenceText()).toContain('平日を土曜ダイヤに変更する。')
  })
})

describe('減便の理由の括弧の補足', () => {
  it('補足の入力欄に「変更指示書に載せます」を aria-describedby で伝える', () => {
    const base = load(smallFeed(), 'notNeeded')
    render(<PolicyForm base={base} initial={null} initialReason={{ category: 'temporaryShortage', note: '' }} />)
    const input = screen.getByRole('textbox', { name: '減便の理由の補足' })
    const hint = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toBe('括弧の補足は、変更指示書に載せます。')
  })
})
