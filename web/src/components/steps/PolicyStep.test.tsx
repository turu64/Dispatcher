// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { RouteDiff, WeekdayDiff } from '@/gtfs/edit/diff'
import type { EditOp } from '@/gtfs/edit/ops'
import { chatToolDeps } from '@/store/chat'
import { useEditStore } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
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

describe('PolicyStep', () => {
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
    const review = screen.getByRole('region', { name: '対象便の確かめ' })
    const counts = within(review).getByLabelText('平日便の件数').textContent ?? ''
    expect(counts).toContain('除外した系統:1 系統')
    expect(counts).toContain('全曜日で便がなくなる系統:0 系統')
    // 全曜日で便がなくなる系統が無ければ、確かめのチェックなしで進める
    expect(within(review).queryByLabelText('全曜日で便がなくなる系統があることを確かめました')).toBeNull()
    expect(within(review).getByRole('button', { name: 'この内容で進める' })).toHaveProperty('disabled', false)
    expect(review.querySelector('[data-route="R3"]')?.textContent).toContain('除')
  })

  it('画面で選んだ service を、チャットのツールに渡し、入力欄を閉じたら既定に戻す', () => {
    const { unmount } = render(<PolicyStep />)
    fireEvent.change(screen.getByLabelText('平日のダイヤ(入れ替える側)'), { target: { value: 'SU' } })
    expect(chatToolDeps.policyServices(null)?.weekday).toBe('SU')
    // 期間を渡しても、利用者が選んだ役割はそのまま
    expect(chatToolDeps.policyServices({ start: '20261109', end: '20270331' })?.weekday).toBe('SU')
    unmount()
    expect(chatToolDeps.policyServices(null)?.weekday).not.toBe('SU')
  })

  it('平日の service が新しい有効期間の中で1日も走らない期間は、方針の確かめに誤りとして出て、「対象便を確かめる」を押せない', () => {
    render(<PolicyStep />)
    // 平日の service を利用者が選んだままにする(選ばないと、走らない service は推定の候補から外れ、service が決まらない)
    fireEvent.change(screen.getByLabelText('平日のダイヤ(入れ替える側)'), { target: { value: 'WK' } })
    // 2026-11-07(土)〜11-08(日)。平日 WK の calendar とは重なるが、月〜金の日が1日も無い
    fireEvent.change(screen.getByLabelText('開始日'), { target: { value: '2026-11-07' } })
    fireEvent.click(screen.getByLabelText('当面の間(終わりを決めない)'))
    fireEvent.change(screen.getByLabelText('終了日'), { target: { value: '2026-11-08' } })
    const check = screen.getByRole('region', { name: '方針の確かめ' })
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
    const review = screen.getByRole('region', { name: '対象便の確かめ' })
    // 下書きを作ったときは祝日一覧が無い
    expect(review.querySelector('[data-code="holidayListMissing"]')).not.toBeNull()
    expect(review.querySelector('[data-code="holidayWithoutException"]')).toBeNull()
    expect(within(review).getByRole('button', { name: 'この内容で進める' })).toHaveProperty('disabled', false)

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
    const proceed = within(review).getByRole('button', { name: 'この内容で進める' })
    expect(proceed).toHaveProperty('disabled', false)
    fireEvent.click(proceed)
    expect(useEditStore.getState().history).toHaveLength(1)
  })

  it('系統ごとの表で、印は系統名と同じ行に入れず、系統名の下の行に置く(380px の幅で系統名が折れないように)', () => {
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('checkbox', { name: '2(R2)を入れ替えから外す' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const review = screen.getByRole('region', { name: '対象便の確かめ' })
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
    const summary = screen.getByRole('region', { name: '適用した方針' })
    expect(summary.textContent).toContain('運転士の一時的な欠員(欠員 2 名)')
    fireEvent.click(within(summary).getByRole('button', { name: '方針を変える' }))
    expect(screen.getByLabelText('開始日')).toHaveProperty('value', '2026-11-01')
    expect(screen.getByLabelText('理由のメモ')).toHaveProperty('value', '欠員 2 名')
    fireEvent.click(screen.getByRole('button', { name: '変えずに戻る' }))
    expect(screen.getByRole('region', { name: '適用した方針' })).toBeTruthy()
  })

  it('入力の有効期間の外の日付でも「対象便を確かめる」が止まらず、期間を入力の端にそろえる警告が届く(ブラウザ標準の範囲検証を使わない)', () => {
    render(<PolicyStep />)
    // 小さなフィードの有効期間は 2026-10-01〜2026-11-30
    const form = screen.getByRole('form', { name: '減便の方針' }) as HTMLFormElement
    expect(form.noValidate).toBe(true)
    fireEvent.change(screen.getByLabelText('開始日'), { target: { value: '2026-09-15' } })
    fireEvent.click(screen.getByLabelText('当面の間(終わりを決めない)'))
    fireEvent.change(screen.getByLabelText('終了日'), { target: { value: '2026-12-15' } })
    // 日付の入力欄の min・max は残る(カレンダーの選べる範囲の案内)。範囲外であることはブラウザも知っている
    const start = screen.getByLabelText('開始日') as HTMLInputElement
    expect(start.min).toBe('2026-10-01')
    expect(start.max).toBe('2026-11-30')
    expect(start.validity.rangeUnderflow).toBe(true)
    expect((screen.getByLabelText('終了日') as HTMLInputElement).validity.rangeOverflow).toBe(true)

    // 入力の途中でも、アプリ側の確かめ(checkPolicy)の警告が出る
    const check = screen.getByRole('region', { name: '方針の確かめ' })
    expect(check.querySelector('[data-code="periodStartClamped"]')?.textContent).toContain('入力の開始日(2026年10月1日)にそろえます')
    expect(check.querySelector('[data-code="periodEndClamped"]')?.textContent).toContain('入力の末日(2026年11月30日)にそろえます')

    // 押すと下書きができ、対象便の確かめに進む
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    expect(useEditStore.getState().draft?.kind).toBe('op')
    const review = screen.getByRole('region', { name: '対象便の確かめ' })
    expect(review.querySelector('[data-code="form2.periodStartClamped"]')).not.toBeNull()
    expect(review.querySelector('[data-code="form2.periodEndClamped"]')).not.toBeNull()
    expect(review.textContent).toContain('出力する GTFS の有効期間は 2026年10月1日〜2026年11月30日')
  })

  it('Claude の下書きがあるときに方針を確かめると、画面の中で捨ててよいかを先に確かめる(「やめる」なら何も変わらない)', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    const browserConfirm = vi.spyOn(window, 'confirm')
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('button', { name: '方針を変える' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const draftId = useEditStore.getState().draft!.id
    // ブラウザ標準の確認ダイアログは使わず、押したボタンの場所に確認が出る(ボタンは確認に置き換わる)
    const box = screen.getByRole('group', { name: 'Claude の下書きを捨てる確認' })
    expect(box.textContent).toContain(`Claude の下書き ${draftId} を捨てて、この操作をしますか。`)
    expect(screen.queryByRole('button', { name: '対象便を確かめる' })).toBeNull()
    expect(browserConfirm).not.toHaveBeenCalled()
    // まだ何も変えていない
    expect(useEditStore.getState().draft?.id).toBe(draftId)

    // 「やめる」なら Claude の下書きは残り、確認は消えて元のボタンに戻る
    fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
    expect(screen.queryByRole('group', { name: 'Claude の下書きを捨てる確認' })).toBeNull()
    expect(useEditStore.getState().draft?.id).toBe(draftId)
    const kept = useEditStore.getState().draft
    expect(kept?.kind === 'op' && kept.record.by).toBe('claude')
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '対象便の確かめ' })).toBeNull()

    // 「捨てて続ける」なら Claude の下書きを捨て、利用者の方針の下書きになる
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Claude の下書きを捨てる確認' })).getByRole('button', { name: '捨てて続ける' }))
    const draft = useEditStore.getState().draft
    expect(draft?.id).not.toBe(draftId)
    expect(draft?.kind === 'op' && draft.record.by).toBe('user')
    expect(draft?.kind === 'op' && draft.record.op.type).toBe('applyPolicy')
    expect(useEditStore.getState().draftNotices).toEqual([expect.objectContaining({ draftId, result: 'replaced' })])
    expect(screen.getByRole('region', { name: '対象便の確かめ' })).toBeTruthy()
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
      expect(box.textContent).toContain(`Claude の下書き ${draftId} も捨てます`)
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
      const box = history().getByRole('group', { name: 'Claude の下書きを捨てる確認' })
      expect(box.textContent).toContain(`Claude の下書き ${draftId} を捨てて、この操作をしますか。`)
      fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
      expect(useEditStore.getState().draft?.id).toBe(draftId)
      expect(useEditStore.getState().history).toHaveLength(2)

      fireEvent.click(history().getByRole('button', { name: '元に戻す' }))
      fireEvent.click(within(history().getByRole('group', { name: 'Claude の下書きを捨てる確認' })).getByRole('button', { name: '捨てて続ける' }))
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
      expect(history().getByRole('group', { name: 'Claude の下書きを捨てる確認' })).toBeTruthy()

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
      const box = history().getByRole('group', { name: 'Claude の下書きを捨てる確認' })
      expect(box.textContent).toContain(`Claude の下書き ${next} を捨てて、この操作をしますか。`)
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
