// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { featuresOf, kyotoLike, svc } from '@/gtfs/groups/groups.fixture'
import { proposeGroups } from '@/gtfs/groups/rules'
import type { JevJudgeResponse, ServiceGroups } from '@/gtfs/groups/types'
import LoadStep from '@/components/steps/LoadStep'
import { useHolidayStore } from '@/store/holidays'
import { resetAll } from '@/store/reset'
import { useServiceGroupsStore } from '@/store/serviceGroups'
import { useEditStore } from '@/store/edit'
import { mergeJevAnswers } from '@/gtfs/groups/merge'
import ServiceGroupsCard from './ServiceGroupsCard'
import { attentionCount, orderRows, simpleSummary } from './serviceGroupsText'

const mocks = vi.hoisted(() => ({ fetchSampleGtfsInfo: vi.fn(), fetchJevStatus: vi.fn(), judgeServices: vi.fn() }))
vi.mock('@/gtfs/sample', () => ({ fetchSampleGtfsInfo: mocks.fetchSampleGtfsInfo, fetchSampleGtfs: vi.fn() }))
vi.mock('@/gtfs/workerClient', () => ({ loadGtfsInWorker: vi.fn(() => new Promise(() => {})) }))
// Jev に送るかのダイアログで「Jev に送る」を押したときの問い合わせ。答えを返さず、checking のまま止める
vi.mock('@/gtfs/groups/jevClient', () => ({ fetchJevStatus: mocks.fetchJevStatus, judgeServices: mocks.judgeServices }))

// Radix の Select は jsdom に無い scrollIntoView・ポインターの捕捉を使う
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}

beforeEach(() => {
  mocks.fetchSampleGtfsInfo.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.fetchJevStatus.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.judgeServices.mockReset().mockImplementation(() => new Promise(() => {}))
  useHolidayStore.setState({ holidays: { status: 'ready', list: { names: new Map(), first: '20200101', coveredUntil: '20291231', source: '' } } })
})

afterEach(() => {
  cleanup()
  act(() => resetAll('delete'))
})

/** 割り当てが決まらない形:接尾辞 X の平日だけの service が2つあり、頭で絞れない */
function undecidedGroups(): ServiceGroups {
  return proposeGroups(
    featuresOf([
      svc('01001', { weekday: 98 }, { trips: 500 }),
      svc('11001_X', { weekday: 98 }, { trips: 30 }),
      svc('12001_X', { weekday: 98 }, { trips: 30 }),
      svc('03001', { saturday: 19 }, { trips: 400 }),
      svc('03001_X', { saturday: 19 }, { trips: 30 }),
      svc('02001', { sundayHoliday: 25 }, { trips: 380 }),
    ]),
  )
}

function showGroups(groups: ServiceGroups, extra: Partial<ReturnType<typeof useServiceGroupsStore.getState>> = {}) {
  act(() =>
    useServiceGroupsStore.setState({
      status: 'ready',
      groups,
      confirmed: groups.simple,
      jev: { state: groups.simple ? 'notNeeded' : 'unavailable', status: null, response: null, omitted: [], asking: 0, message: groups.simple ? null : 'サーバーに Jev のキーが設定されていないため、規則だけで分けました。', sent: false },
      ...extra,
    }),
  )
  render(<ServiceGroupsCard />)
}

function response(): JevJudgeResponse {
  return {
    model: 'typesafe-ai/jev',
    results: [
      {
        serviceId: '03001_A',
        role: 'saturday',
        provider: 'typesafe-ai',
        sent: { state: { target: { service_id: '03001_A' } }, questions: { weekday_counterpart: {} } },
        weekdayCounterpart: { choice: '01001_A', probabilities: { '01001_A': 0.95 }, confidence: 0.95 },
      },
    ],
    failures: [
      { serviceId: '01001', role: 'weekday', error: 'timeout', sent: { state: { target: { service_id: '01001' } }, questions: { service_kind: {} } } },
      { serviceId: '01002_RIT', role: 'weekday', error: 'budget' },
    ],
    usage: { inputTokens: 100, costUsd: 0.0004 },
  }
}

describe('文と並び', () => {
  it('単純な GTFS の要約:平日・土曜・日祝、土日祝、なくす、同じダイヤ', () => {
    const g = (list: ReturnType<typeof svc>[]) => proposeGroups(featuresOf(list))
    expect(simpleSummary(g([svc('01', { weekday: 98 }), svc('03', { saturday: 19 }), svc('06', { sundayHoliday: 25 })]))).toBe(
      '平日 01・土曜 03・日祝 06 に分かれています(走る日から判定しました)。',
    )
    expect(simpleSummary(g([svc('S000004', { weekday: 98 }), svc('S000006', { saturday: 19, sundayHoliday: 25 })]))).toBe(
      '平日 S000004・土日祝 S000006 に分かれています(走る日から判定しました)。',
    )
    expect(simpleSummary(g([svc('S000002', { weekday: 98 }), svc('S000009', { weekday: 98, saturday: 19, sundayHoliday: 25 })]))).toBe(
      '平日だけの S000002 は、期間の間なくします。土曜・日祝だけに走る service はありません。',
    )
    expect(simpleSummary(g([svc('S1', { weekday: 98, saturday: 19, sundayHoliday: 25 })]))).toBe('平日と土曜・日祝で同じダイヤのため、入れ替える便がありません。')
  })

  it('並び:入れ替える組(平日の service の下に入れ替えに使う service)→ なくす → 残す。手を付けないものは別', () => {
    const g = proposeGroups(kyotoLike())
    const { sections, others } = orderRows(g.byKind.weekdayToSaturday)
    expect(sections.map((s) => s.key)).toEqual(['pairs', 'erase', 'keep'])
    const pairs = sections[0].rows.map((r) => `${r.nested ? '  ' : ''}${r.row.serviceId}`)
    expect(pairs[0]).toBe('01001')
    expect(pairs).toContain('  03001')
    expect(pairs.indexOf('  03001_A')).toBe(pairs.indexOf('01001_A') + 1)
    expect(sections[1].rows.map((r) => r.row.serviceId)).toEqual(['01005_MSN'])
    expect(sections[2].rows.map((r) => r.row.serviceId)).toEqual(['01002_RIT'])
    expect(others.map((r) => r.serviceId)).toContain('SRV_8_10600_01_A')
  })
})

describe('Jev に送るかのダイアログ', () => {
  const AWAITING = { state: 'awaitingConsent', status: null, response: null, omitted: ['SRV_8_10600_01_A'], asking: 7, message: null, sent: false } as const

  it('手順「読み込み」に Jev のスイッチは無い', () => {
    render(<LoadStep />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText(/Jev に送って、ダイヤの分け方を確かめる/)).toBeNull()
  })

  it('答えを待っている間に開き、数・送り先・送る情報・経路・上限で問わない数を書く。「今後は聞かない」は無い', () => {
    showGroups(proposeGroups(kyotoLike()), { jev: { ...AWAITING, omitted: [...AWAITING.omitted] } })
    const dialog = screen.getByRole('alertdialog', { name: 'ダイヤの分け方を Jev に問い合わせますか' })
    const text = dialog.textContent ?? ''
    expect(text).toContain('分け方を決めきれない service が 7 個あります')
    expect(text).toContain('TypeSafe AI Jev(Vercel AI Gateway 経由)に送って')
    expect(text).toContain('系統名と系統ごとの便数・行き先')
    expect(text).toContain('TypeSafe AI に限って送ります')
    expect(text).toContain('上限のため、1 個の service は問い合わせません')
    expect(text).not.toContain('今後は聞かない')
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Jev に送る' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '送らずに規則だけで進める' })).toBeTruthy()
    // 待っている間は確定できない
    expect((screen.getByRole('button', { name: 'このグループ分けで進める', hidden: true }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('上限で問わない service が無ければ、その文を出さない', () => {
    showGroups(proposeGroups(kyotoLike()), { jev: { ...AWAITING, omitted: [] } })
    expect(screen.getByRole('alertdialog').textContent).not.toContain('上限のため')
  })

  it('「送らずに規則だけで進める」で閉じ、送らずに off。知らせと「Jev に問い合わせる」を出し、焦点を知らせに移す', async () => {
    showGroups(proposeGroups(kyotoLike()), { jev: { ...AWAITING, omitted: [...AWAITING.omitted] } })
    fireEvent.click(screen.getByRole('button', { name: '送らずに規則だけで進める' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(useServiceGroupsStore.getState().jev.state).toBe('off')
    expect(mocks.fetchJevStatus).not.toHaveBeenCalled()
    expect(mocks.judgeServices).not.toHaveBeenCalled()
    const panel = screen.getByRole('region', { name: 'Jev による確かめ' })
    const statusEl = within(panel).getByRole('status')
    expect(statusEl.textContent).toContain('Jev に送らず、規則だけで分けました。')
    await waitFor(() => expect(document.activeElement).toBe(statusEl))
    // 断ったあとも、ボタンで送れる
    const ask = within(panel).getByRole('button', { name: 'Jev に問い合わせる' })
    expect(ask.getAttribute('aria-describedby')).toBe('jev-ask-note')
    expect(document.getElementById('jev-ask-note')!.textContent).toContain('TypeSafe AI Jev(Vercel AI Gateway 経由)に送ります')
    fireEvent.click(ask)
    expect(useServiceGroupsStore.getState().jev.state).toBe('checking')
    expect(mocks.fetchJevStatus).toHaveBeenCalledTimes(1)
  })

  it('Escape でも送らない側に倒す', () => {
    showGroups(proposeGroups(kyotoLike()), { jev: { ...AWAITING, omitted: [] } })
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(useServiceGroupsStore.getState().jev.state).toBe('off')
    expect(mocks.fetchJevStatus).not.toHaveBeenCalled()
  })

  it('「Jev に送る」で閉じ、使えるかの確かめに進む(閉じても off にしない)', () => {
    showGroups(proposeGroups(kyotoLike()), { jev: { ...AWAITING, omitted: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Jev に送る' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(useServiceGroupsStore.getState().jev.state).toBe('checking')
    expect(mocks.fetchJevStatus).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Jev への問い合わせをやめる' })).toBeTruthy()
  })

  it('単純な GTFS(道北バスなど)では出さない', () => {
    showGroups(proposeGroups(featuresOf([svc('01', { weekday: 98 }), svc('03', { saturday: 19 }), svc('06', { sundayHoliday: 25 })])))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('単純でない GTFS の表', () => {
  it('要約・Jev を使えない理由・方針の種類のタブ・表を出し、確定できる', () => {
    showGroups(proposeGroups(kyotoLike()))
    expect(screen.getByTestId('service-groups-summary').textContent).toContain('service_id が 11 個あります。')
    expect(screen.getByRole('region', { name: 'Jev による確かめ' }).textContent).toContain('キーが設定されていない')
    expect(screen.getByRole('tab', { name: /平日を土曜ダイヤに/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /平日を日祝ダイヤに/ })).toBeTruthy()
    const table = screen.getByRole('table', { name: 'ダイヤのグループ分け(平日を土曜ダイヤに)' })
    expect(table.querySelector('[data-service="01001"]')!.textContent).toContain('平日 98%・土曜 0%・日祝 0%')
    expect(table.querySelector('[data-service="01001"]')!.textContent).toContain('500 便・4 系統')

    fireEvent.click(screen.getByRole('button', { name: 'このグループ分けで進める' }))
    expect(useServiceGroupsStore.getState().confirmed).toBe(true)
    expect(screen.getByText('グループ分けを確定しました。直すときは表を開きます。')).toBeTruthy()
    // 確定したら表を閉じる。押したボタンは消えるので、焦点は「表を開く」に移す
    expect(screen.queryByRole('table', { name: /平日を土曜ダイヤに/ })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '表を開く' }))
    fireEvent.click(screen.getByRole('button', { name: '表を開く' }))
    expect(screen.getByRole('table', { name: /平日を土曜ダイヤに/ })).toBeTruthy()
  })

  it('決まらない行が残っている間は確定できず、選べば確定できる', () => {
    const groups = undecidedGroups()
    expect(attentionCount(groups)).toBe(1)
    showGroups(groups)
    expect(screen.getByTestId('service-groups-summary').textContent).toContain('確かめが要るものが 1 件あります。')
    const confirm = screen.getByRole('button', { name: 'このグループ分けで進める' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText(/「選んでください」の行が残っている/)).toBeTruthy()
    // タブに確かめが要る数を出す
    expect(within(screen.getByRole('tab', { name: /平日を土曜ダイヤに/ })).getByLabelText('確かめが要るもの 1 件')).toBeTruthy()

    const table = screen.getByRole('table', { name: 'ダイヤのグループ分け(平日を土曜ダイヤに)' })
    expect(table.querySelector('[data-service="03001_X"] [data-mark="undecided"]')).toBeTruthy()
    const trigger = within(table).getByRole('combobox', { name: '03001_X の便を入れる平日の service' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: '11001_X' }))

    const row = useServiceGroupsStore.getState().groups!.byKind.weekdayToSaturday.rows.find((r) => r.serviceId === '03001_X')!
    expect(row).toMatchObject({ into: '11001_X', intoMark: 'edited' })
    expect(table.querySelector('[data-service="03001_X"] [data-mark="edited"]')).toBeTruthy()
    // 日祝の側に 03001_X は関係しないので、これで確定できる
    expect((screen.getByRole('button', { name: 'このグループ分けで進める' }) as HTMLButtonElement).disabled).toBe(false)

    // 判断材料を開き、案に戻す。焦点は判断材料のボタンに移す
    fireEvent.click(within(table).getByRole('button', { name: '03001_X の判断材料' }))
    fireEvent.click(screen.getByRole('button', { name: '案に戻す' }))
    expect(useServiceGroupsStore.getState().groups!.byKind.weekdayToSaturday.rows.find((r) => r.serviceId === '03001_X')!.intoMark).toBe('undecided')
    expect(document.activeElement).toBe(within(table).getByRole('button', { name: '03001_X の判断材料' }))
  })

  it('確定したあとに案に戻して決まらない行が戻ると、確定が外れ、進めるボタンが戻る', () => {
    const groups = undecidedGroups()
    showGroups(groups)
    const table = screen.getByRole('table', { name: 'ダイヤのグループ分け(平日を土曜ダイヤに)' })
    fireEvent.keyDown(within(table).getByRole('combobox', { name: '03001_X の便を入れる平日の service' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: '11001_X' }))
    fireEvent.click(screen.getByRole('button', { name: 'このグループ分けで進める' }))
    expect(useServiceGroupsStore.getState().confirmed).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '表を開く' }))
    const reopened = screen.getByRole('table', { name: 'ダイヤのグループ分け(平日を土曜ダイヤに)' })
    fireEvent.click(within(reopened).getByRole('button', { name: '03001_X の判断材料' }))
    fireEvent.click(screen.getByRole('button', { name: '案に戻す' }))
    expect(useServiceGroupsStore.getState().confirmed).toBe(false)
    expect(screen.queryByText('グループ分けを確定しました。直すときは表を開きます。')).toBeNull()
    expect((screen.getByRole('button', { name: 'このグループ分けで進める' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('食い違いの行に Jev の値を出し、「Jev の値を使う」で直せる。確定のボタンの下に、規則の値で進む数を出す', () => {
    const res = response()
    res.results[0].weekdayCounterpart = { choice: '01005_MSN', probabilities: { '01005_MSN': 0.95 }, confidence: 0.95 }
    showGroups(mergeJevAnswers(proposeGroups(kyotoLike()), res), {
      jev: { state: 'done', status: null, response: res, omitted: [], asking: 0, message: null, sent: true },
    })
    expect(screen.getByText('規則と Jev が食い違っている 1 件は、規則の値で進めます。')).toBeTruthy()
    const table = screen.getByRole('table', { name: 'ダイヤのグループ分け(平日を土曜ダイヤに)' })
    const row = table.querySelector('[data-service="03001_A"]') as HTMLElement
    expect(row.textContent).toContain('Jev:01005_MSN')
    fireEvent.click(within(row).getByRole('button', { name: 'Jev の値を使う' }))
    const after = useServiceGroupsStore.getState().groups!.byKind.weekdayToSaturday.rows.find((r) => r.serviceId === '03001_A')!
    expect(after).toMatchObject({ into: '01005_MSN', intoMark: 'edited' })
    // 押したボタンは消えるので、焦点はその行の Select に移す
    expect(document.activeElement).toBe(within(table).getByRole('combobox', { name: '03001_A の便を入れる平日の service' }))
  })

  it('食い違いを規則の値のまま受け入れると、焦点を「案に戻す」に移す', () => {
    const res = response()
    res.results[0].weekdayCounterpart = { choice: '01005_MSN', probabilities: { '01005_MSN': 0.95 }, confidence: 0.95 }
    showGroups(mergeJevAnswers(proposeGroups(kyotoLike()), res), {
      jev: { state: 'done', status: null, response: res, omitted: [], asking: 0, message: null, sent: true },
    })
    const table = screen.getByRole('table', { name: 'ダイヤのグループ分け(平日を土曜ダイヤに)' })
    fireEvent.click(within(table).getByRole('button', { name: '03001_A の判断材料' }))
    fireEvent.click(screen.getByRole('button', { name: '規則の値のまま進める' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '案に戻す' }))
    // 判断材料には、規則の値のまま進めたことと Jev の答えを残す
    expect(table.textContent).toContain('利用者が、規則の値(01001_A)のまま進めることにしました。')
    expect(table.textContent).toMatch(/Jev は 01005_MSN を選びました/)
  })

  it('承認待ちの減便の方針の下書きがあれば、直しても下書きには反映されないと出す', () => {
    act(() =>
      useEditStore.setState({
        draft: { kind: 'op', id: '3', record: { op: { type: 'applyPolicy' } } } as unknown as ReturnType<typeof useEditStore.getState>['draft'],
      }),
    )
    showGroups(proposeGroups(kyotoLike()))
    expect(screen.getByText('グループ分けを直しても、承認待ちの下書き #3 には反映されません。減便の方針の手順で、下書きを作り直してください。')).toBeTruthy()
    act(() => useEditStore.setState({ draft: null }))
  })

  it('平日だけの service の扱いを「残す」に直せる', () => {
    showGroups(proposeGroups(kyotoLike()))
    const table = screen.getByRole('table', { name: 'ダイヤのグループ分け(平日を土曜ダイヤに)' })
    fireEvent.keyDown(within(table).getByRole('combobox', { name: '01005_MSN の扱い' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: '残す' }))
    const row = useServiceGroupsStore.getState().groups!.byKind.weekdayToSaturday.rows.find((r) => r.serviceId === '01005_MSN')!
    expect(row).toMatchObject({ treatment: 'keep', basisMark: 'edited' })
  })
})

describe('Jev の欄', () => {
  it('送っている間は「やめる」を出し、確定できない。押すと中断する', () => {
    showGroups(proposeGroups(kyotoLike()), { jev: { state: 'sending', status: null, response: null, omitted: [], asking: 0, message: null, sent: true } })
    expect((screen.getByRole('button', { name: 'このグループ分けで進める' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Jev の答えを待っています。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Jev への問い合わせをやめる' }))
    expect(useServiceGroupsStore.getState().jev.state).toBe('stopped')
    expect(screen.getByRole('region', { name: 'Jev による確かめ' }).textContent).toContain('問い合わせをやめました')
    // 知らせは読み上げの status に入れ、押したボタンが消えるので焦点もそこに移す
    const statusEl = within(screen.getByRole('region', { name: 'Jev による確かめ' })).getByRole('status')
    expect(statusEl.textContent).toContain('問い合わせをやめました')
    expect(document.activeElement).toBe(statusEl)
    // 中断したあとは、もう一度頼むボタンを出す
    expect(screen.getByRole('button', { name: 'Jev に問い合わせる' })).toBeTruthy()
  })

  it('答えを得たら送ったことの文・捨てるボタン・送った情報(results と failures の sent)を出す', () => {
    const res = response()
    showGroups(proposeGroups(kyotoLike()), {
      jev: { state: 'partial', status: null, response: res, omitted: ['SRV_8_10600_01_A'], asking: 0, message: '2 件は答えを得られませんでした(時間切れ・1日の上限)。その service は規則で分けています。', sent: true },
    })
    const panel = screen.getByRole('region', { name: 'Jev による確かめ' })
    expect(panel.textContent).toContain('TypeSafe AI Jev(Vercel AI Gateway 経由)に送り、分け方を確かめました')
    expect(panel.textContent).toContain('2 件は答えを得られませんでした')
    expect(panel.textContent).toContain('上限のため、1 個の service は Jev に問い合わせていません')

    fireEvent.click(within(panel).getByRole('button', { name: '送った情報を見る(2 件)' }))
    const list = within(panel).getByRole('list', { name: 'Jev に送った情報' })
    const items = within(list).getAllByRole('button').map((b) => b.textContent)
    // service_id の順に並べる
    expect(items).toEqual(['01001(平日。答えなし)', '03001_A(土曜)'])
    // 開いたものだけ中身を描く
    expect(list.querySelector('pre')).toBeNull()
    fireEvent.click(within(list).getByRole('button', { name: '01001(平日。答えなし)' }))
    expect(list.querySelector('pre')!.textContent).toContain('"service_kind"')

    act(() => useServiceGroupsStore.setState({ groups: proposeGroups(kyotoLike()) }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Jev の判断を使わない' }))
    expect(useServiceGroupsStore.getState().jev.state).toBe('dropped')
    expect(document.activeElement?.getAttribute('role')).toBe('status')
    // 捨てたあとも、送った情報は見られる
    expect(within(screen.getByRole('region', { name: 'Jev による確かめ' })).getByRole('button', { name: /送った情報を見る/ })).toBeTruthy()
  })

  it('TypeSafe AI 以外が答えたら、その名前を出す', () => {
    const res = response()
    res.results[0].provider = 'digitalocean'
    showGroups(proposeGroups(kyotoLike()), { jev: { state: 'done', status: null, response: res, omitted: [], asking: 0, message: null, sent: true } })
    expect(screen.getByRole('region', { name: 'Jev による確かめ' }).textContent).toContain('03001_A は、DigitalOcean が答えました(TypeSafe AI ではありません)。')
  })

  it('失敗した(回数の上限)あとは、サーバーの文を出し、もう一度問い合わせられる', () => {
    showGroups(proposeGroups(kyotoLike()), {
      jev: {
        state: 'failed',
        status: null,
        response: null,
        omitted: [],
        asking: 0,
        message: 'Jev に問う回数の上限に達しました(1 時間あたり)。規則だけで分けます。しばらくしてから使えます。Jev には送っていません。',
        sent: true,
      },
    })
    const panel = screen.getByRole('region', { name: 'Jev による確かめ' })
    expect(within(panel).getByRole('status').textContent).toContain('しばらくしてから使えます。Jev には送っていません。')
    expect(within(panel).getByRole('button', { name: 'Jev に問い合わせる' })).toBeTruthy()
  })
})

describe('祝日一覧と、削除', () => {
  it('祝日一覧を読めなければ、その旨を出す', () => {
    const f = featuresOf([svc('01', { weekday: 98 }), svc('03', { saturday: 19 }), svc('06', { sundayHoliday: 25 })])
    showGroups(proposeGroups({ ...f, holidays: 'missing' }))
    expect(screen.getByText('祝日一覧を読めないため、祝日を平日として数えています。')).toBeTruthy()
  })

  it('有効期間の一部が祝日一覧の外なら、その期間を出す', () => {
    useHolidayStore.setState({ holidays: { status: 'ready', list: { names: new Map(), first: '20200101', coveredUntil: '20261231', source: '' } } })
    showGroups(proposeGroups(featuresOf([svc('01', { weekday: 98 }), svc('03', { saturday: 19 }), svc('06', { sundayHoliday: 25 })])))
    expect(screen.getByText(/2027年1月1日\(金\)〜2027年2月28日\(日\)は祝日一覧にないため/)).toBeTruthy()
  })

  it('祝日一覧を待っている間は、その旨だけを出す。削除で消える', () => {
    act(() => useServiceGroupsStore.setState({ status: 'waitingHolidays' }))
    render(<ServiceGroupsCard />)
    expect(screen.getByText('祝日一覧を読み込んでから、ダイヤのグループ分けを計算します。')).toBeTruthy()
    act(() => resetAll('delete'))
    expect(screen.queryByRole('region', { name: 'ダイヤのグループ分け' })).toBeNull()
  })
})

describe('減便の方針の手順から表を開く(tableRequest)', () => {
  it('確定して閉じた表を、showTable で開く', () => {
    showGroups(proposeGroups(kyotoLike()), { confirmed: true })
    expect(screen.queryByRole('tablist')).toBeNull()
    act(() => useServiceGroupsStore.getState().showTable())
    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(document.getElementById('service-groups')).toBeTruthy()
  })
})
