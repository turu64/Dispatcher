import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { makeBands } from '@/gtfs/departures'
import { cloneParams } from '@/reach/input'
import { DEFAULT_REACH_PARAMS, type ReachResult } from '@/reach/reach'
import { summarizeReach } from '@/reach/summary'
import type { ReachSnapshot, RefState } from '@/store/reach'
import { ReachConditions, ReachNotes, ReachSummaryTable, RefStatus } from './ReachStep'

// react-dom/server で描画する(useEffect は走らない)。store を使わない表示の部品に、値を直接渡して確かめる

function snapshotOf(result: ReachResult, extra: Partial<ReachSnapshot['departures']> = {}): ReachSnapshot {
  const bands = makeBands(3)
  return {
    date: '20261104',
    stepHours: 3,
    bands,
    departures: {
      counts: new Map([['A', [1, 0, 0, 0, 0, 0]]]),
      skippedBlankTime: 0,
      skippedInvalidTime: 0,
      hasFrequencies: false,
      ...extra,
    },
    result,
    summary: summarizeReach(result),
    params: cloneParams(DEFAULT_REACH_PARAMS),
  }
}

const RESULT: ReachResult = {
  cells: ['65420000111', '65420000112', '65420000113', '65420000114'],
  classes: ['urban', 'suburban', 'rural', 'rural'],
  reachable: [
    [true, true, true, false],
    [true, false, true, false],
    [true, true, true, true],
    [false, false, false, false],
    [true, true, true, true],
    [false, false, false, false],
  ],
  usedFallback: false,
  excludedStops: 0,
  cellPopulation: [100, 50, 30, 20],
}

/** タグを除いた文字だけ(React が入れる <!-- --> も除く) */
function textOf(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/\|+/g, '|')
}

describe('ReachSummaryTable', () => {
  it('時間帯ごとの外れるセルと推計人口、その割合を出す', () => {
    const text = textOf(renderToString(<ReachSummaryTable snapshot={snapshotOf({ ...RESULT, excludedStops: 2 })} selectedHour={9} invalidStops={1} />))
    expect(text).toContain('2026年11月4日(水)、3時間ごと')
    expect(text).toContain('都市部 1・郊外 1・中山間・地方 2')
    expect(text).toContain('推計人口 200 人')
    expect(text).toContain('除いた停留所 3 件')
    expect(text).toContain('|6〜9時|1|(25.0%)|20人|(10.0%)|')
    expect(text).toContain('|9〜12時|2|(50.0%)|70人|(35.0%)|')
    expect(text).toContain('|15〜18時|4|(100.0%)|200人|(100.0%)|')
  })

  it('地図に出している時間帯の行を強調する', () => {
    const html = renderToString(<ReachSummaryTable snapshot={snapshotOf(RESULT)} selectedHour={10} invalidStops={0} />)
    const selected = html.match(/<tr[^>]*data-selected="true"[^>]*>.*?<\/tr>/)?.[0] ?? ''
    expect(textOf(selected)).toContain('9〜12時')
    expect(html.match(/data-selected="true"/g)).toHaveLength(1)
    expect(html).toContain('aria-current="true"')
  })

  it('参照データが無い(fallback)ときは、推計人口の列を出さない', () => {
    const fallback = { ...RESULT, usedFallback: true, cellPopulation: [0, 0, 0, 0] }
    const text = textOf(renderToString(<ReachSummaryTable snapshot={snapshotOf(fallback)} selectedHour={6} invalidStops={0} />))
    expect(text).not.toContain('推計人口 ')
    expect(text).toContain('|6〜9時|1|(25.0%)|')
    expect(text).not.toContain('人|(')
  })
})

describe('ReachNotes', () => {
  it('除いた停留所、空・読めない departure_time、frequencies.txt を知らせる', () => {
    const html = renderToString(
      <ReachNotes
        snapshot={snapshotOf({ ...RESULT, excludedStops: 2 }, { skippedBlankTime: 3, skippedInvalidTime: 4, hasFrequencies: true })}
        invalidStops={1}
      />,
    )
    const text = textOf(html)
    expect(text).toContain('緯度経度が読めない停留所 1 件を除きました')
    expect(text).toContain('地域メッシュの範囲外((0, 0) など)の停留所 2 件を除きました')
    expect(text).toContain('departure_time が空の行 3 件')
    expect(text).toContain('departure_time が時刻として読めない行 4 件')
    expect(text).toContain('frequencies.txt があります')
  })

  it('知らせることが無ければ何も出さない', () => {
    expect(renderToString(<ReachNotes snapshot={snapshotOf(RESULT)} invalidStops={0} />)).toBe('')
  })

  it('出発がある停留所が無い日はそう出す', () => {
    const snapshot = snapshotOf(RESULT)
    snapshot.departures.counts = new Map()
    expect(textOf(renderToString(<ReachNotes snapshot={snapshot} invalidStops={0} />))).toContain('出発がある停留所はありません')
  })
})

describe('RefStatus', () => {
  const noop = () => {}

  it('読み込み中', () => {
    const s: RefState = { status: 'loading', key: '6542', mesh1s: ['6542'] }
    expect(renderToString(<RefStatus refState={s} fallbackClass="suburban" onRetry={noop} onFallbackChange={noop} />)).toContain('読み込み中')
  })

  it('読めたら、1次メッシュと駅の数を出し、区分の選択は出さない', () => {
    const s: RefState = {
      status: 'done',
      key: '6542,6543',
      result: {
        ok: true,
        mesh1s: ['6542', '6543'],
        ref: { pop250: new Map(), did125: new Set(), stations: [] },
        stations: [{ name: '旭川', line: '函館線', lat: 43.76, lon: 142.36 }],
        sources: [],
      },
    }
    const text = textOf(renderToString(<RefStatus refState={s} fallbackClass="suburban" onRetry={noop} onFallbackChange={noop} />))
    expect(text).toContain('1次メッシュ 6542・6543(2 件)、鉄道駅 1 駅')
    expect(text).not.toContain('参照データが無いときの区分')
  })

  it('読めなければ、足りない1次メッシュの注意と、区分の選択・読み直しのボタンを出す', () => {
    const s: RefState = {
      status: 'done',
      key: '6541,6542',
      result: { ok: false, mesh1s: ['6541', '6542'], missing: ['6541'], message: '1次メッシュ 6541 の参照データを読み込めませんでした(サーバーにファイルがありません)。' },
    }
    const html = renderToString(<RefStatus refState={s} fallbackClass="rural" onRetry={noop} onFallbackChange={noop} />)
    const text = textOf(html)
    expect(text).toContain('1次メッシュ 6541 の参照データを読み込めませんでした')
    expect(text).toContain('鉄道駅は無いものとして計算しています')
    expect(text).toContain('参照データが無いときの区分')
    expect(text).toContain('都市部')
    expect(text).toContain('中山間・地方')
    expect(text).toContain('参照データを読み込み直す')
    // 選んでいる区分(中山間・地方)が押された状態
    expect(html).toMatch(/aria-checked="true"[^>]*>中山間・地方</)
  })

  it('まだ何もしていなければ何も出さない', () => {
    expect(renderToString(<RefStatus refState={{ status: 'idle' }} fallbackClass="suburban" onRetry={noop} onFallbackChange={noop} />)).toBe('')
  })
})

describe('ReachConditions', () => {
  it('しきい値と、3区分 × バス停・駅の分数の入力を、今の値で出す', () => {
    const params = cloneParams(DEFAULT_REACH_PARAMS)
    params.walkMinutes.suburban.rail = 18
    const html = renderToString(<ReachConditions params={params} onThreshold={() => {}} onMinutes={() => {}} onReset={() => {}} />)
    expect(html).toMatch(/id="reach-threshold"[^>]*value="1000"/)
    expect(html).toMatch(/id="reach-urban-bus"[^>]*value="5"/)
    expect(html).toMatch(/id="reach-urban-rail"[^>]*value="10"/)
    expect(html).toMatch(/id="reach-suburban-bus"[^>]*value="10"/)
    expect(html).toMatch(/id="reach-suburban-rail"[^>]*value="18"/)
    expect(html).toMatch(/id="reach-rural-bus"[^>]*value="15"/)
    expect(html).toMatch(/id="reach-rural-rail"[^>]*value="20"/)
    expect(textOf(html)).toContain('都市部 5/10分、郊外 10/18分、中山間・地方 15/20分')
    expect(textOf(html)).toContain('既定値に戻す')
  })
})
