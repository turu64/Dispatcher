// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PairList } from './PairList'

// 組の内訳の、承認の前(版の report が無く、skipped・dropped・tripCounts を渡す)の表示

afterEach(cleanup)

const SETTINGS = {
  kind: 'weekdayToSaturday' as const,
  weekdayService: '01001',
  replacementService: '03001',
  pairs: [
    { weekday: '01001', replacements: ['03001'] },
    { weekday: '01001_C', replacements: ['03001_C'] },
    { weekday: '01001_D', replacements: ['03001_D'] },
    { weekday: '01005_MSN', replacements: [] },
  ],
  keptWeekdayServices: ['01002_RIT'],
}

const TRIPS = new Map([
  ['01001', 3],
  ['01001_C', 1],
  ['01001_D', 2],
  ['01005_MSN', 1],
])

describe('PairList(承認の前)', () => {
  it('期間に走らないため加えない入れ替えに使う service に取り消し線と注記を付け、便数は tripCounts の平日の便数を出す', () => {
    render(<PairList settings={SETTINGS} tripCounts={TRIPS} skipped={new Set(['03001_C'])} />)
    const list = screen.getByRole('list', { name: '組の内訳' })
    expect(list.textContent).toContain('平日 01001_C ←に入れる便: 土曜 03001_C(期間に走らないため加えません)(平日 1 便)')
    expect(within(list).getByText('03001_C').className).toContain('line-through')
    // ほかの入れ替えに使う service には付けない
    expect(within(list).getByText('03001').className).not.toContain('line-through')
    expect(list.textContent).toContain('平日 01001 ←に入れる便: 土曜 03001(平日 3 便)')
    expect(list.textContent?.match(/期間に走らないため加えません/g)).toHaveLength(1)
    expect(list.textContent).toContain('なくす(入れ替えに使うダイヤがない):01005_MSN(1 便)')
    expect(list.textContent).toContain('平日のまま残す:01002_RIT')
    expect(list.textContent).not.toContain('減便の期間に走らないため除いた組')
  })

  it('組ごと除く組(dropped)は入れ替える組に並べず、「除いた組」に出す', () => {
    render(<PairList settings={SETTINGS} tripCounts={TRIPS} dropped={new Set(['01001_D'])} skipped={new Set(['03001_C'])} />)
    const list = screen.getByRole('list', { name: '組の内訳' })
    expect(list.textContent).not.toContain('平日 01001_D')
    expect(list.textContent).toContain('減便の期間に走らないため除いた組:01001_D')
    expect(list.textContent).toContain('03001_C(期間に走らないため加えません)')
  })
})
