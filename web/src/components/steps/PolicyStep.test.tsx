// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed, withRows } from '@/gtfs/edit/form2.fixture'
import type { RouteDiff, WeekdayDiff } from '@/gtfs/edit/diff'
import type { EditOp } from '@/gtfs/edit/ops'
import { chatToolDeps } from '@/store/chat'
import { useEditStore } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import { PolicyForm } from './policy/PolicyForm'
import PolicyStep, { Notice47Table } from './PolicyStep'

// 到達圏の store への受け渡し(setEdited)は、この画面では計算しない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

function policy(): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan()
  return { type: 'applyPolicy', settings, reason: { category: 'temporaryShortage', note: '欠員 2 名' } }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T03:00:00Z') })
  useHolidayStore.setState({ holidays: { status: 'missing' } })
  act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null }))
})

afterEach(() => {
  cleanup()
  act(() => useEditStore.getState().setBase(null))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Radix の Select は jsdom に無い scrollIntoView・ポインターの捕捉を使う
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}

/** 減便の文(穴埋めの形)の部品の並び */
function sentence(): HTMLElement {
  return screen.getByTestId('policy-sentence')
}

/**
 * 減便の文の読める文字。Radix の Select はフォームの中では隠れた標準の select(選択肢の文字を持つ)を横に置くので、それを除く
 */
function sentenceText(): string {
  const copy = sentence().cloneNode(true) as HTMLElement
  for (const el of copy.querySelectorAll('select[aria-hidden="true"]')) el.remove()
  return copy.textContent ?? ''
}

/** 減便の文の日付の穴(開始日・終了日)のボタン */
function hole(target: '開始日' | '終了日'): HTMLElement {
  return within(sentence()).getByRole('button', { name: new RegExp(`^${target}`) })
}

/**
 * 減便の期間のカレンダー(1つ。2か月を並べる)。文の日付の穴から Popover で開く。開いていなければ、target の穴を押して開く
 */
function periodCalendar(target: '開始日' | '終了日' = '開始日'): HTMLElement {
  const open = screen.queryByRole('group', { name: '減便の期間' })
  if (open) return open
  fireEvent.click(hole(target))
  return screen.getByRole('group', { name: '減便の期間' })
}

/** 「当面の間」のチェック(カレンダーの Popover の中。開いていなければ開く) */
function indefiniteBox(): HTMLElement {
  return within(periodCalendar()).getByLabelText('当面の間(終わりを決めない)')
}

/** 減便の期間のカレンダーで 'YYYYMMDD' の日のボタン。見えていなければ null */
function dayIn(group: HTMLElement, date: string): HTMLButtonElement | null {
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  return group.querySelector<HTMLButtonElement>(`td[data-day="${iso}"] button`)
}

/** 減便の期間のカレンダーで 'YYYYMMDD' の日を押す。見えていなければ次の月へめくる */
function pickDate(date: string) {
  const group = periodCalendar()
  for (let i = 0; i < 24; i++) {
    const button = dayIn(group, date)
    if (button) {
      fireEvent.click(button)
      return
    }
    const next = within(group).getByRole('button', { name: '次の月へ' })
    if (next.getAttribute('aria-disabled') === 'true') break
    fireEvent.click(next)
  }
  throw new Error(`減便の期間のカレンダーに ${date} が見つかりません`)
}

/** カレンダーの下の、選んだ期間の文(Popover の中。開いていなければ開く) */
function periodSummary(): string {
  periodCalendar()
  return screen.getByTestId('period-summary').textContent ?? ''
}

/** 文の下の確認の結果 */
function checks(): HTMLElement {
  return screen.getByRole('region', { name: '確認の結果' })
}

/** 「詳しい設定」(畳んである欄) */
function details(): HTMLDetailsElement {
  return screen.getByTestId('policy-details') as HTMLDetailsElement
}

/** shadcn/ui(Radix)の Select をキーボードで開いて、選択肢を選ぶ */
function chooseOption(selectName: string, optionName: string) {
  const trigger = screen.getByRole('combobox', { name: selectName })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(screen.getByRole('option', { name: optionName }))
}

describe('PolicyStep', () => {
  it('GTFS を読み込む前は、手順の名前で読み込みを案内する', () => {
    act(() => useEditStore.getState().setBase(null))
    render(<PolicyStep />)
    expect(screen.getByText('手順「読み込み」で GTFS を読み込むと、減便の方針を選べます。')).toBeTruthy()
  })

  it('減便の方針は1つの文の穴を埋める形で、部品は文の順に並ぶ(読み上げの名前つき)', () => {
    render(<PolicyStep />)
    // 文全体は fieldset(名前は見出しと重ならない「減便の内容」)
    const group = screen.getByRole('group', { name: '減便の内容' })
    expect(group.tagName).toBe('FIELDSET')
    expect(group.contains(sentence())).toBe(true)
    // 部品(穴)と文字の並び。理由は選んでいないので穴に薄く「理由」、期間は今日(10/20)から当面の間
    const parts = [...sentence().children]
      .filter((el) => !(el.tagName === 'SELECT' && el.getAttribute('aria-hidden') === 'true'))
      .map((el) => el.getAttribute('aria-label') ?? el.textContent)
    expect(parts).toEqual([
      '減便の理由',
      'のため、',
      '開始日:10月20日(火)',
      'から',
      '終了日:当面の間',
      '、',
      '変更するダイヤ',
      'を',
      '変更後のダイヤ',
      'ダイヤに',
      '変更する。',
    ])
    // 穴の中の文字。文として「理由 のため、10月20日(火) から 当面の間、平日 を 土曜 ダイヤに変更する。」と読める
    const reason = within(sentence()).getByRole('combobox', { name: '減便の理由' })
    expect(reason.textContent).toBe('理由')
    // 選んでいない理由の穴は破線の枠
    expect(reason.className).toContain('border-dashed')
    expect(within(sentence()).getByRole('combobox', { name: '変更するダイヤ' }).textContent).toBe('平日')
    expect(within(sentence()).getByRole('combobox', { name: '変更後のダイヤ' }).textContent).toBe('土曜')
    expect(sentenceText()).toBe('理由のため、10月20日(火)から当面の間、平日を土曜ダイヤに変更する。')
    // ラジオボタンは使わない
    expect(within(group).queryAllByRole('radio')).toHaveLength(0)
    // Tab の順は文の順(どの部品も tabindex で順を変えない)
    const focusables = [...sentence().querySelectorAll<HTMLElement>('button, input, [role="combobox"]')].filter(
      (el) => el.closest('[aria-hidden="true"]') === null,
    )
    expect(focusables.map((el) => el.getAttribute('aria-label'))).toEqual([
      '減便の理由',
      '開始日:10月20日(火)',
      '終了日:当面の間',
      '変更するダイヤ',
      '変更後のダイヤ',
    ])
    expect(focusables.every((el) => !el.hasAttribute('tabindex') || el.getAttribute('tabindex') === '0')).toBe(true)
    // 補足の欄は、区分を選ぶまで出さない
    expect(screen.queryByLabelText('補足')).toBeNull()
  })

  it('終了日を決めると「までの間」を出し、当面の間に戻すと消す', () => {
    render(<PolicyStep />)
    fireEvent.click(indefiniteBox())
    // 終了日がまだなら、終了日の穴は破線の枠に薄く「終了日」
    expect(hole('終了日').getAttribute('aria-label')).toBe('終了日(未選択)')
    expect(hole('終了日').textContent).toBe('終了日')
    expect(hole('終了日').className).toContain('border-dashed')
    pickDate('20261113')
    expect(hole('終了日').getAttribute('aria-label')).toBe('終了日:11月13日(金)')
    expect(sentenceText()).toBe('理由のため、10月20日(火)から11月13日(金)までの間、平日を土曜ダイヤに変更する。')
    fireEvent.click(indefiniteBox())
    expect(sentenceText()).toBe('理由のため、10月20日(火)から当面の間、平日を土曜ダイヤに変更する。')
    expect(sentenceText()).not.toContain('までの間')
  })

  it('理由の「その他」を選ぶと文の中に入力欄が出て(焦点も移る)、書いた文が理由のメモになる(区分は null)', async () => {
    render(<PolicyStep />)
    expect(screen.queryByRole('textbox', { name: '減便の理由(その他)' })).toBeNull()
    chooseOption('減便の理由', 'その他')
    const other = within(sentence()).getByRole('textbox', { name: '減便の理由(その他)' })
    await waitFor(() => expect(document.activeElement).toBe(other))
    // 入力欄は理由の穴のすぐ後ろ(「のため、」の前)
    expect(other.nextElementSibling?.textContent).toBe('のため、')
    fireEvent.change(other, { target: { value: ' 道路工事による迂回 ' } })
    // 「その他」では補足の欄を出さない(書いた文がそのまま理由)
    expect(screen.queryByLabelText('補足')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '3(R3)を入れ替えから外す' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const op = useEditStore.getState().draft?.kind === 'op' ? useEditStore.getState().draft : null
    expect(op?.kind === 'op' && op.record.op.type === 'applyPolicy' && op.record.op.reason).toEqual({ category: null, note: '道路工事による迂回' })
  })

  it('区分を選ぶと文の下に補足の欄が出て、区分と補足が理由になる。「選ばない」に戻すと理由は空になる', () => {
    render(<PolicyStep />)
    chooseOption('減便の理由', '運転士の一時的な欠員')
    expect(within(sentence()).getByRole('combobox', { name: '減便の理由' }).textContent).toBe('運転士の一時的な欠員')
    expect(sentenceText()).toContain('運転士の一時的な欠員のため、')
    const note = screen.getByLabelText('補足')
    // 補足は文の外(文の下)
    expect(sentence().contains(note)).toBe(false)
    fireEvent.change(note, { target: { value: '欠員 2 名' } })
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    let draft = useEditStore.getState().draft
    expect(draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' && draft.record.op.reason).toEqual({
      category: 'temporaryShortage',
      note: '欠員 2 名',
    })
    act(() => useEditStore.getState().discard())
    // 「選ばない」に戻すと、書いた補足が残っていても理由は空(区分もメモも無い)
    chooseOption('減便の理由', '選ばない')
    expect(within(sentence()).getByRole('combobox', { name: '減便の理由' }).textContent).toBe('理由')
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    draft = useEditStore.getState().draft
    expect(draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' && draft.record.op.reason).toEqual({ category: null, note: '' })
  })

  it('日付の穴を押すと期間のカレンダーを Popover で開き、選んだ日が穴に入る。Escape で閉じて焦点は穴に戻る', async () => {
    render(<PolicyStep />)
    expect(screen.queryByRole('group', { name: '減便の期間' })).toBeNull()
    const startHole = hole('開始日')
    expect(startHole.getAttribute('aria-haspopup')).toBe('dialog')
    expect(startHole.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(startHole)
    expect(startHole.getAttribute('aria-expanded')).toBe('true')
    const calendar = screen.getByRole('group', { name: '減便の期間' })
    // 最初の焦点はカレンダーの日(選んでいる開始日)
    expect(document.activeElement).toBe(dayIn(calendar, '20261020'))
    // 当面の間を外し、終了日を選ぶ
    fireEvent.click(within(calendar).getByLabelText('当面の間(終わりを決めない)'))
    fireEvent.click(dayIn(calendar, '20261110')!)
    expect(hole('終了日').getAttribute('aria-label')).toBe('終了日:11月10日(火)')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: '減便の期間' })).toBeNull()
    // 焦点は Radix が閉じたあとに(次の処理で)押した穴に戻す
    await waitFor(() => expect(document.activeElement).toBe(hole('開始日')))
    expect(sentenceText()).toContain('10月20日(火)から11月10日(火)までの間、')
  })

  it('終了日の穴から開くと、終了日を押すよう案内し、開始日より後の日を押すと終了日だけを変える。「閉じる」で閉じる', async () => {
    render(<PolicyStep />)
    fireEvent.click(indefiniteBox())
    pickDate('20261110')
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('group', { name: '減便の期間' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(hole('開始日')))

    const calendar = periodCalendar('終了日')
    expect(calendar.textContent).toContain('カレンダーで終了日を押してください。')
    // 期間が決まったあとでも、開始日から選び直さず終了日だけを変える
    fireEvent.click(dayIn(calendar, '20261120')!)
    expect(periodSummary()).toBe('期間:2026年10月20日(火)〜11月20日(金)(32日間)')
    fireEvent.click(within(calendar).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(document.activeElement).toBe(hole('終了日')))
    expect(hole('開始日').getAttribute('aria-label')).toBe('開始日:10月20日(火)')
    expect(hole('終了日').getAttribute('aria-label')).toBe('終了日:11月20日(金)')
  })

  it('「詳しい設定」は畳んで出し、開くと service の選び直しと系統の除外がある。summary に今の service と外す系統の数を出す', () => {
    render(<PolicyStep />)
    const d = details()
    expect(d.open).toBe(false)
    const summary = d.querySelector('summary')!
    expect(summary.textContent).toBe('詳しい設定(service:平日 WK を土曜 SA に、除外する系統:なし)')
    fireEvent.click(within(d).getByRole('checkbox', { name: '3(R3)を入れ替えから外す' }))
    expect(summary.textContent).toBe('詳しい設定(service:平日 WK を土曜 SA に、除外する系統:1 系統)')
    expect(d.contains(screen.getByLabelText('入れ替え元のダイヤ(平日)'))).toBe(true)
    expect(d.contains(screen.getByLabelText('入れ替えに使うダイヤ(土曜)'))).toBe(true)
    d.open = true
    fireEvent(d, new Event('toggle'))
    expect(details().open).toBe(true)
    // 推定に問題がなければ、確認の結果に service の案内は出さない
    expect(checks().textContent).not.toContain('詳しい設定で service を選んでください')
  })

  it('service を推定できないときは、確認の結果に案内を出し、詳しい設定を開いておく。閉じても「詳しい設定を開く」で開ける', () => {
    // 平日の service の曜日の列を全部 0 にして、平日のダイヤを推定できないようにする
    const feed = smallFeed()
    const wk = feed.tables.get('calendar')!.rows.find((r) => r.service_id === 'WK')!
    for (const d of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) wk[d] = '0'
    act(() => useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null }))
    render(<PolicyStep />)
    expect(checks().textContent).toContain('入れ替える service を推定できませんでした。詳しい設定で service を選んでください。')
    expect(details().open).toBe(true)
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', true)
    // 利用者が閉じたら、案内のボタンで開ける
    details().open = false
    fireEvent(details(), new Event('toggle'))
    expect(details().open).toBe(false)
    fireEvent.click(within(checks()).getByRole('button', { name: '詳しい設定を開く' }))
    expect(details().open).toBe(true)
    expect(within(checks()).queryByRole('button', { name: '詳しい設定を開く' })).toBeNull()
  })

  it('承認した方針の理由が区分なし・メモありなら、「その他」とメモを出す', () => {
    act(() => {
      const { addBackTripIds: _a, ...settings } = basePlan()
      useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note: '道路工事' } }, 'user')
      useEditStore.getState().commit()
    })
    render(<PolicyStep />)
    expect(screen.getByRole('region', { name: '承認した減便の方針' }).textContent).toContain('理由:その他(道路工事)')
  })

  it('AI の方針の下書きが別の場所で承認されて履歴が変わったら、AI の値は使わない(すべて戻すと既定の文に戻る)', () => {
    act(() => {
      const { addBackTripIds: _a, ...settings } = basePlan({ period: { start: '20261109', end: '20261127' } })
      useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note: '道路工事' } }, 'claude')
    })
    render(<PolicyStep />)
    act(() => {
      useEditStore.getState().commit()
    })
    expect(useEditStore.getState().history).toHaveLength(1)
    act(() => useEditStore.getState().undoAll())
    expect(useEditStore.getState().history).toEqual([])
    expect(sentenceText()).toBe('理由のため、10月20日(火)から当面の間、平日を土曜ダイヤに変更する。')
  })

  it('AI の方針の下書きの値(理由・期間・種類・除外)は文の穴に入り、「やめる」で戻ると AI の値のまま直せる', () => {
    act(() => {
      const { addBackTripIds: _a, ...settings } = basePlan({
        kind: 'weekdayToSundayHoliday',
        replacementService: 'SU',
        period: { start: '20261109', end: '20261127' },
        excludedRoutes: ['R3'],
      })
      useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note: '道路工事' } }, 'claude')
    })
    render(<PolicyStep />)
    expect(screen.getByRole('region', { name: '対象便の確認' })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('region', { name: '対象便の確認' })).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().draft).toBeNull()
    // 区分の無いメモは「その他」と、その文
    expect(within(sentence()).getByRole('combobox', { name: '減便の理由' }).textContent).toBe('その他')
    expect(within(sentence()).getByRole('textbox', { name: '減便の理由(その他)' })).toHaveProperty('value', '道路工事')
    expect(hole('開始日').getAttribute('aria-label')).toBe('開始日:11月9日(月)')
    expect(hole('終了日').getAttribute('aria-label')).toBe('終了日:11月27日(金)')
    expect(within(sentence()).getByRole('combobox', { name: '変更後のダイヤ' }).textContent).toBe('日祝')
    expect(sentenceText()).toBe('その他のため、11月9日(月)から11月27日(金)までの間、平日を日祝ダイヤに変更する。')
    expect(details().querySelector('summary')!.textContent).toBe('詳しい設定(service:平日 WK を日祝 SU に、除外する系統:1 系統)')
    expect(screen.getByRole('checkbox', { name: '3(R3)を入れ替えから外す' })).toHaveProperty('checked', true)
  })

  it('「その他」の文と区分の補足は別に持ち、理由を切り替えても片方の文をもう片方に持ち越さない', () => {
    render(<PolicyStep />)
    chooseOption('減便の理由', 'その他')
    fireEvent.change(within(sentence()).getByRole('textbox', { name: '減便の理由(その他)' }), { target: { value: '道路工事による迂回' } })
    // その他 → 区分:補足の欄は空
    chooseOption('減便の理由', '需要の減少')
    expect(screen.getByLabelText('補足')).toHaveProperty('value', '')
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    let draft = useEditStore.getState().draft
    expect(draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' && draft.record.op.reason).toEqual({ category: 'demandDecline', note: '' })
    act(() => useEditStore.getState().discard())
    // 区分の補足 → その他:その他の欄に補足の文を入れない(前に書いたその他の文に戻る)
    fireEvent.change(screen.getByLabelText('補足'), { target: { value: '利用者 3 割減' } })
    chooseOption('減便の理由', 'その他')
    expect(within(sentence()).getByRole('textbox', { name: '減便の理由(その他)' })).toHaveProperty('value', '道路工事による迂回')
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    draft = useEditStore.getState().draft
    expect(draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' && draft.record.op.reason).toEqual({ category: null, note: '道路工事による迂回' })
  })

  it('「その他」を選んで文が空なら、理由を記録しないと確認の結果に出す', () => {
    render(<PolicyStep />)
    chooseOption('減便の理由', 'その他')
    expect(checks().textContent).toContain('その他の理由が空のため、理由は記録しません。')
    fireEvent.change(within(sentence()).getByRole('textbox', { name: '減便の理由(その他)' }), { target: { value: '道路工事' } })
    expect(checks().textContent).not.toContain('その他の理由が空のため')
  })

  it('期間がそろわない間は、確認の結果に足りないものを出し、詳しい設定の summary は「期間を選ぶと推定します」と出す', () => {
    render(<PolicyStep />)
    expect(checks().textContent).not.toContain('当面の間にしてください')
    fireEvent.click(indefiniteBox())
    expect(checks().textContent).toContain('終了日を選ぶか、当面の間にしてください。')
    expect(details().querySelector('summary')!.textContent).toBe('詳しい設定(service:期間を選ぶと推定します、除外する系統:なし)')
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', true)
    pickDate('20261113')
    expect(checks().textContent).not.toContain('当面の間にしてください')
    expect(details().querySelector('summary')!.textContent).toBe('詳しい設定(service:平日 WK を土曜 SA に、除外する系統:なし)')
  })

  it('入れ替えに使うダイヤの便がない系統は、確認の結果に数を出し、「詳しい設定を開く」で系統の除外の表まで開く。除外すると消える', () => {
    render(<PolicyStep />)
    // R3 は土曜の便がない
    expect(checks().textContent).toContain('土曜の便がない系統が 1 系統あり、このままでは全曜日で便がなくなります。詳しい設定で入れ替えから除外できます。')
    expect(details().open).toBe(false)
    const routes = screen.getByRole('checkbox', { name: '3(R3)を入れ替えから外す' }).closest('details') as HTMLDetailsElement
    expect(routes).not.toBe(details())
    expect(routes.open).toBe(false)
    fireEvent.click(within(checks()).getByRole('button', { name: '詳しい設定を開く' }))
    expect(details().open).toBe(true)
    expect(routes.open).toBe(true)
    expect(within(checks()).queryByRole('button', { name: '詳しい設定を開く' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '3(R3)を入れ替えから外す' }))
    expect(checks().textContent).not.toContain('土曜の便がない系統が')
  })

  it('service を選び直したあとに期間を変えて推定が変わったら、確認の結果に案内を出し、閉じていた詳しい設定をまた開く', () => {
    // 平日のダイヤを 11/15 までの WK と 11/16 からの WK2 に分けたフィード。両方が走る期間では平日を推定できない
    const feed0 = smallFeed()
    const calendar = feed0.tables.get('calendar')!.rows.map((r) => (r.service_id === 'WK' ? { ...r, end_date: '20261115' } : r))
    calendar.push({ ...calendar.find((r) => r.service_id === 'WK')!, service_id: 'WK2', start_date: '20261116', end_date: '20261130' })
    const trips = [...feed0.tables.get('trips')!.rows, { route_id: 'R1', service_id: 'WK2', trip_id: 'R1_0700_WK2', trip_headsign: '市役所', block_id: '' }]
    const stopTimes = [
      ...feed0.tables.get('stop_times')!.rows,
      ...feed0.tables
        .get('stop_times')!
        .rows.filter((r) => r.trip_id === 'R1_0700_WK')
        .map((r) => ({ ...r, trip_id: 'R1_0700_WK2' })),
    ]
    const feed = withRows(withRows(withRows(feed0, 'calendar', calendar), 'trips', trips), 'stop_times', stopTimes)
    act(() => useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null }))
    render(<PolicyStep />)
    // 10/20 から当面の間では WK と WK2 の両方が走り、推定できない(詳しい設定は開いている)
    expect(checks().textContent).toContain('入れ替える service を推定できませんでした。')
    expect(details().open).toBe(true)
    // 平日の service を WK に選び直すと、案内は消える。利用者が詳しい設定を閉じる
    fireEvent.change(screen.getByLabelText('入れ替え元のダイヤ(平日)'), { target: { value: 'WK' } })
    expect(checks().textContent).not.toContain('詳しい設定で service を選んでください')
    details().open = false
    fireEvent(details(), new Event('toggle'))
    expect(details().open).toBe(false)
    // 開始日を 11/16 にすると推定は WK2 になり、選んだ WK と違う
    pickDate('20261116')
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(checks().textContent).toContain('入れ替える service の推定を確かめてください。詳しい設定で service を選んでください。')
    expect(details().open).toBe(true)
    expect(details().textContent).toContain('期間を変えたため、推定は WK2 になりました。')
    // 閉じても「詳しい設定を開く」で開ける
    details().open = false
    fireEvent(details(), new Event('toggle'))
    fireEvent.click(within(checks()).getByRole('button', { name: '詳しい設定を開く' }))
    expect(details().open).toBe(true)
  })

  it('推定と違う service を使った承認済みの方針で「減便の方針を変える」を押しても、推定が変わったとは扱わない(詳しい設定は畳んだまま)', () => {
    act(() => {
      const { addBackTripIds: _a, ...settings } = basePlan({ replacementService: 'SU' })
      useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note: '' } }, 'user')
      useEditStore.getState().commit()
    })
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('button', { name: '減便の方針を変える' }))
    expect(details().querySelector('summary')!.textContent).toBe('詳しい設定(service:平日 WK を土曜 SU に、除外する系統:なし)')
    expect(details().open).toBe(false)
    expect(checks().textContent).not.toContain('詳しい設定で service を選んでください')
    expect(details().textContent).not.toContain('期間を変えたため')
  })

  it('「減便の方針を変える」の途中で AI の方針の下書きが出たら、「やめる」で戻ると AI の値が文の穴に入っている', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('button', { name: '減便の方針を変える' }))
    act(() => {
      const { addBackTripIds: _a, ...settings } = basePlan({ period: { start: '20261109', end: '20261127' } })
      useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: 'chronicShortage', note: '退職 2 名' } }, 'claude')
    })
    fireEvent.click(within(screen.getByRole('region', { name: '対象便の確認' })).getByRole('button', { name: 'やめる' }))
    // 区分と補足の両方を持つ理由は、区分が穴に、補足が文の下の欄に入る
    expect(within(sentence()).getByRole('combobox', { name: '減便の理由' }).textContent).toBe('運転士の慢性的な不足')
    expect(screen.getByLabelText('補足')).toHaveProperty('value', '退職 2 名')
    expect(sentenceText()).toBe('運転士の慢性的な不足のため、11月9日(月)から11月27日(金)までの間、平日を土曜ダイヤに変更する。')
    expect(screen.getByRole('button', { name: '変えずに戻る' })).toBeTruthy()
  })

  it('AI の2つ目の方針の下書きが出たら、文の穴を2つ目の値に入れ替える', () => {
    const claudePolicy = (period: { start: string; end: string | null }, note: string) => {
      const { addBackTripIds: _a, ...settings } = basePlan({ period })
      useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note } }, 'claude')
    }
    act(() => claudePolicy({ start: '20261109', end: '20261127' }, '道路工事'))
    render(<PolicyStep />)
    fireEvent.click(within(screen.getByRole('region', { name: '対象便の確認' })).getByRole('button', { name: 'やめる' }))
    expect(sentenceText()).toBe('その他のため、11月9日(月)から11月27日(金)までの間、平日を土曜ダイヤに変更する。')
    act(() => claudePolicy({ start: '20261116', end: null }, '冬期の除雪'))
    fireEvent.click(within(screen.getByRole('region', { name: '対象便の確認' })).getByRole('button', { name: 'やめる' }))
    expect(within(sentence()).getByRole('textbox', { name: '減便の理由(その他)' })).toHaveProperty('value', '冬期の除雪')
    expect(sentenceText()).toBe('その他のため、11月16日(月)から当面の間、平日を土曜ダイヤに変更する。')
  })

  it('祝日一覧が無ければ、祝日の確認をしていないと出し、読み込み直すボタンで読み直す', () => {
    const load = vi.fn(async () => {})
    useHolidayStore.setState({ load })
    render(<PolicyStep />)
    expect(screen.getByText(/祝日一覧を読めないため、祝日の確認をしていません/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '祝日一覧を読み込み直す' }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('写す元の便が無い系統を、除外の表の先頭にまとめて注意を出す(除外は推定しない)', () => {
    render(<PolicyStep />)
    const boxes = screen.getAllByRole('checkbox', { name: /を入れ替えから外す/ })
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      '3(R3)を入れ替えから外す',
      '1(R1)を入れ替えから外す',
      '2(R2)を入れ替えから外す',
    ])
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true)
    expect(screen.getByText(/入れ替えると全曜日で便がなくなります/)).toBeTruthy()
  })

  it('系統を外して確かめると、除外した系統の数と印を出す', () => {
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('checkbox', { name: '3(R3)を入れ替えから外す' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const review = screen.getByRole('region', { name: '対象便の確認' })
    const counts = within(review).getByLabelText('平日便の件数').textContent ?? ''
    expect(counts).toContain('除外した系統:1 系統')
    expect(counts).toContain('全曜日で便がなくなる系統:0 系統')
    // 全曜日で便がなくなる系統が無ければ、確かめのチェックなしで進める
    expect(within(review).queryByLabelText('全曜日で便がなくなる系統があることを確かめました')).toBeNull()
    expect(within(review).getByRole('button', { name: '承認する' })).toHaveProperty('disabled', false)
    expect(review.querySelector('[data-route="R3"]')?.textContent).toContain('除')
  })

  it('画面で選んだ service を、チャットのツールに渡し、入力欄を閉じたら既定に戻す', () => {
    const { unmount } = render(<PolicyStep />)
    fireEvent.change(screen.getByLabelText('入れ替え元のダイヤ(平日)'), { target: { value: 'SU' } })
    expect(chatToolDeps.policyServices(null)?.weekday).toBe('SU')
    // 期間を渡しても、利用者が選んだ役割はそのまま
    expect(chatToolDeps.policyServices({ start: '20261109', end: '20270331' })?.weekday).toBe('SU')
    unmount()
    expect(chatToolDeps.policyServices(null)?.weekday).not.toBe('SU')
  })

  it('平日の service が新しい有効期間の中で1日も走らない期間は、方針の確かめに誤りとして出て、「対象便を確かめる」を押せない', () => {
    render(<PolicyStep />)
    // 平日の service を利用者が選んだままにする(選ばないと、走らない service は推定の候補から外れ、service が決まらない)
    fireEvent.change(screen.getByLabelText('入れ替え元のダイヤ(平日)'), { target: { value: 'WK' } })
    // 2026-11-07(土)〜11-08(日)。平日 WK の calendar とは重なるが、月〜金の日が1日も無い。
    // 当面の間のまま開始日を押し、チェックを外して終了日を押す
    pickDate('20261107')
    fireEvent.click(indefiniteBox())
    pickDate('20261108')
    expect(periodSummary()).toBe('期間:2026年11月7日(土)〜11月8日(日)(2日間)')
    const check = screen.getByRole('region', { name: '減便内容の確認' })
    const issue = check.querySelector('[data-code="weekdayNotActive"]')
    expect(issue?.getAttribute('data-severity')).toBe('error')
    // 文言は checkPolicy(ops.ts)が持つ。画面は code ごとの文言の表を持たず、そのまま出す
    expect(issue?.textContent).toContain('1日も走りません')
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', true)
  })

  it('祝日一覧が確かめの途中で読めたら、対象便の確かめの祝日の注意を今の一覧で出し直し、承認はそのまま進められる', () => {
    render(<PolicyStep />)
    // 全曜日で便がなくなる系統(R3)を外して、確かめのチェックなしで進められるようにする
    fireEvent.click(screen.getByRole('checkbox', { name: '3(R3)を入れ替えから外す' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const review = screen.getByRole('region', { name: '対象便の確認' })
    // 下書きを作ったときは祝日一覧が無い
    expect(review.querySelector('[data-code="holidayListMissing"]')).not.toBeNull()
    expect(review.querySelector('[data-code="holidayWithoutException"]')).toBeNull()
    expect(within(review).getByRole('button', { name: '承認する' })).toHaveProperty('disabled', false)

    act(() =>
      useHolidayStore.setState({
        holidays: {
          status: 'ready',
          list: {
            names: new Map([['20261123', '勤労感謝の日']]),
            first: '19550101',
            coveredUntil: '20271231',
            source: '内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成',
          },
        },
      }),
    )
    // 11/23(月)は祝日で、減便後の平日ダイヤが走る(例外なし)。「読めない」は消える
    expect(review.querySelector('[data-code="holidayListMissing"]')).toBeNull()
    expect(review.querySelector('[data-code="holidayWithoutException"]')?.textContent).toContain('20261123')
    // 祝日の注意は warning・info なので、承認を止めない
    expect(review.querySelector('[data-severity="error"]')).toBeNull()
    const proceed = within(review).getByRole('button', { name: '承認する' })
    expect(proceed).toHaveProperty('disabled', false)
    fireEvent.click(proceed)
    expect(useEditStore.getState().history).toHaveLength(1)
  })

  it('系統ごとの表で、印は系統名と同じ行に入れず、系統名の下の行に置く(380px の幅で系統名が折れないように)', () => {
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('checkbox', { name: '2(R2)を入れ替えから外す' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const review = screen.getByRole('region', { name: '対象便の確認' })
    // R3 は平日だけの系統なので、入れ替えると全曜日で便がなくなる。R2 は外した系統
    for (const [route, mark] of [['R3', '全曜日で便なし'], ['R2', '除']] as const) {
      const cell = review.querySelector(`[data-route="${route}"] summary > span:first-child`)!
      const name = cell.firstElementChild!
      expect(name.textContent).toBe(route.slice(1))
      expect(name.className).toContain('block')
      const marks = name.nextElementSibling!
      expect(marks.textContent).toContain(mark)
      // 印は系統名の要素の外にある(同じ行に入らない)
      expect(name.contains(marks)).toBe(false)
    }
    // 印の無い系統(R1)は系統名だけ
    const plain = review.querySelector('[data-route="R1"] summary > span:first-child')!
    expect(plain.children).toHaveLength(1)
  })

  it('承認したあとは方針と理由を出し、「方針を変える」で今の方針を入れた入力に戻る', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    render(<PolicyStep />)
    const summary = screen.getByRole('region', { name: '承認した減便の方針' })
    expect(summary.textContent).toContain('運転士の一時的な欠員(欠員 2 名)')
    expect(summary.textContent).toContain('承認した減便の方針:平日を土曜ダイヤに')
    fireEvent.click(within(summary).getByRole('button', { name: '減便の方針を変える' }))
    expect(periodSummary()).toBe('期間:2026年11月1日(日)から当面の間')
    expect(within(sentence()).getByRole('combobox', { name: '減便の理由' }).textContent).toBe('運転士の一時的な欠員')
    expect(screen.getByLabelText('補足')).toHaveProperty('value', '欠員 2 名')
    fireEvent.click(screen.getByRole('button', { name: '変えずに戻る' }))
    expect(screen.getByRole('region', { name: '承認した減便の方針' })).toBeTruthy()
  })

  it('カレンダーは入力の有効期間の外の日を選べない。外の日の方針(Claude などが出したもの)でも「対象便を確かめる」が止まらず、期間を入力の端にそろえる警告が届く', () => {
    // 小さなフィードの有効期間は 2026-10-01〜2026-11-30
    act(() => {
      const { addBackTripIds: _a, ...settings } = basePlan({ period: { start: '20260915', end: '20261215' } })
      useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note: '' } }, 'user')
      useEditStore.getState().commit()
    })
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('button', { name: '減便の方針を変える' }))
    const form = screen.getByRole('form', { name: '減便の方針' }) as HTMLFormElement
    // ブラウザ標準の範囲検証では止めない(範囲外の日付は、アプリ側の確かめが警告で知らせる)
    expect(form.noValidate).toBe(true)

    // 入力の有効期間の外の日はカレンダーで選べない(10/1 の前の月へはめくれず、11/30 の次の月へもめくれない)
    const calendar = periodCalendar()
    expect(within(calendar).getByRole('button', { name: '次の月へ' }).getAttribute('aria-disabled')).toBe('true')
    expect(within(calendar).getByRole('button', { name: '前の月へ' }).getAttribute('aria-disabled')).toBe('true')

    // アプリ側の確かめ(checkPolicy)の警告が出る
    const check = screen.getByRole('region', { name: '減便内容の確認' })
    expect(check.querySelector('[data-code="periodStartClamped"]')?.textContent).toContain('入力の開始日(2026年10月1日)にそろえます')
    expect(check.querySelector('[data-code="periodEndClamped"]')?.textContent).toContain('入力の末日(2026年11月30日)にそろえます')

    // 押すと下書きができ、対象便の確かめに進む
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    expect(useEditStore.getState().draft?.kind).toBe('op')
    const review = screen.getByRole('region', { name: '対象便の確認' })
    expect(review.querySelector('[data-code="form2.periodStartClamped"]')).not.toBeNull()
    expect(review.querySelector('[data-code="form2.periodEndClamped"]')).not.toBeNull()
    expect(review.textContent).toContain('出力する GTFS の有効期間は 2026年10月1日〜2026年11月30日')
  })

  it('入力の有効期間の外の日は、カレンダーの日のボタンが押せない(disabled)', () => {
    render(<PolicyStep />)
    // 減便の期間のカレンダーは 2026-10 と 2026-11 を並べる。10 月は 1 日から、11 月は 30 日まで選べる
    const group = periodCalendar()
    expect(group.querySelectorAll('[role="grid"]')).toHaveLength(2)
    expect(dayIn(group, '20261001')).toHaveProperty('disabled', false)
    expect(dayIn(group, '20261130')).toHaveProperty('disabled', false)
    // 9 月・12 月へはめくれない
    expect(within(group).getByRole('button', { name: '前の月へ' }).getAttribute('aria-disabled')).toBe('true')
    expect(within(group).getByRole('button', { name: '次の月へ' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('期間は1つのカレンダーで、1回目に押した日が開始日、2回目に押した日が終了日になる', () => {
    render(<PolicyStep />)
    // 既定は今日(10/20)から当面の間。チェックを外すと終了日を空にして、次に押す日を終了日にする
    expect(periodSummary()).toBe('期間:2026年10月20日(火)から当面の間')
    fireEvent.click(indefiniteBox())
    expect(periodSummary()).toBe('開始日:2026年10月20日(火)。終了日をカレンダーで選んでください。')
    pickDate('20261113')
    expect(periodSummary()).toBe('期間:2026年10月20日(火)〜11月13日(金)(25日間)')
    const group = periodCalendar()
    expect(dayIn(group, '20261020')?.dataset.rangeStart).toBe('true')
    expect(dayIn(group, '20261113')?.dataset.rangeEnd).toBe('true')
    expect(dayIn(group, '20261101')?.dataset.rangeMiddle).toBe('true')
    expect(screen.getByText(/出力の有効期間は 2026年10月20日\(火\)〜2026年11月13日\(金\)\(25日\)/)).toBeTruthy()

    // 期間が決まったあとに押すと、その日から選び直す
    pickDate('20261109')
    expect(periodSummary()).toBe('開始日:2026年11月9日(月)。終了日をカレンダーで選んでください。')
    // 開始日より前の日を押すと、それを新しい開始日にする
    pickDate('20261102')
    expect(periodSummary()).toBe('開始日:2026年11月2日(月)。終了日をカレンダーで選んでください。')
    // 開始日と同じ日を押すと1日だけの期間
    pickDate('20261102')
    expect(periodSummary()).toBe('期間:2026年11月2日(月)の1日間')
    expect(dayIn(group, '20261102')?.getAttribute('aria-label')).toContain('開始日・終了日')
    expect(screen.getByText(/出力の有効期間は 2026年11月2日\(月\)〜2026年11月2日\(月\)\(1日\)/)).toBeTruthy()
  })

  it('減便の期間の欄は、名前を legend から取り、案内と期間の文を説明として指す。同じ名前のグループは1つだけ', () => {
    render(<PolicyStep />)
    periodCalendar()
    const groups = screen.getAllByRole('group', { name: '減便の期間' })
    expect(groups).toHaveLength(1)
    expect(groups[0].tagName).toBe('FIELDSET')
    const describedBy = (groups[0].getAttribute('aria-describedby') ?? '').split(' ')
    expect(describedBy).toHaveLength(2)
    const [hint, summary] = describedBy.map((id) => document.getElementById(id))
    expect(summary).toBe(screen.getByTestId('period-summary'))
    expect(hint?.textContent).toContain('開始日から入力の末日までを薄い帯で示します')
    // 当面の間を外すと、決めたあとに押せば選び直すことも案内する
    fireEvent.click(indefiniteBox())
    expect(hint?.textContent).toBe(
      'カレンダーで開始日、終了日の順に押してください。開始日と同じ日を押すと1日だけの期間になります。期間を決めたあとに押すと、その日から選び直します。',
    )
  })

  it('「期間を選び直す」は、当面の間で開始日が空なら押せない(使わない終了日の値が残っていても)', () => {
    const base = useEditStore.getState().base!
    // 開始日が空で当面の間の方針。終了日の値は入力の末日(20261130)が入っているが、当面の間では使わない
    render(<PolicyForm base={base} initial={basePlan({ period: { start: '', end: null } })} initialReason={null} />)
    expect(periodSummary()).toBe('開始日をカレンダーで選んでください。')
    const resetButton = screen.getByRole('button', { name: '期間を選び直す' })
    expect(resetButton).toHaveProperty('disabled', true)
    // 当面の間を外すと終了日も空にするので、押せないまま
    fireEvent.click(indefiniteBox())
    expect(resetButton).toHaveProperty('disabled', true)
    // 開始日を押すと押せる
    pickDate('20261105')
    expect(resetButton).toHaveProperty('disabled', false)
  })

  it('2か月を並べるかは、欄の幅を rem で比べて決める(ブラウザの既定の文字を大きくすると、同じ幅でも1か月にする)', () => {
    // ResizeObserver は使えるが通知しない形にして、最初の幅(getBoundingClientRect)だけで決める
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600 } as DOMRect)
    try {
      // 16px なら 33.75rem = 540px。600px の欄に2か月を並べる
      document.documentElement.style.fontSize = '16px'
      render(<PolicyStep />)
      expect(periodCalendar().querySelectorAll('[role="grid"]')).toHaveLength(2)
      cleanup()
      // 20px なら 33.75rem = 675px。同じ 600px の欄では1か月にする
      document.documentElement.style.fontSize = '20px'
      render(<PolicyStep />)
      expect(periodCalendar().querySelectorAll('[role="grid"]')).toHaveLength(1)
    } finally {
      document.documentElement.style.fontSize = ''
      vi.unstubAllGlobals()
    }
  })

  it('減便の期間の欄(fieldset)は、中身の幅に広がらないよう min-w-0 にする', () => {
    render(<PolicyStep />)
    expect(periodCalendar().className).toContain('min-w-0')
  })

  it('土曜と日祝が同じ時刻表の案内は、期間を選ぶ途中(1回目と2回目の押下の間)でも出たままにする', () => {
    // 日曜の service(SU)を、土曜(SA)と同じ便にしたフィード
    const feed0 = smallFeed()
    const saTrips = feed0.tables.get('trips')!.rows.filter((r) => r.service_id === 'SA')
    const suTrips = saTrips.map((r) => ({ ...r, service_id: 'SU', trip_id: r.trip_id!.replace(/_SA$/, '_SU') }))
    const trips = [...feed0.tables.get('trips')!.rows.filter((r) => r.service_id !== 'SU'), ...suTrips]
    const stopTimes0 = feed0.tables.get('stop_times')!.rows.filter((r) => !r.trip_id!.endsWith('_SU'))
    const suStopTimes = stopTimes0.filter((r) => r.trip_id!.endsWith('_SA')).map((r) => ({ ...r, trip_id: r.trip_id!.replace(/_SA$/, '_SU') }))
    const feed = withRows(withRows(feed0, 'trips', trips), 'stop_times', [...stopTimes0, ...suStopTimes])
    act(() => useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null }))
    render(<PolicyStep />)
    const note = () => screen.queryByText(/土曜と日祝が同じ時刻表のため/)
    expect(note()).not.toBeNull()
    fireEvent.click(indefiniteBox())
    // 開始日だけの間(期間がそろっていない)も、案内は出たまま
    expect(periodSummary()).toContain('終了日をカレンダーで選んでください')
    expect(note()).not.toBeNull()
    pickDate('20261110')
    expect(note()).not.toBeNull()
    // 期間が決まったあとに押して選び直す途中も同じ
    pickDate('20261105')
    expect(periodSummary()).toContain('終了日をカレンダーで選んでください')
    expect(note()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '期間を選び直す' }))
    expect(note()).not.toBeNull()
  })

  it('当面の間なら押した日が開始日になり、開始日から入力の末日までを薄い帯で示す', () => {
    render(<PolicyStep />)
    pickDate('20261116')
    expect(periodSummary()).toBe('期間:2026年11月16日(月)から当面の間')
    const group = periodCalendar()
    expect(dayIn(group, '20261116')?.dataset.rangePart).toBe('start')
    expect(dayIn(group, '20261117')?.dataset.rangePart).toBe('open')
    expect(dayIn(group, '20261130')?.dataset.rangePart).toBe('open')
    expect(dayIn(group, '20261115')?.dataset.rangePart).toBeUndefined()
    // 終了日は無い(range_end の印が付く日は無い)
    expect(group.querySelector('[data-range-end="true"]')).toBeNull()
    // もう一度押すと、その日が開始日になる(終了日にはならない)
    pickDate('20261120')
    expect(periodSummary()).toBe('期間:2026年11月20日(金)から当面の間')
  })

  it('「期間を選び直す」で開始日・終了日を空にし、案内を出し、焦点をカレンダーの日に移す', () => {
    render(<PolicyStep />)
    fireEvent.click(indefiniteBox())
    pickDate('20261110')
    expect(periodSummary()).toContain('〜11月10日(火)')
    const resetButton = screen.getByRole('button', { name: '期間を選び直す' })
    resetButton.focus()
    fireEvent.click(resetButton)
    expect(periodSummary()).toBe('開始日をカレンダーで選んでください。')
    // 押せなくなったボタンに焦点を残さず、カレンダーの Tab で入る日(最後に押した 11/10)に移す
    expect(document.activeElement).toBe(dayIn(periodCalendar(), '20261110'))
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0')
    expect(resetButton).toHaveProperty('disabled', true)
    expect(periodCalendar().querySelector('[aria-selected="true"]')).toBeNull()
    expect(screen.getByRole('button', { name: '期間を選び直す' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', true)
    pickDate('20261105')
    pickDate('20261125')
    expect(periodSummary()).toBe('期間:2026年11月5日(木)〜11月25日(水)(21日間)')
  })

  it('終了日が開始日より前(既存の方針など)なら、badPeriod の理由を期間の欄の下に出し、「対象便を確かめる」を押せない', () => {
    // カレンダーでは開始日より前を押すと新しい開始日になるので、終了日が開始日より前になるのは渡された方針だけ
    const base = useEditStore.getState().base!
    render(
      <PolicyForm base={base} initial={basePlan({ period: { start: '20261107', end: '20261103' } })} initialReason={null} />,
    )
    const reason = screen.getByRole('group', { name: '期間の確認' })
    const issue = reason.querySelector('[data-code="badPeriod"]')
    expect(issue?.getAttribute('data-severity')).toBe('error')
    expect(issue?.textContent).toContain('終了日(2026年11月3日)が開始日(2026年11月7日)より前です')
    // カレンダーは開始日だけを示し、帯は描かない
    expect(periodSummary()).toBe('開始日:2026年11月7日(土)、終了日:2026年11月3日(火)')
    expect(periodCalendar().querySelector('[data-range-middle="true"]')).toBeNull()
    // 理由は文の下の確認の結果だけに出し、「減便内容の確認」には重ねない
    expect(checks().contains(reason)).toBe(true)
    expect(screen.queryByRole('region', { name: '減便内容の確認' })?.querySelector('[data-code="badPeriod"]') ?? null).toBeNull()
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', true)
    // 選び直すと理由が消える(押した日から選び直し、次に押した日が終了日)
    pickDate('20261107')
    pickDate('20261120')
    expect(screen.queryByRole('group', { name: '期間の確認' })).toBeNull()
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', false)
  })

  it('開始日が入力の末日より後(方針を変える画面に出る既存の方針など)なら、emptyValidity の理由を期間の欄の下に出す', () => {
    const base = useEditStore.getState().base!
    render(
      <PolicyForm
        base={base}
        initial={basePlan({ period: { start: '20261201', end: null } })}
        initialReason={null}
      />,
    )
    const reason = screen.getByRole('group', { name: '期間の確認' })
    const issue = reason.querySelector('[data-code="emptyValidity"]')
    expect(issue?.getAttribute('data-severity')).toBe('error')
    expect(issue?.textContent).toContain('入力の有効期間(2026年10月1日〜2026年11月30日)と重なりません')
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toHaveProperty('disabled', true)
  })

  it('平日の service の calendar に日付の正しくない行があり、期間の中で1日も走らないときは、その行を数えていないと weekdayNotActive の文に添える', () => {
    const feed = smallFeed()
    const wk = feed.tables.get('calendar')!.rows.find((r) => r.service_id === 'WK')!
    wk.start_date = '20261332'
    act(() => useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null }))
    render(<PolicyStep />)
    fireEvent.change(screen.getByLabelText('入れ替え元のダイヤ(平日)'), { target: { value: 'WK' } })
    const issue = screen.getByRole('region', { name: '減便内容の確認' }).querySelector('[data-code="weekdayNotActive"]')
    expect(issue?.textContent).toContain('1日も走りません')
    expect(issue?.textContent).toContain('日付の正しくない calendar の行は数えていません')
    expect(issue?.textContent).toContain('日付の正しくない行が 1 行あります')
  })

  it('日付が正しい calendar の行だけなら、weekdayNotActive の文に日付の注意を足さない', () => {
    render(<PolicyStep />)
    fireEvent.change(screen.getByLabelText('入れ替え元のダイヤ(平日)'), { target: { value: 'WK' } })
    pickDate('20261107')
    fireEvent.click(indefiniteBox())
    pickDate('20261108')
    const issue = screen.getByRole('region', { name: '減便内容の確認' }).querySelector('[data-code="weekdayNotActive"]')
    expect(issue?.textContent).toContain('1日も走りません')
    expect(issue?.textContent).not.toContain('日付の正しくない')
  })

  it('AI の方針の下書きは、見出しに「下書き #n・AI の提案」と出す', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'claude')
    })
    render(<PolicyStep />)
    const draftId = useEditStore.getState().draft!.id
    const review = screen.getByRole('region', { name: '対象便の確認' })
    expect(within(review).getByRole('heading', { name: `対象便を確かめる(下書き #${draftId}・AI の提案)` })).toBeTruthy()
  })

  it('Claude の下書きがあるときに方針を確かめると、画面の中で捨ててよいかを先に確かめる(「やめる」なら何も変わらない)', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    const browserConfirm = vi.spyOn(window, 'confirm')
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('button', { name: '減便の方針を変える' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const draftId = useEditStore.getState().draft!.id
    // ブラウザ標準の確認ダイアログは使わず、押したボタンの場所に確認が出る(ボタンは確認に置き換わる)
    const box = screen.getByRole('group', { name: 'AI の下書きを破棄する確認' })
    expect(box.textContent).toContain(`AI の下書き #${draftId} を破棄して、この操作をしますか。`)
    expect(screen.queryByRole('button', { name: '対象便を確かめる' })).toBeNull()
    expect(browserConfirm).not.toHaveBeenCalled()
    // まだ何も変えていない
    expect(useEditStore.getState().draft?.id).toBe(draftId)

    // 「やめる」なら Claude の下書きは残り、確認は消えて元のボタンに戻る
    fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
    expect(screen.queryByRole('group', { name: 'AI の下書きを破棄する確認' })).toBeNull()
    expect(useEditStore.getState().draft?.id).toBe(draftId)
    const kept = useEditStore.getState().draft
    expect(kept?.kind === 'op' && kept.record.by).toBe('claude')
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '対象便の確認' })).toBeNull()

    // 「捨てて続ける」なら Claude の下書きを捨て、利用者の方針の下書きになる
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'AI の下書きを破棄する確認' })).getByRole('button', { name: '破棄して続ける' }))
    const draft = useEditStore.getState().draft
    expect(draft?.id).not.toBe(draftId)
    expect(draft?.kind === 'op' && draft.record.by).toBe('user')
    expect(draft?.kind === 'op' && draft.record.op.type).toBe('applyPolicy')
    expect(useEditStore.getState().draftNotices).toEqual([expect.objectContaining({ draftId, result: 'replaced' })])
    expect(screen.getByRole('region', { name: '対象便の確認' })).toBeTruthy()
    expect(browserConfirm).not.toHaveBeenCalled()
  })

  describe('編集の履歴の「元に戻す」「すべて戻す」(画面の中の確認)', () => {
    function twoEdits() {
      act(() => {
        useEditStore.getState().propose(policy(), 'user')
        useEditStore.getState().commit()
        useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: false }] }, 'user')
        useEditStore.getState().commit()
      })
      expect(useEditStore.getState().history).toHaveLength(2)
    }
    const history = () => within(screen.getByRole('region', { name: '編集の履歴' }))

    it('「すべて戻す」を押すと「本当にすべて戻しますか」と確かめ、「やめる」なら何も変わらない', () => {
      twoEdits()
      const browserConfirm = vi.spyOn(window, 'confirm')
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: 'すべて戻す' }))
      const box = history().getByRole('group', { name: 'すべて戻す確認' })
      expect(box.textContent).toContain('本当にすべて戻しますか')
      // 押したボタンの場所に出るので、「すべて戻す」は確認の中のボタンだけ
      expect(history().getAllByRole('button', { name: 'すべて戻す' })).toHaveLength(1)
      expect(history().queryByRole('button', { name: '元に戻す' })).toBeNull()
      expect(useEditStore.getState().history).toHaveLength(2)

      fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
      expect(useEditStore.getState().history).toHaveLength(2)
      expect(useEditStore.getState().versions).toHaveLength(2)
      expect(history().queryByRole('group', { name: 'すべて戻す確認' })).toBeNull()
      expect(history().getByRole('button', { name: '元に戻す' })).toBeTruthy()
      expect(browserConfirm).not.toHaveBeenCalled()
    })

    it('確かめで「すべて戻す」を押すと、履歴を空にして、読み込んだ GTFS のままに戻る', () => {
      twoEdits()
      const browserConfirm = vi.spyOn(window, 'confirm')
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: 'すべて戻す' }))
      fireEvent.click(within(history().getByRole('group', { name: 'すべて戻す確認' })).getByRole('button', { name: 'すべて戻す' }))
      expect(useEditStore.getState().history).toEqual([])
      expect(useEditStore.getState().versions).toEqual([])
      // 履歴が空になるので、編集の履歴の欄は消え、方針の入力に戻る
      expect(screen.queryByRole('region', { name: '編集の履歴' })).toBeNull()
      expect(screen.getByRole('form', { name: '減便の方針' })).toBeTruthy()
      expect(browserConfirm).not.toHaveBeenCalled()
    })

    it('Claude の下書きがあるときの「すべて戻す」は、下書きも捨てることを同じ確認で伝える', () => {
      twoEdits()
      act(() => {
        useEditStore.getState().propose({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] }, 'claude')
      })
      const draftId = useEditStore.getState().draft!.id
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: 'すべて戻す' }))
      // 確認は1つだけ(「下書きを捨てるか」と「すべて戻すか」を続けて聞かない)
      const box = history().getByRole('group', { name: 'すべて戻す確認' })
      expect(history().getAllByRole('group')).toHaveLength(1)
      expect(box.textContent).toContain(`AI の下書き #${draftId} も破棄します`)
      fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
      expect(useEditStore.getState().draft?.id).toBe(draftId)
      expect(useEditStore.getState().history).toHaveLength(2)
    })

    it('Claude の下書きがあるときに「すべて戻す」を確定すると、下書きも捨て、Claude に「捨てた」と伝える', () => {
      twoEdits()
      act(() => {
        useEditStore.getState().propose({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] }, 'claude')
      })
      const draftId = useEditStore.getState().draft!.id
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: 'すべて戻す' }))
      fireEvent.click(within(history().getByRole('group', { name: 'すべて戻す確認' })).getByRole('button', { name: 'すべて戻す' }))
      expect(useEditStore.getState().history).toEqual([])
      expect(useEditStore.getState().versions).toEqual([])
      expect(useEditStore.getState().draft).toBeNull()
      expect(useEditStore.getState().draftNotices).toEqual([expect.objectContaining({ draftId, by: 'claude', result: 'discarded' })])
    })

    it('「すべて戻す」の確認の間に履歴が変わったら確認を消し、あとで件数が同じに戻っても、押していない確認は出さない', () => {
      twoEdits()
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: 'すべて戻す' }))
      expect(history().getByRole('group', { name: 'すべて戻す確認' })).toBeTruthy()

      // 別の場所(足し戻しの手順)で編集を承認して 3 件になる。確認は消える
      act(() => {
        useEditStore.getState().propose({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] }, 'user')
        useEditStore.getState().commit()
      })
      expect(useEditStore.getState().history).toHaveLength(3)
      expect(history().queryByRole('group')).toBeNull()

      // Claude の「元に戻す」の下書きを承認して 2 件に戻る。前の「すべて戻す」の確認は出ない
      act(() => {
        useEditStore.getState().proposeUndo('claude')
        useEditStore.getState().commit()
      })
      expect(useEditStore.getState().history).toHaveLength(2)
      expect(history().queryByRole('group', { name: 'すべて戻す確認' })).toBeNull()
      expect(history().getByRole('button', { name: 'すべて戻す' })).toBeTruthy()
      expect(history().getByRole('button', { name: '元に戻す' })).toBeTruthy()
    })

    it('「すべて戻す」の確認の間に Claude の下書きが出て消えても、押していない確認はまた出さない', () => {
      twoEdits()
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: 'すべて戻す' }))
      expect(history().getByRole('group', { name: 'すべて戻す確認' })).toBeTruthy()

      // 履歴はそのまま、Claude の下書きが出て(確認は消える)、別の場所で捨てられる
      act(() => {
        useEditStore.getState().propose({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] }, 'claude')
      })
      expect(history().queryByRole('group', { name: 'すべて戻す確認' })).toBeNull()
      act(() => useEditStore.getState().discard())
      expect(useEditStore.getState().history).toHaveLength(2)
      expect(history().queryByRole('group', { name: 'すべて戻す確認' })).toBeNull()
      expect(history().getByRole('button', { name: 'すべて戻す' })).toBeTruthy()
    })

    it('Claude の下書きが無ければ、「元に戻す」は確かめずにすぐ1つ戻す', () => {
      twoEdits()
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: '元に戻す' }))
      expect(history().queryByRole('group')).toBeNull()
      expect(useEditStore.getState().history).toHaveLength(1)
    })

    it('Claude の下書きがあるときの「元に戻す」は、捨ててよいかを確かめ、「やめる」なら何も変わらない', () => {
      twoEdits()
      act(() => {
        useEditStore.getState().propose({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] }, 'claude')
      })
      const draftId = useEditStore.getState().draft!.id
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: '元に戻す' }))
      const box = history().getByRole('group', { name: 'AI の下書きを破棄する確認' })
      expect(box.textContent).toContain(`AI の下書き #${draftId} を破棄して、この操作をしますか。`)
      fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
      expect(useEditStore.getState().draft?.id).toBe(draftId)
      expect(useEditStore.getState().history).toHaveLength(2)

      fireEvent.click(history().getByRole('button', { name: '元に戻す' }))
      fireEvent.click(within(history().getByRole('group', { name: 'AI の下書きを破棄する確認' })).getByRole('button', { name: '破棄して続ける' }))
      expect(useEditStore.getState().history).toHaveLength(1)
      expect(useEditStore.getState().draft).toBeNull()
    })

    it('「元に戻す」の確認の間に Claude の下書きが別の場所で捨てられたら確認を消し、次の Claude の下書きには押していない確認を出さない', () => {
      twoEdits()
      act(() => {
        useEditStore.getState().propose({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] }, 'claude')
      })
      render(<PolicyStep />)
      fireEvent.click(history().getByRole('button', { name: '元に戻す' }))
      expect(history().getByRole('group', { name: 'AI の下書きを破棄する確認' })).toBeTruthy()

      // 足し戻しの手順などで下書きを「やめる」。確認は消える
      act(() => useEditStore.getState().discard())
      expect(history().queryByRole('group')).toBeNull()

      // Claude が次の下書きを出す。履歴の件数は同じだが、利用者は押していないので確認は出ない
      act(() => {
        useEditStore.getState().propose({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] }, 'claude')
      })
      const next = useEditStore.getState().draft!.id
      expect(history().queryByRole('group')).toBeNull()
      expect(history().getByRole('button', { name: '元に戻す' })).toBeTruthy()
      // 何も消えていない(履歴は 2 件、Claude の次の下書きは残る)
      expect(useEditStore.getState().history).toHaveLength(2)
      expect(useEditStore.getState().draft?.id).toBe(next)

      // 押し直せば、次の下書きについて確かめる
      fireEvent.click(history().getByRole('button', { name: '元に戻す' }))
      const box = history().getByRole('group', { name: 'AI の下書きを破棄する確認' })
      expect(box.textContent).toContain(`AI の下書き #${next} を破棄して、この操作をしますか。`)
    })
  })
})

describe('Notice47Table(公示第47号の時間帯ごとの便数)', () => {
  function route(routeId: string, before: number, after: number): RouteDiff {
    return {
      routeId,
      routeName: `系統${routeId}`,
      before,
      after,
      removed: before - after,
      added: 0,
      same: after,
      excluded: false,
      firstDepartureBefore: null,
      firstDepartureAfter: null,
      lastDepartureBefore: null,
      lastDepartureAfter: null,
      vanishes: after === 0,
    }
  }
  const diff: WeekdayDiff = {
    removed: [],
    added: [],
    same: [],
    byRoute: [route('0031', 11, 4), route('0040', 16, 9), route('0050', 12, 11)],
    byStartBand: [],
    byNotice47Band: [
      { routeId: '0031', routeName: '系統0031', band: '6〜9時台', before: 3, after: 0 },
      { routeId: '0031', routeName: '系統0031', band: '10〜14時台', before: 8, after: 4 },
      { routeId: '0040', routeName: '系統0040', band: '6〜9時台', before: 16, after: 9 },
      { routeId: '0050', routeName: '系統0050', band: '6〜9時台', before: 12, after: 11 },
    ],
    vanishingRoutes: 0,
  }

  it('11〜15 回の系統が 10 回以下になるとき(系統の回数で判定)、公示第46号の表の下限を下回ると出す', () => {
    const html = renderToString(<Notice47Table diff={diff} />)
    const text = html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '')
    expect(text).toContain('系統0031:11 → 4 回。公示第46号の表の下限を下回ります。')
    // 16 回からの系統と、10 回より多く残る系統は当てはまらない
    expect(text).not.toContain('系統0040:')
    expect(text).not.toContain('系統0050:')
    expect(html.match(/data-below-notice46="true"/g)).toHaveLength(1)
  })

  it('0 回になる系統 × 帯に印を付け、数を見出しに出す', () => {
    const html = renderToString(<Notice47Table diff={diff} />)
    expect(html.match(/data-zero="true"/g)).toHaveLength(1)
    expect(html.replace(/<!-- -->/g, '')).toContain('(0 回になる系統 × 帯 1)')
  })
})
