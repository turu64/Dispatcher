import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { makeBands } from '@/gtfs/departures'
import { cloneParams } from '@/reach/input'
import { DEFAULT_REACH_PARAMS, type ReachResult } from '@/reach/reach'
import { summarizeReach } from '@/reach/summary'
import { compareReach } from '@/reach/compare'
import type { ReachSnapshot, RefState } from '@/store/reach'
import { ReachConditions, ReachNotes, ReachSettingLine, ReachSummaryTable, RefStatus, ZeroServiceSummary } from './ReachStep'

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
    origin: { origins: 1460, unused: 122, nonStop: 0, noBoarding: 10 },
  }
}

// 4つ目のセルは、ダイヤと関係なく外れる(到達できる見込みが無い。どの時間帯でも到達できない)
const RESULT: ReachResult = {
  cells: ['65420000111', '65420000112', '65420000113', '65420000114'],
  classes: ['urban', 'suburban', 'rural', 'rural'],
  reachable: [
    [true, true, false, false],
    [true, false, false, false],
    [true, true, true, false],
    [false, false, false, false],
    [true, true, true, false],
    [false, false, false, false],
  ],
  coverable: [true, true, true, false],
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

describe('ReachSettingLine(表の上の、今の比較する日付と時間帯の幅)', () => {
  const PERIOD = { start: '20261001', end: '20261130' }

  it('今の比較する日付と時間帯の幅を1行で出し、地図の下の操作盤で変えることを添える', () => {
    const text = textOf(renderToString(<ReachSettingLine date="20261109" stepHours={3} period={PERIOD} comparing={false} />))
    expect(text).toContain('比較する日付:|2026年11月9日(月)・3時間ごと|')
    expect(text).toContain('地図の下の操作盤で変えられます。')
  })

  it('1時間ごとならそう出す', () => {
    const text = textOf(renderToString(<ReachSettingLine date="20261104" stepHours={1} period={PERIOD} comparing />))
    expect(text).toContain('2026年11月4日(水)・1時間ごと')
  })

  it('運行日が無いときは、操作盤と同じ注意を出す', () => {
    const plain = renderToString(<ReachSettingLine date={null} stepHours={3} period={null} comparing={false} />)
    expect(plain).toContain('role="alert"')
    expect(textOf(plain)).toContain('この GTFS には運行日がありません。calendar.txt・calendar_dates.txt を確かめてください。')
    expect(textOf(plain)).not.toContain('比較する日付:')
    const edited = textOf(renderToString(<ReachSettingLine date={null} stepHours={3} period={PERIOD} comparing />))
    expect(edited).toContain('減便後の GTFS に運行日がありません。減便の期間を確かめてください。')
  })
})

describe('ReachSummaryTable', () => {
  it('時間帯ごとの外れるセルと推計人口を出し、割合の分母は到達できる見込みのあるセルにする', () => {
    const text = textOf(renderToString(<ReachSummaryTable snapshot={snapshotOf({ ...RESULT, excludedStops: 2 })} selectedHour={9} invalidStops={1} />))
    expect(text).toContain('2026年11月4日(水)、3時間ごと')
    // 分母は見込みのある 3 セル(推計人口 180 人)。4つ目のセルは分子にも分母にも入れない
    expect(text).toContain('|6〜9時|1|(33.3%)|30人|(16.7%)|')
    expect(text).toContain('|9〜12時|2|(66.7%)|80人|(44.4%)|')
    expect(text).toContain('|12〜15時|0|(0.0%)|0人|(0.0%)|')
    expect(text).toContain('|15〜18時|3|(100.0%)|180人|(100.0%)|')
  })

  it('ダイヤと関係なく外れるセルの数と推計人口を、時間帯の行とは別の行に出す', () => {
    const html = renderToString(<ReachSummaryTable snapshot={snapshotOf(RESULT)} selectedHour={6} invalidStops={0} />)
    const row = html.match(/<tfoot[^>]*>.*?<\/tfoot>/)?.[0] ?? ''
    expect(textOf(row)).toContain('|徒歩圏に停留所・駅なし|1|20人|')
    // 時間帯の行(tbody)には入れない
    const body = html.match(/<tbody[^>]*>.*?<\/tbody>/)?.[0] ?? ''
    expect(textOf(body)).not.toContain('徒歩圏に停留所・駅なし')
    expect(textOf(html)).toContain('ダイヤにかかわらず到達できないため、時間帯ごとの数と割合には含めず、地図にも塗りません')
  })

  it('調べたセルの内訳(区分、到達できる見込みのあるセル、ダイヤと関係なく外れるセル)と起点の停留所の数を出す', () => {
    const text = textOf(renderToString(<ReachSummaryTable snapshot={snapshotOf(RESULT)} selectedHour={6} invalidStops={0} />))
    expect(text).toContain('起点の停留所 |1,460| 件。')
    expect(text).toContain('起点にしなかった停留所:stop_times.txt に出てこない 122 件、乗れる行がない(すべて終点か pickup_type が 1。降車専用)10 件。')
    expect(text).not.toContain('駅舎・出入口')
    expect(text).toContain('|調べた区画|4|推計人口 200 人|')
    expect(text).toContain('|徒歩圏に停留所・駅がある区画|3|推計人口 180 人|')
    expect(text).toContain('|徒歩圏に停留所・駅がない区画|1|推計人口 20 人|')
    expect(text).toContain('125m 四方の区画(都市部 1・郊外 1・中山間・地方 2)。表の割合の分母は、徒歩圏に停留所・駅がある区画です。')
  })

  it('除いた停留所は、何を除いたのかを分けて書く(0 件のものは書かない)', () => {
    const snapshot = { ...snapshotOf({ ...RESULT, excludedStops: 2 }), origin: { origins: 10, unused: 0, nonStop: 3, noBoarding: 0 } }
    const text = textOf(renderToString(<ReachSummaryTable snapshot={snapshot} selectedHour={6} invalidStops={1} />))
    expect(text).toContain('起点の停留所 |10| 件(うち、緯度経度が地域メッシュの範囲外［(0, 0) など］のため計算から除いた停留所 2 件)。')
    expect(text).toContain('起点にしなかった停留所:駅舎・出入口など(location_type が 0・空以外)3 件、stops.txt の緯度経度が読めない 1 件。')
    expect(text).not.toContain('stop_times.txt に出てこない')
    expect(text).not.toContain('乗れる行がない')
  })

  it('除いた停留所が無ければ、そう書く', () => {
    const snapshot = { ...snapshotOf(RESULT), origin: { origins: 10, unused: 0, nonStop: 0, noBoarding: 0 } }
    const text = textOf(renderToString(<ReachSummaryTable snapshot={snapshot} selectedHour={6} invalidStops={0} />))
    expect(text).toContain('起点にしなかった停留所はありません。')
  })

  it('割合と推計人口は、数の下の行に出す(行によって折り返しが変わらないように)', () => {
    const html = renderToString(<ReachSummaryTable snapshot={snapshotOf(RESULT)} selectedHour={6} invalidStops={0} />).replace(/<!-- -->/g, '')
    expect(html).toMatch(/<span class="block[^"]*">\(33\.3%\)<\/span>/)
    expect(html).toMatch(/<span class="block[^"]*">\(16\.7%\)<\/span>/)
  })

  it('地図に出している時間帯の行を強調する', () => {
    const html = renderToString(<ReachSummaryTable snapshot={snapshotOf(RESULT)} selectedHour={10} invalidStops={0} />)
    const selected = html.match(/<tr[^>]*data-selected="true"[^>]*>.*?<\/tr>/)?.[0] ?? ''
    expect(textOf(selected)).toContain('9〜12時')
    expect(html.match(/data-selected="true"/g)).toHaveLength(1)
    expect(html).toContain('aria-current="true"')
  })

  it('参照データが無い(fallback)ときは、推計人口の列と、ダイヤと関係なく外れるセルの行・内訳・説明を出さない', () => {
    const fallback = { ...RESULT, usedFallback: true, cellPopulation: [0, 0, 0, 0], coverable: [true, true, true, true] }
    const html = renderToString(<ReachSummaryTable snapshot={snapshotOf(fallback)} selectedHour={6} invalidStops={0} />)
    const text = textOf(html)
    expect(text).not.toContain('推計人口')
    expect(text).toContain('|6〜9時|2|(50.0%)|')
    expect(text).not.toContain('徒歩圏に停留所・駅なし')
    expect(text).not.toContain('徒歩圏に停留所・駅がない区画')
    expect(html).not.toContain('<tfoot')
    expect(text).not.toContain('人|(')
  })
})

describe('ReachNotes', () => {
  it('空・読めない departure_time、frequencies.txt を知らせる', () => {
    const html = renderToString(
      <ReachNotes snapshot={snapshotOf(RESULT, { skippedBlankTime: 3, skippedInvalidTime: 4, hasFrequencies: true })} />,
    )
    const text = textOf(html)
    expect(text).toContain('departure_time が空の行 3 件')
    expect(text).toContain('departure_time が時刻として読めない行 4 件')
    expect(text).toContain('frequencies.txt があります')
  })

  it('知らせることが無ければ何も出さない', () => {
    expect(renderToString(<ReachNotes snapshot={snapshotOf(RESULT)} />)).toBe('')
  })

  it('出発がある停留所が無い日はそう出す', () => {
    const snapshot = snapshotOf(RESULT)
    snapshot.departures.counts = new Map()
    expect(textOf(renderToString(<ReachNotes snapshot={snapshot} />))).toContain('発車がある停留所はありません')
  })

  it('参照データは読めたが、範囲の人口が空で調べるセルが 0 のときは、その理由を出す', () => {
    const empty: ReachResult = { ...RESULT, cells: [], classes: [], reachable: Array.from({ length: 6 }, () => []), coverable: [], cellPopulation: [] }
    const text = textOf(renderToString(<ReachNotes snapshot={snapshotOf(empty)} />))
    expect(text).toContain('250m メッシュの人口がすべて 0 人')
    expect(text).toContain('調べる区画がありません')
    // 参照データが無い(fallback)ときは、この理由ではない
    const fallback = textOf(renderToString(<ReachNotes snapshot={snapshotOf({ ...empty, usedFallback: true })} />))
    expect(fallback).not.toContain('250m メッシュの人口')
  })
})

describe('減便の前後の比較', () => {
  // 基準:6〜9時は 1 セル外れる。編集後:6〜9時は 2 セル外れ(1 セルが減便で外れた)、9〜12時は 1 セルが新たに到達
  const AFTER: ReachResult = {
    ...RESULT,
    reachable: [
      [true, false, false, false],
      [true, true, false, false],
      [true, true, true, false],
      [false, false, false, false],
      [true, true, true, false],
      [false, false, false, false],
    ],
  }
  function compared(draft: boolean): ReachSnapshot {
    const before = snapshotOf(RESULT)
    const after = snapshotOf(AFTER)
    return {
      ...after,
      baseline: { departures: before.departures, result: RESULT, summary: before.summary },
      comparison: compareReach(RESULT, AFTER),
      zeroStops: [
        { stopId: 'S9', name: '学校前', beforeDepartures: 1, scope: 'feed' },
        { stopId: 'A', name: '駅前', beforeDepartures: 5, scope: 'day' },
      ],
      zeroRoutes: [{ routeId: 'R3', name: '3', beforeTrips: 4, scope: 'feed' }],
      draft,
    }
  }

  it('減便前・減便後の外れる割合、増減(ポイント)、減便で外れたセルと新たに到達したセルを出す', () => {
    const text = textOf(renderToString(<ReachSummaryTable snapshot={compared(false)} selectedHour={6} invalidStops={0} />))
    for (const h of ['減便前の到達圏外の割合', '減便後の到達圏外の割合', '増減(ポイント)', '減便で到達圏から外れた区画(推計人口)', '新たに到達(推計人口)']) {
      expect(text).toContain(h)
    }
    // 分母は基準の見込みのあるセル 3
    // 増減は表に並べた割合(小数1桁)の差
    expect(text).toContain('|6〜9時|33.3%|66.7%|+33.4|1|(50人)|0|(0人)|')
    expect(text).toContain('|9〜12時|66.7%|33.3%|−33.4|0|(0人)|1|(50人)|')
    expect(text).not.toContain('下書き')
  })

  it('時間帯の列は折り返さない(380px の幅で「6〜9時」が「6〜9 / 時」に折れないように)', () => {
    const whole = renderToString(<ReachSummaryTable snapshot={compared(false)} selectedHour={6} invalidStops={0} />).replace(/<!-- -->/g, '')
    // 前後の比較の表(見出し「減便の前後」から後ろ)だけを見る
    const html = whole.slice(whole.indexOf('減便の前後'))
    expect(html.length).toBeLessThan(whole.length)
    const label = html.match(/<(th|td)[^>]*class="([^"]*)"[^>]*>(6〜9時)<\/\1>/)
    expect(label).not.toBeNull()
    expect(label![2]).toContain('whitespace-nowrap')
    expect(label![2]).not.toContain('whitespace-normal')
    // 見出しの「時間帯」も同じ
    const head = html.match(/<th[^>]*class="([^"]*)"[^>]*>時間帯<\/th>/)
    expect(head![1]).toContain('whitespace-nowrap')
    expect(head![1]).not.toContain('whitespace-normal')
  })

  it('下書きのときは、表の見出しに「下書き」と出す', () => {
    const text = textOf(renderToString(<ReachSummaryTable snapshot={compared(true)} selectedHour={6} invalidStops={0} />))
    expect(text).toContain('減便の前後|下書き|')
  })

  it('一日を通して乗れなくなる場所と、運行がゼロになる停留所・系統を出す(全日の件数を先に)', () => {
    const text = textOf(renderToString(<ZeroServiceSummary snapshot={compared(false)} />))
    expect(text).toContain('|一日を通して到達できなくなる区画|0|推計人口 0 人|')
    expect(text).toContain('|発車がなくなる停留所|2|うち全日 1|')
    expect(text).toContain('掲示の撤去と、休止の届出に当たるかを確かめてください')
    expect(text).toContain('|全日| 学校前|S9|(減便前のこの日の発車 1 本)')
    expect(text).toContain('|この日| 駅前|A|(減便前のこの日の発車 5 本)')
    expect(text).toContain('|便がなくなる系統|1|うち全日 1|')
    expect(text).toContain('発車がなくなる停留所の一覧(2 件)')
    expect(text).toContain('Dispatcher は届出の要否を判定しません。')
    expect(text).toContain('路線の休止の届出に当たるかを運輸支局に確認してください')
    expect(text).toContain('(減便前の全便 4 便)')
  })

  it('減便後の GTFS が無ければ、運行がゼロになる場所は出さない', () => {
    expect(renderToString(<ZeroServiceSummary snapshot={snapshotOf(RESULT)} />)).toBe('')
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
    expect(text).not.toContain('参照データがないときの区分')
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
    expect(text).toContain('鉄道駅はないものとして計算しています')
    expect(text).toContain('参照データがないときの区分')
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

  it('分数の欄は 0〜60 の整数(数字のキーボード、上限 60)', () => {
    const html = renderToString(
      <ReachConditions params={cloneParams(DEFAULT_REACH_PARAMS)} onThreshold={() => {}} onMinutes={() => {}} onReset={() => {}} />,
    )
    const minutes = html.match(/<input[^>]*id="reach-urban-bus"[^>]*>/)?.[0] ?? ''
    expect(minutes).toContain('inputMode="numeric"')
    expect(minutes).toContain('max="60"')
    expect(minutes).toContain('step="1"')
    expect(textOf(html)).toContain('分数は 0〜60 分の整数')
  })
})
