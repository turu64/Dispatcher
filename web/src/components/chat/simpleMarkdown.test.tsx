// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { splitTableRow } from './markdownTable'
import SimpleMarkdown from './simpleMarkdown'

afterEach(cleanup)

/** 返答の外枠の直下のかたまり(段落・見出し・箇条書き)を、種類と文字で並べる */
function blocks(text: string): string[] {
  const { container } = render(<SimpleMarkdown text={text} />)
  const root = container.firstElementChild!
  return [...root.children].map((el) => {
    if (el.tagName === 'UL') return `ul:${[...el.children].map((li) => li.textContent).join('|')}`
    const heading = el.className.includes('font-semibold')
    return `${heading ? 'h' : 'p'}:${el.textContent}`
  })
}

describe('AI の返答の簡単な整え(見出し)', () => {
  it('行頭の「# 」〜「#### 」は見出しの1行にし、記号は出さない', () => {
    expect(blocks('# 結果')).toEqual(['h:結果'])
    expect(blocks('#### 小見出し')).toEqual(['h:小見出し'])
  })

  it('「#」の後ろに空白が無い行や、行の途中の「#」は見出しにしない', () => {
    expect(blocks('#1 を承認してください')).toEqual(['p:#1 を承認してください'])
    expect(blocks('下書き #1 を作りました')).toEqual(['p:下書き #1 を作りました'])
    expect(blocks('##### 五つは見出しにしない')).toEqual(['p:##### 五つは見出しにしない'])
  })

  it('見出しの前の箇条書きと段落は、見出しの前で閉じる(別のかたまりにする)', () => {
    expect(blocks('前置き\n- 一つ目\n- 二つ目\n## まとめ\n本文')).toEqual(['p:前置き', 'ul:一つ目|二つ目', 'h:まとめ', 'p:本文'])
    expect(blocks('段落の文\n# 見出し')).toEqual(['p:段落の文', 'h:見出し'])
  })

  it('見出しの中の **太字** は解釈し、HTML は文字のまま出す', () => {
    const { container } = render(<SimpleMarkdown text={'# **大事**な<b>点</b>'} />)
    const heading = container.firstElementChild!.firstElementChild!
    expect(heading.textContent).toBe('大事な<b>点</b>')
    expect(heading.querySelector('strong')?.textContent).toBe('大事')
    expect(heading.querySelector('b')).toBeNull()
  })
})

describe('AI の返答の簡単な整え(表)', () => {
  it('「|」の行の次が区切りの行なら表にし、見出し・行・寄せ(:---:)と **太字** を解釈する', () => {
    const { container } = render(
      <SimpleMarkdown text={'候補です。\n\n| 系統 | 発車 | 理由 |\n|---|:---:|---:|\n| 31 | 7:40 | **高校** の始業 |\n| 21 | 7:10 |\n\nいかがですか。'} />,
    )
    const table = container.querySelector('table')!
    expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['系統', '発車', '理由'])
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
    // 足りないセルは空で埋める
    expect(rows).toEqual([
      ['31', '7:40', '高校 の始業'],
      ['21', '7:10', ''],
    ])
    expect(table.querySelector('tbody strong')?.textContent).toBe('高校')
    expect(table.querySelectorAll('th')[1].className).toContain('text-center')
    expect(table.querySelectorAll('th')[2].className).toContain('text-right')
    expect(container.textContent).toContain('候補です。')
    expect(container.textContent).toContain('いかがですか。')
    expect(container.textContent).not.toContain('|')
  })

  it('区切りの行が無い「|」の行や、列の数が合わない区切りは表にせず、文字のまま出す。セルの中の「\\|」は「|」', () => {
    const { container } = render(<SimpleMarkdown text={'| a | b |\n| c | d |'} />)
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toContain('| a | b |')
    const bad = render(<SimpleMarkdown text={'| a | b |\n|---|\n| c | d |'} />)
    expect(bad.container.querySelector('table')).toBeNull()
    expect(splitTableRow('| A \\| B | C |')).toEqual(['A | B', 'C'])
  })
})
