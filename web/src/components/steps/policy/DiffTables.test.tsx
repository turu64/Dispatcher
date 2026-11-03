// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RouteDiff, TripBrief, WeekdayDiff } from '@/gtfs/edit/diff'
import type { Form2Result } from '@/gtfs/edit/form2'
import { DiffCounts, ExcludedRoutes, Notice47Table, RouteDiffList } from './DiffTables'

afterEach(cleanup)

function route(routeId: string, name: string, before: number, after: number, extra: Partial<RouteDiff> = {}): RouteDiff {
  return {
    routeId,
    routeName: name,
    before,
    after,
    removed: Math.max(before - after, 0),
    added: 0,
    same: Math.min(before, after),
    excluded: false,
    firstDepartureBefore: null,
    firstDepartureAfter: null,
    lastDepartureBefore: null,
    lastDepartureAfter: null,
    vanishes: after === 0,
    ...extra,
  }
}

function trip(tripId: string, routeId: string, feed: 'base' | 'edited'): TripBrief {
  return {
    feed,
    tripId,
    routeId,
    routeName: routeId,
    headsign: '',
    firstStopName: 'A',
    lastStopName: 'B',
    stopNames: ['A', 'B'],
    firstDeparture: '08:00',
    lastArrival: '08:30',
    firstSeconds: 8 * 3600,
  } as TripBrief
}

// 系統 R1(11 → 4 回: 第46号の下限を下回る)、R2(平日だけの系統で 5 → 0: 全曜日で便なし)、R3(6 → 6)。
// 並びは route_id の順なので、全曜日で便なしの R2 は途中にいる
const diff: WeekdayDiff = {
  removed: [trip('a', 'R1', 'base'), trip('b', 'R1', 'base'), trip('c', 'R2', 'base')],
  added: [trip('x', 'R3', 'edited')],
  same: [trip('s', 'R3', 'edited'), trip('t', 'R3', 'edited')],
  byRoute: [route('R1', '1番', 11, 4), route('R2', '2番', 5, 0), route('R3', '3番', 6, 6)],
  byStartBand: [],
  byNotice47Band: [
    { routeId: 'R1', routeName: '1番', band: '6〜9時台', before: 3, after: 0 },
    { routeId: 'R1', routeName: '1番', band: '10〜14時台', before: 8, after: 4 },
  ],
  vanishingRoutes: 1,
}

const result = {
  plan: { kind: 'saturday' },
  report: {
    addBack: { requested: 0, accepted: [], duplicate: [], notFound: [], notWeekday: [], ignoredExcludedRoute: [], ignoredAlreadyPresent: [] },
  },
} as unknown as Form2Result

describe('DiffCounts(平日の便数の前後と内訳)', () => {
  it('先頭に平日の便数の前 → 後を出し、消える・入る・残るの便数を並べる', () => {
    render(<DiffCounts diff={diff} result={result} />)
    const group = screen.getByLabelText('平日便の件数')
    const text = group.textContent ?? ''
    // 11 + 5 + 6 = 22 便が 4 + 0 + 6 = 10 便に
    expect(text).toContain('平日の便数(減便前 → 減便後)')
    expect(within(group).getByText('22')).toBeTruthy()
    expect(within(group).getByText('10')).toBeTruthy()
    expect(text).toContain('なくなる便 3 便・加わる便 1 便・同じ便 2 便')
    // 大きな数字の前後に、減った数が出る
    expect(text).toContain('−12 便(55%)')
    // 前後の棒は、スクリーンリーダー向けに数字で説明する
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('減便前 22 便(同じ便 2・なくなる便 3)、減便後 10 便(同じ便 2・加わる便 1)')
    // 先頭は便数の枠(注意の枠より前)
    const hero = text.indexOf('平日の便数(減便前 → 減便後)')
    expect(hero).toBeGreaterThanOrEqual(0)
    expect(hero).toBeLessThan(text.indexOf('全曜日で便がなくなる系統が'))
  })

  it('全曜日で便がなくなる系統を、名前つきの強調の枠で出す(無ければ枠を出さない)', () => {
    const { container, rerender } = render(<DiffCounts diff={diff} result={result} />)
    const banner = container.querySelector('[data-vanishing-banner="true"]')!
    expect(banner.textContent).toContain('全曜日で便がなくなる系統が 1 系統あります')
    expect(banner.textContent).toContain('2番(平日 5 便 → 0 便)')
    expect(banner.textContent).toContain('運輸支局に確認してください')
    // 一覧の行は今までどおり「全曜日で便がなくなる系統:N 系統」の形でも出す
    expect(screen.getByLabelText('平日便の件数').textContent).toContain('全曜日で便がなくなる系統:1 系統')

    const calm: WeekdayDiff = { ...diff, byRoute: [route('R1', '1番', 11, 4)], vanishingRoutes: 0 }
    rerender(<DiffCounts diff={calm} result={result} />)
    expect(container.querySelector('[data-vanishing-banner]')).toBeNull()
    expect(screen.getByLabelText('平日便の件数').textContent).toContain('全曜日で便がなくなる系統:0 系統')
  })

  it('棒の見えるラベルも「減便前」「減便後」で書く', () => {
    const { container } = render(<DiffCounts diff={diff} result={result} />)
    const bars = container.querySelector('[role="img"]')!
    expect(bars.textContent).toBe('減便前減便後')
  })

  it('平日に戻す便があれば、受け付けた便数と、受け付けなかった便の理由の場所を出す', () => {
    const withAddBack = {
      plan: { kind: 'saturday' },
      report: {
        addBack: { requested: 3, accepted: ['a', 'b'], duplicate: ['c'], notFound: [], notWeekday: [], ignoredExcludedRoute: [], ignoredAlreadyPresent: [] },
      },
    } as unknown as Form2Result
    render(<DiffCounts diff={diff} result={withAddBack} />)
    const text = screen.getByLabelText('平日便の件数').textContent ?? ''
    expect(text).toContain('平日に戻す便:選んだ 3 便のうち、受け付け 2 便、受け付けなかった便 1 便(理由は手順「平日便を戻す」に出ています)')
  })

  it('便数が変わらないとき、減った数を出さない', () => {
    const same: WeekdayDiff = { ...diff, removed: [], added: [], byRoute: [route('R3', '3番', 6, 6)], vanishingRoutes: 0 }
    render(<DiffCounts diff={same} result={result} />)
    expect(screen.getByLabelText('平日便の件数').textContent).not.toContain('▼')
  })
})

describe('RouteDiffList(系統ごと)', () => {
  it('全曜日で便がなくなる系統を先頭に並べ、強調する', () => {
    const { container } = render(<RouteDiffList diff={diff} />)
    const rows = Array.from(container.querySelectorAll<HTMLElement>('li[data-route]'))
    expect(rows.map((r) => r.dataset.route)).toEqual(['R2', 'R1', 'R3'])
    expect(rows[0].className).toContain('bg-destructive')
    expect(rows[1].className).not.toContain('bg-destructive')
    expect(rows[0].textContent).toContain('全曜日で便なし')
    expect(container.querySelector('summary')!.textContent).toContain('全曜日で便なし 1')
  })
})

describe('RouteDiffList の便の一覧', () => {
  it('なくなる便・加わる便に、減便前か減便後かを添え、入れ替えに使うダイヤの注意を出す', () => {
    const { container } = render(<RouteDiffList diff={diff} />)
    const r3 = container.querySelector('li[data-route="R3"]')!
    expect(r3.textContent).toContain('加わる便(1 便)')
    expect(r3.textContent).toContain('x(減便後)')
    expect(r3.textContent).toContain('入れ替えに使うダイヤに、季節によって走らなくなった便が残っていることがあります。加わる便の系統と時刻を確かめてください。')
    const r1 = container.querySelector('li[data-route="R1"]')!
    expect(r1.textContent).toContain('なくなる便(2 便)')
    expect(r1.textContent).toContain('a(減便前)')
  })
})

describe('ExcludedRoutes(入れ替えから外す系統)', () => {
  it('入れ替えに使うダイヤの便がない系統の注意と、外した系統の説明を出す', () => {
    const stats = [
      { routeId: 'R2', name: '2番', weekday: 5, replacement: 0 },
      { routeId: 'R1', name: '1番', weekday: 11, replacement: 4 },
    ]
    const { container } = render(<ExcludedRoutes stats={stats} excluded={[]} onChange={() => {}} replacementLabel="土曜" />)
    const text = container.textContent ?? ''
    expect(text).toContain('土曜の便がない系統(1 系統。表の先頭)は、入れ替えると全曜日で便がなくなります。路線の休止の届出に当たるかを運輸支局に確認してください。')
    expect(text).toContain('外した系統は平日の便をそのまま残し、土曜の便は加わりません。')
  })
})

describe('Notice47Table(届出の目安:時間帯ごとの便数)', () => {
  it('見出しを言い換え、公示第47号の区分であることを添える', () => {
    const { container } = render(<Notice47Table diff={diff} />)
    const summary = container.querySelector('summary')!
    expect(summary.textContent).toContain('届出の目安:時間帯ごとの便数(北海道運輸局 公示第47号の区分)')
    // 折りたたんでいても、気づけるように件数を添える
    expect(summary.textContent).toContain('0 回になる系統 × 帯 1')
    expect(summary.textContent).toContain('第46号の下限を下回る系統 1')
  })

  it('第46号の下限の印(▼)の意味と、運輸支局への確認を 1 つの短い文で説明する', () => {
    const { container } = render(<Notice47Table diff={diff} />)
    const note = container.querySelector('details > p')!
    expect(note.textContent).toContain('「▼」は、平日の回数が 11〜15 回の系統が 10 回以下になり、公示第46号の表の下限を下回ることを示す')
    expect(note.textContent).toContain('届出の区分は運輸支局に確認してください')
    // 長い説明にしない(1〜2 行)
    expect((note.textContent ?? '').length).toBeLessThan(120)
  })

  it('既定で折りたたんでいる(開くと表が見える)', () => {
    const { container } = render(<Notice47Table diff={diff} />)
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    details.open = true
    expect(details.open).toBe(true)
    expect(container.querySelector('table')).toBeTruthy()
  })
})
