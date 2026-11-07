// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { EditOp, Form2Plan } from '@/gtfs/edit/ops'
import { diffOf, lastVersion, useEditStore } from '@/store/edit'
import type { ResearchResult } from '@/claude/research'
import type { OtherStop } from '@/ref/busstops'
import { useHolidayStore } from '@/store/holidays'
import { useResearchStore } from '@/store/research'
import { FACILITY_SOURCES } from '@/components/dataSourceRows'
import NoticeDraft, { OTHER_OPERATOR_DATA_YEAR } from './NoticeDraft'

// 到達圏の計算は、この画面では走らせない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

const SAMPLE = { available: true, name: '道北バス', source: '北海道オープンデータプラットフォーム(gtfs-data)', license: 'CC BY 4.0' }

function policy(
  reason: { category: 'temporaryShortage' | null; note: string } = { category: 'temporaryShortage', note: '病欠のため' },
  overrides: Partial<Form2Plan> = {},
): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan(overrides)
  return { type: 'applyPolicy', settings, reason }
}

function approve(...ops: EditOp[]) {
  act(() => {
    for (const op of ops) {
      useEditStore.getState().propose(op, 'user')
      useEditStore.getState().commit()
    }
  })
}

beforeEach(() => {
  useHolidayStore.setState({ holidays: { status: 'missing' } })
  window.print = vi.fn()
  act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: SAMPLE }))
})

afterEach(() => {
  cleanup()
  act(() => useResearchStore.getState().reset())
  act(() => useEditStore.getState().setBase(null))
  vi.restoreAllMocks()
})

function pick(name: RegExp) {
  fireEvent.click(within(screen.getByRole('list', { name: '停留所の選択' })).getByRole('button', { name }))
}

describe('NoticeDraft', () => {
  it('方針を承認するまでは案内だけを出す', () => {
    render(<NoticeDraft />)
    expect(screen.getByText(/減便の方針を承認すると、停留所ごとの掲示と告知文の文案を出します/)).toBeTruthy()
    expect(document.querySelector('.print-area')).toBeNull()
  })

  it('停留所を選ぶと、期間中の系統ごとの発車時刻と、運休する時刻を掲示に出す', () => {
    approve(policy())
    render(<NoticeDraft />)
    // 期間の中で平日ダイヤが走る最初の日(20261101 は日曜、20261102 は月曜)
    expect(screen.getByText(/2026年11月2日\(月\)/)).toBeTruthy()
    expect(screen.getByText('停留所を選ぶと、その停留所の掲示を1枚ずつ表示して印刷できます。')).toBeTruthy()
    pick(/駅前/)

    const sheet = screen.getByRole('article', { name: '駅前の掲示' })
    expect(within(sheet).getByText(/駅前 のバスの時刻が変わります/)).toBeTruthy()
    const lines = within(sheet).getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(lines.some((t) => t.includes('系統 1') && t.includes('07:00') && t.includes('08:05'))).toBe(true)
    expect(lines.some((t) => t.includes('系統 2') && t.includes('10:00'))).toBe(true)
    // 運休する時刻
    expect(within(sheet).getByText(/運休する時刻/)).toBeTruthy()
    expect(within(sheet).getAllByText(/07:30/).length).toBeGreaterThan(0)
  })

  it('発車が無くなる停留所は「発車はありません」と、近くの停留所が無いことを出す', () => {
    approve(policy())
    render(<NoticeDraft />)
    pick(/学校前/)
    const sheet = screen.getByRole('article', { name: '学校前の掲示' })
    expect(within(sheet).getByTestId('no-departure').textContent).toContain('発車はありません')
    expect(within(sheet).getByTestId('alternatives').textContent).toContain('半径300m以内に、期間中も発車がある別の停留所はありません')
    // 自由記入は掲示に載る
    fireEvent.change(screen.getByLabelText(/代わりに使える交通の自由記入/), { target: { value: '他社の路線バス 3番乗り場' } })
    expect(within(sheet).getByText('他社の路線バス 3番乗り場')).toBeTruthy()
  })

  it('足し戻した(学)の便には印を付ける', () => {
    approve(policy(), { type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: true }] })
    render(<NoticeDraft />)
    // 足し戻した便は時刻が変わらないので、既定の「差し替える停留所だけ」には出ない。外すと選べる
    expect(within(screen.getByRole('list', { name: '停留所の選択' })).queryByRole('button', { name: /学校前/ })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '掲示を差し替える停留所だけ' }))
    pick(/学校前/)
    const sheet = screen.getByRole('article', { name: '学校前の掲示' })
    expect(within(sheet).getByTestId('segment-single').textContent).toContain('07:40')
    expect(within(sheet).getByTestId('segment-single').textContent).toContain('(学)')
    expect(within(sheet).getByText('(学)の印の便は、学校の休業日は運休します。')).toBeTruthy()
  })

  it('印刷できる 1 枚だけを出し、印刷ボタンで window.print を呼ぶ', () => {
    approve(policy())
    render(<NoticeDraft />)
    pick(/駅前/)
    expect(document.querySelectorAll('.print-area')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'この掲示を印刷する' }))
    expect(window.print).toHaveBeenCalledTimes(1)

    // 別の停留所を選んでも 1 枚
    pick(/学校前/)
    expect(document.querySelectorAll('.print-area')).toHaveLength(1)
    expect(screen.getByRole('article', { name: '学校前の掲示' })).toBeTruthy()

    // 告知文に切り替えても 1 枚
    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    expect(document.querySelectorAll('.print-area')).toHaveLength(1)
    expect(screen.getByRole('article', { name: '告知文' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'この告知文を印刷する' }))
    expect(window.print).toHaveBeenCalledTimes(2)
  })

  it('印刷では掲示の枠と余白を外し、系統ごとの時刻・運休する時刻・近くの停留所の行の途中で紙を分けない', () => {
    approve(policy())
    render(<NoticeDraft />)
    pick(/駅前/)
    const sheet = screen.getByRole('article', { name: '駅前の掲示' })
    for (const c of ['print:border-0', 'print:p-0', 'print:rounded-none']) expect(sheet.className).toContain(c)
    const items = sheet.querySelectorAll('li')
    expect(items.length).toBeGreaterThan(0)
    for (const li of items) expect(li.className).toContain('break-inside-avoid')
    for (const h of sheet.querySelectorAll('h4')) expect(h.className).toContain('break-after-avoid')
    expect(within(sheet).getByTestId('alternatives').className).toContain('print:text-xs')
    // 2枚以上に続くことの断りは、紙には載せない
    expect(screen.getByTestId('sheet-pages-note').closest('.print-hide')).not.toBeNull()
  })

  it('告知文は第17条の5項目と、法定の様式ではない旨の注記を出す', () => {
    approve(policy())
    render(<NoticeDraft />)
    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    const sheet = screen.getByRole('article', { name: '告知文' })
    for (const n of [1, 2, 3, 4, 5]) expect(within(sheet).getByTestId(`announce-item-${n}`)).toBeTruthy()
    expect(within(sheet).getByTestId('announce-item-1').textContent).toContain('2026年11月1日から')
    expect(within(sheet).getByTestId('announce-item-2').textContent).toContain('運転士の一時的な欠員(病欠のため)')
    expect(within(sheet).getByTestId('announce-item-3').textContent).toContain('当面の間')
    expect(within(sheet).getByText(/法定の様式ではありません/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('場所(対象の地域・路線)'), { target: { value: '市内の全路線' } })
    fireEvent.change(screen.getByLabelText(/代わりに使える運行系統・他の運送事業/), { target: { value: '市内循環バス(他社)' } })
    expect(within(sheet).getByTestId('announce-item-1').textContent).toContain('市内の全路線')
    expect(within(sheet).getByTestId('announce-item-5').textContent).toBe('5. 代わりに使える運行系統・他の運送事業市内循環バス(他社)')
  })

  it('告知文の1項目めは利用者向けの見出しで印刷し、第17条の項目名(事故の日時・場所)は画面だけに出す', () => {
    approve(policy())
    render(<NoticeDraft />)
    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    const item = within(screen.getByRole('article', { name: '告知文' })).getByTestId('announce-item-1')
    expect(item.textContent).toContain('1. 変更の日時・場所')
    // 「事故」は印刷しない注記(print-hide)の中にだけある
    const legal = within(item).getByText(/事故の日時・場所/)
    expect(legal.closest('.print-hide')).not.toBeNull()
    const printed = item.cloneNode(true) as HTMLElement
    for (const el of printed.querySelectorAll('.print-hide')) el.remove()
    expect(printed.textContent).not.toContain('事故')
  })

  it('告知文の概要は、正味の便数の差と、消える便・入る便の内訳を分けて書く', () => {
    approve(policy())
    render(<NoticeDraft />)
    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    const state = useEditStore.getState()
    const version = lastVersion(state)
    if (!state.base || !version) throw new Error('承認済みの版がありません')
    const d = diffOf(state.base.feed, version)
    const before = d.removed.length + d.same.length
    const after = d.same.length + d.added.length
    // このフィードでは平日の便が消えも入りもする(入れ替え)
    expect(d.removed.length).toBeGreaterThan(0)
    expect(d.added.length).toBeGreaterThan(0)
    const text = within(screen.getByRole('article', { name: '告知文' })).getByTestId('announce-item-2').textContent ?? ''
    expect(text).toContain(`${before} 便から ${after} 便(`)
    expect(text).toContain(`平日ダイヤの時刻の ${d.removed.length} 便は運休し、土曜ダイヤの時刻の ${d.added.length} 便を運行します`)
    expect(text).not.toContain('便が運休となります')
  })

  it('方針で除外した系統は、掲示と告知文で平日ダイヤのまま運行すると書く', () => {
    // 学校線(R3)を除外:学校前は R3 だけが止まり、駅前は R1・R2・R3 が止まる
    approve(policy(undefined, { excludedRoutes: ['R3'] }))
    render(<NoticeDraft />)
    pick(/駅前/)
    const station = screen.getByRole('article', { name: '駅前の掲示' })
    expect(within(station).getByText(/駅前 のバスの時刻が変わります/)).toBeTruthy()
    expect(within(station).getByTestId('sheet-lead').textContent).toContain('ただし、系統 3は平日ダイヤのまま運行します。')
    expect(within(station).getByTestId('sheet-repost').textContent).toContain('減便前の時刻の掲示と差し替えてください')

    // 学校前は時刻が変わらないので「差し替える停留所だけ」を外して選ぶ
    fireEvent.click(screen.getByRole('checkbox', { name: '掲示を差し替える停留所だけ' }))
    pick(/学校前/)
    const school = screen.getByRole('article', { name: '学校前の掲示' })
    expect(within(school).getByText(/学校前 のバスの時刻は変わりません/)).toBeTruthy()
    expect(within(school).queryByText(/時刻が変わります/)).toBeNull()
    expect(within(school).getByTestId('sheet-lead').textContent).toContain('系統 3')
    expect(within(school).getByTestId('sheet-lead').textContent).toContain('平日ダイヤのまま運行します')
    expect(within(school).getByTestId('sheet-lead').textContent).not.toContain('土曜ダイヤの時刻で運行します')
    expect(within(school).getByTestId('sheet-repost').textContent).toContain('差し替えは不要です')

    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    expect(within(screen.getByRole('article', { name: '告知文' })).getByTestId('announce-item-4').textContent).toContain(
      '次の系統は平日ダイヤのまま運行します:3。',
    )
  })

  it('公示日から実施日まで7日を切ると、警告を出し、理由を掲示に入れる', () => {
    approve(policy())
    render(<NoticeDraft />)
    pick(/駅前/)
    const sheet = screen.getByRole('article', { name: '駅前の掲示' })
    // 公示日が空のうちは警告しない
    expect(screen.queryByText(/公示から実施まで7日を切っています/)).toBeNull()
    expect(within(sheet).getByTestId('sheet-effective').textContent).toContain('2026年11月1日')

    fireEvent.change(screen.getByLabelText('公示日'), { target: { value: '2026-10-28' } })
    expect(screen.getByText(/公示から実施まで7日を切っています/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/7日を切るときの理由/), { target: { value: '急な欠員のため' } })
    expect(within(sheet).getByTestId('sheet-late-reason').textContent).toBe('急な欠員のため')
    expect(within(sheet).getByTestId('sheet-announce').textContent).toContain('2026年10月28日')

    // 7日以上前なら警告は消える
    fireEvent.change(screen.getByLabelText('公示日'), { target: { value: '2026-10-20' } })
    expect(screen.queryByText(/公示から実施まで7日を切っています/)).toBeNull()
  })

  it('承認待ちの下書きがあるときは、承認済みの内容で作っていることを知らせる', () => {
    approve(policy())
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<NoticeDraft />)
    expect(screen.getByText(/^承認待ちの下書き #\d+ があります。周知文は承認済みの内容で作っています。$/)).toBeTruthy()
    pick(/学校前/)
    expect(screen.getByTestId('no-departure')).toBeTruthy()
  })
  describe('近くの他の事業者の停留所と、調べた減便の動き', () => {
    // smallFeed の駅前(A)は 43.76, 142.36。緯度 0.0011 度が約 122 m
    const STOPS: OtherStop[] = [
      { name: '駅前北', lat: 43.7611, lon: 142.36, operators: ['P11:宗谷バス'], routes: ['稚内線', '名寄線'] },
      { name: '駅前通', lat: 43.7604, lon: 142.36, operators: ['P11:旭川電気軌道'], routes: [] },
      { name: '遠い所', lat: 43.766, lon: 142.36, operators: ['P11:北見バス'], routes: ['遠方線'] },
      { name: '自社の停留所', lat: 43.7601, lon: 142.36, operators: ['P11:テストバス'], routes: ['1'] },
    ]

    function loadStops(busstops: OtherStop[] | null) {
      act(() => {
        useResearchStore.setState({ facilities: { status: 'ready', key: 'k', facilities: [], sources: [], busstops } })
      })
    }

    function researchResult(over: Partial<ResearchResult> = {}): ResearchResult {
      return {
        targetId: 'P11:宗谷バス',
        kind: 'operator',
        name: '宗谷バス',
        status: 'found',
        facts: [
          { label: '減便の発表', value: '11月1日から平日ダイヤを土曜ダイヤにする', source: 1 },
          { label: '会社の所在地', value: '稚内市', source: 1 },
        ],
        sources: [{ url: 'https://example.jp/news', title: '運行のお知らせ' }],
        note: '',
        checkedAt: new Date().toISOString(),
        origin: 'web',
        ...over,
      }
    }

    it('300 m 以内の他の事業者の停留所と系統を出し、時刻は時刻表で確かめるよう添える。自社と遠い停留所は出さない', () => {
      approve(policy())
      loadStops(STOPS)
      render(<NoticeDraft />)
      pick(/駅前/)
      const sheet = screen.getByRole('article', { name: '駅前の掲示' })
      const block = within(sheet).getByTestId('other-operators')
      expect(block.textContent).toContain('半径300m以内の、ほかの事業者の停留所')
      const soya = within(block).getByTestId('other-operator-P11:宗谷バス')
      expect(soya.textContent).toContain('駅前北(約120m)')
      expect(soya.textContent).toContain('系統:名寄線、稚内線')
      expect(within(block).getByTestId('other-operator-P11:旭川電気軌道').textContent).toContain('系統:系統名の記載なし')
      expect(within(block).queryByTestId('other-operator-P11:北見バス')).toBeNull()
      expect(within(block).queryByTestId('other-operator-P11:テストバス')).toBeNull()
      expect(block.textContent).toContain('時刻は各事業者の時刻表で確かめてください。')
      // 国土数値情報の停留所には時刻が無いことの断り(画面)と、印刷にも載る出典
      expect(block.textContent).toContain('国土数値情報の停留所には時刻がないため、本数や時間帯は分かりません')
      // データの年度と、廃止・変更されていることがある断りは、印刷する掲示にも載る(print-hide の中に置かない)
      const stale = within(block).getByTestId('other-operators-stale')
      expect(stale.textContent).toBe('ほかの事業者の停留所と系統は、2022年度の国土数値情報によるもので、廃止・変更されていることがあります。')
      expect(stale.closest('.print-hide')).toBeNull()
      const printed = within(block).getByTestId('other-operators-print-source')
      expect(printed.textContent).toBe('出典:国土数値情報(バス停留所データ、2022年度)を加工して作成')
      expect(printed.closest('.print-hide')).toBeNull()
      expect(printed.className).toContain('print:block')
    })

    it('掲示に書く他の事業者の停留所の年度は、データの出典の欄(P11 の行)の年度と同じ', () => {
      const p11 = FACILITY_SOURCES.find((r) => r.data.includes('P11'))
      expect(p11?.data).toContain(OTHER_OPERATOR_DATA_YEAR)
    })

    it('調べた減便の動きがある事業者には、事実・出典・確認日時を引用として出す。ほかの事実は載せない', () => {
      approve(policy())
      loadStops(STOPS)
      act(() => useResearchStore.getState().mergeResults([researchResult()]))
      render(<NoticeDraft />)
      pick(/駅前/)
      const quote = within(screen.getByRole('article', { name: '駅前の掲示' })).getByTestId('movement-quote-P11:宗谷バス')
      expect(quote.textContent).toContain('減便の発表:11月1日から平日ダイヤを土曜ダイヤにする')
      expect(quote.textContent).not.toContain('会社の所在地')
      expect(quote.textContent).toContain('確認日時')
      expect(quote.textContent).toContain('Web で調べた結果')
      const link = within(quote).getByRole('link')
      expect(link.getAttribute('href')).toBe('https://example.jp/news')
      expect(quote.textContent).toContain('運行のお知らせ')
      expect(quote.textContent).not.toContain('日より前の確認です')
      // 調べていない事業者(旭川電気軌道)の引用は出ない
      expect(screen.queryByTestId('movement-quote-P11:旭川電気軌道')).toBeNull()
    })

    it('確認日時が 30 日より前なら、出典で確かめるよう添える', () => {
      approve(policy())
      loadStops(STOPS)
      act(() => useResearchStore.getState().mergeResults([researchResult({ checkedAt: '2020-01-01T00:00:00+09:00' })]))
      render(<NoticeDraft />)
      pick(/駅前/)
      const quote = screen.getByTestId('movement-quote-P11:宗谷バス')
      expect(quote.textContent).toContain('30日より前の確認です。出典で確かめてください。')
      expect(quote.textContent).toContain('2020年1月1日')
    })

    it('範囲内に停留所が無いときはそう書く。参照データを読み込んでいないときは画面だけに断りを出す', () => {
      approve(policy())
      loadStops([{ name: '遠い所', lat: 43.8, lon: 142.4, operators: ['P11:北見バス'], routes: [] }])
      const { unmount } = render(<NoticeDraft />)
      pick(/駅前/)
      expect(screen.getByTestId('other-operators').textContent).toContain('ほかの事業者の停留所はありません')
      unmount()

      act(() => useResearchStore.getState().reset())
      render(<NoticeDraft />)
      pick(/駅前/)
      const note = screen.getByTestId('other-operators-missing')
      expect(note.textContent).toContain('参照データを読み込むと表示します(読み込めないときは、手順「平日便を戻す」の「判断材料を調べる」で読み込み直せます)')
      expect(note.className).toContain('print-hide')
      expect(screen.queryByTestId('other-operators')).toBeNull()
    })
  })
})
