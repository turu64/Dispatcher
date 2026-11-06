import { describe, expect, it, vi } from 'vitest'
import { AGENCY, FEED_INFO, feedOf, rowsOf, smallFeed } from '../gtfs/edit/form2.fixture'
import { defaultFacilityWindows, facilityWindows } from '../gtfs/edit/facilityHours'
import { reachBaseFeed, reachSetup } from '../gtfs/edit/restore.fixture'
import type { HintFacility, NearFacility, RestoreHintContext, RestoreHintDetail } from '../gtfs/edit/restore'
import { makeBands } from '../gtfs/departures'
import { DEFAULT_REACH_PARAMS } from '../reach/reach'
import { DUTY_DEFAULTS, type DutyPlace } from '../gtfs/edit/duties'
import { compareDrivers } from '../store/drivers'
import { createEditStore, type BaseGtfs } from '../store/edit'
import type { ReachSnapshot } from '../store/reach'
import {
  fitImpactLists,
  fitResult,
  fitTrips,
  INPUT_LIMITS,
  MAX_IMPACT_ITEMS,
  MAX_RESULT_BYTES,
  resolveRouteRefs,
  runTool,
  shortHintText,
  type ReachAccess,
  type ReachView,
  type ToolDeps,
} from './tools'

// 時計は 2026-11-04 09:30(日本時間)に止める
const NOW = new Date('2026-11-04T00:30:00Z')

/** 計算の終わっている到達圏(summarize_impact を使わないテスト用。日付・時間帯を変えようとしたら失敗する) */
const IDLE_REACH: ReachAccess = {
  getState: () => ({
    date: '20261110',
    stepHours: 3,
    computing: false,
    error: null,
    snapshot: null,
    setDate: () => {
      throw new Error('日付は変えないはず')
    },
    setStepHours: () => {
      throw new Error('時間帯の幅は変えないはず')
    },
  }),
  subscribe: () => () => undefined,
}

function setup(overrides: Partial<ToolDeps> = {}, feed = smallFeed()) {
  const store = createEditStore({ now: () => NOW, onEdited: vi.fn() })
  const base: BaseGtfs = { feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null }
  store.getState().setBase(base)
  const deps: ToolDeps = {
    edit: () => store.getState(),
    reach: IDLE_REACH,
    holidays: () => null,
    today: () => '20261104',
    policyServices: () => ({ weekday: 'WK', saturday: 'SA', sundayHoliday: 'SU' }),
    hintContext: () => null,
    ...overrides,
  }
  return { store, deps }
}

const POLICY_INPUT = {
  kind: 'weekday_to_saturday',
  start_date: '20261109',
  end_date: null,
  excluded_route_ids: [],
  reason_category: 'temporary_shortage',
  reason_note: '運転士の急な欠員',
}

const SEARCH = { scope: 'removed', route_ids: null, stop_name: null, depart_from: null, depart_to: null, limit: 10, offset: null, hints: null }

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>
}

/** 方針を下書きにして承認しておく */
async function withPolicy(deps: ToolDeps, store: ReturnType<typeof setup>['store'], input: Record<string, unknown> = POLICY_INPUT) {
  const r = await runTool('apply_policy', input, deps)
  expect(r.isError).toBe(false)
  expect(store.getState().commit()).toEqual({ ok: true })
}

describe('系統の指定を route_id に読み替える(resolveRouteRefs)', () => {
  /** 道北バスと同じ形:route_short_name が空で、route_long_name の頭に系統番号がある */
  const dohokuLike = () =>
    feedOf({
      routes: rowsOf(`
route_id,agency_id,route_short_name,route_long_name,route_type
0051,1,,51-沼田深川線,3
0151,1,,151-沼田深川西高線,3
0044,1,,44-神楽北線,3
R7,1,7,駅前線,3
X1,1,,ー,3
X2,1,9,環状線,3
X3,1,9,環状線(逆),3`),
    })

  it('系統番号を route_long_name の頭の番号から読む(道北バスの「系統51」)', () => {
    const r = resolveRouteRefs(dohokuLike(), ['51', '151'])
    expect(r.problems).toEqual([])
    expect(r.resolved).toEqual([
      { given: '51', route_id: '0051', name: '51-沼田深川線', by: 'long_name_number' },
      { given: '151', route_id: '0151', name: '151-沼田深川西高線', by: 'long_name_number' },
    ])
  })

  it('route_id・route_short_name・route_long_name・頭の 0 の違いの順に当てる', () => {
    const r = resolveRouteRefs(dohokuLike(), ['0044', '7', '駅前線', '044'])
    expect(r.problems).toEqual([])
    expect(r.resolved.map((x) => [x.given, x.route_id, x.by])).toEqual([
      ['0044', '0044', 'route_id'],
      ['7', 'R7', 'route_short_name'],
      ['駅前線', 'R7', 'route_long_name'],
      ['044', '0044', 'long_name_number'],
    ])
  })

  it('当たらない指定と、2つ以上に当たる指定は、推測せずに問題として返す', () => {
    const r = resolveRouteRefs(dohokuLike(), ['52', '9'])
    expect(r.resolved).toEqual([])
    expect(r.problems).toHaveLength(2)
    expect(r.problems[0]).toContain('「52」に当たる系統がありません')
    expect(r.problems[1]).toContain('「9」に当たる系統が 2 つあります')
  })
})

describe('apply_policy は系統の指定を読み替え、決まらなければ下書きを作らない', () => {
  it('系統番号で外した系統を route_id にして下書きを作り、読み替えを結果に書く', async () => {
    const { deps, store } = setup()
    const r = await runTool('apply_policy', { ...POLICY_INPUT, excluded_route_ids: ['駅前線'] }, deps)
    expect(r.isError).toBe(false)
    expect(parse(r.content).excluded_routes).toEqual([{ given: '駅前線', route_id: 'R1', name: '駅前線', by: 'route_long_name' }])
    const draft = store.getState().draft
    expect(draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' && draft.record.op.settings.excludedRoutes).toEqual(['R1'])
  })

  it('search_trips の route_ids も同じ規則で読み替え、決まらなければ探さない', async () => {
    const { deps } = setup()
    const r = await runTool('search_trips', { ...SEARCH, scope: 'base_weekday', route_ids: ['駅前線'] }, deps)
    expect(r.isError).toBe(false)
    const body = parse(r.content)
    expect(body.routes).toEqual([{ given: '駅前線', route_id: 'R1', name: '駅前線', by: 'route_long_name' }])
    expect((body.trips as { route_id: string }[]).every((t) => t.route_id === 'R1')).toBe(true)
    const bad = await runTool('search_trips', { ...SEARCH, scope: 'base_weekday', route_ids: ['99'] }, deps)
    expect(bad.isError).toBe(true)
  })

  it('決まらない系統があれば is_error で返し、下書きを作らない', async () => {
    const { deps, store } = setup()
    const r = await runTool('apply_policy', { ...POLICY_INPUT, excluded_route_ids: ['99'] }, deps)
    expect(r.isError).toBe(true)
    expect(parse(r.content).message).toContain('「99」に当たる系統がありません')
    expect(store.getState().draft).toBeNull()
  })
})

describe('apply_policy は下書きを作り status: draft と draft_id を返す', () => {
  it('画面の service で下書きを作り、数はコードが出した summary に入れる', async () => {
    const { store, deps } = setup()
    const r = await runTool('apply_policy', POLICY_INPUT, deps)
    expect(r.isError).toBe(false)
    expect(r.draft).toEqual({ id: '1', kind: 'op' })
    const body = parse(r.content)
    expect(body.status).toBe('draft')
    expect(body.draft_id).toBe('1')
    expect(body.note).toBe('利用者の承認待ちです。承認されるまで GTFS は変わりません。')
    // 小さなフィード:平日 4 便のうち R1_0700_WK だけが土曜便と同じ。消える 3、入る 3(R1_0800_SA・R1_0805_SA・R2_1000_SA)
    expect(body.summary).toMatchObject({
      weekday_trips_before: 4,
      weekday_trips_after: 4,
      removed: 3,
      added: 3,
      same: 1,
      validity: { start: '20261109', end: '20261130', days: 22 },
      vanishing_routes: [{ route_id: 'R3', name: '3' }],
    })
    expect(body.services).toEqual({ weekday: 'WK', replacement: 'SA' })
    // 下書きは Claude の操作で、名前は web の名前に直してある
    const draft = store.getState().draft
    expect(draft?.kind === 'op' && draft.record.by).toBe('claude')
    expect(draft?.kind === 'op' && draft.record.op).toEqual({
      type: 'applyPolicy',
      settings: { kind: 'weekdayToSaturday', weekdayService: 'WK', replacementService: 'SA', period: { start: '20261109', end: null }, excludedRoutes: [] },
      reason: { category: 'temporaryShortage', note: '運転士の急な欠員' },
    })
    expect(store.getState().history).toEqual([])
  })

  it('画面で平日・写す元の service が決まっていなければエラーにし、下書きを作らない', async () => {
    const { store, deps } = setup({ policyServices: () => ({ weekday: 'WK', saturday: null, sundayHoliday: 'SU' }) })
    const r = await runTool('apply_policy', POLICY_INPUT, deps)
    expect(r.isError).toBe(true)
    expect(parse(r.content)).toEqual({ status: 'error', message: '手順3「減便の方針」で、入れ替え元のダイヤ(平日)と入れ替えに使うダイヤ(土曜/日祝)の service を選んでください。' })
    expect(store.getState().draft).toBeNull()
    // 日祝ダイヤなら日祝の service を使う
    const sunday = await runTool('apply_policy', { ...POLICY_INPUT, kind: 'weekday_to_sunday_holiday' }, deps)
    expect(sunday.isError).toBe(false)
    expect(parse(sunday.content).services).toEqual({ weekday: 'WK', replacement: 'SU' })
  })

  it('適用できない方針(期間が入力の有効期間と重ならない)は、下書きを作らずに理由を返す', async () => {
    const { store, deps } = setup()
    const r = await runTool('apply_policy', { ...POLICY_INPUT, start_date: '20270101' }, deps)
    expect(r.isError).toBe(true)
    expect(String(parse(r.content).message)).toContain('入力の有効期間')
    expect(store.getState().draft).toBeNull()
  })
})

describe('不正な日付や範囲外の件数は is_error で返す', () => {
  it.each([
    ['apply_policy', { ...POLICY_INPUT, start_date: '20261131' }, 'start_date'],
    ['apply_policy', { ...POLICY_INPUT, start_date: '2026-11-09' }, 'YYYYMMDD'],
    ['apply_policy', { ...POLICY_INPUT, end_date: '20261101' }, 'end_date'],
    ['apply_policy', { ...POLICY_INPUT, kind: 'weekday_to_holiday' }, 'kind'],
    ['apply_policy', { kind: 'weekday_to_saturday' }, 'start_date'],
    ['add_back_trips', { items: [] }, '1〜50 件'],
    ['add_back_trips', { items: Array.from({ length: 51 }, (_, i) => ({ trip_id: `T${i}`, reason: '', school_days_only: false })) }, '1〜50 件'],
    ['add_back_trips', { items: [{ trip_id: 'R1_0800_WK', reason: '通学', school_days_only: 'no' }] }, 'school_days_only'],
    ['search_trips', { ...SEARCH, limit: 0 }, '1〜50'],
    ['search_trips', { ...SEARCH, limit: 51 }, '1〜50'],
    ['search_trips', { ...SEARCH, limit: 2.5 }, '1〜50'],
    ['search_trips', { ...SEARCH, depart_from: '48:00' }, 'HH:MM'],
    ['search_trips', { ...SEARCH, depart_from: '7:00' }, 'HH:MM'],
    ['search_trips', { ...SEARCH, depart_from: '07:60' }, 'HH:MM'],
    ['search_trips', { ...SEARCH, depart_from: '08:00', depart_to: '07:00' }, 'depart_to'],
    ['search_trips', { ...SEARCH, scope: 'all' }, 'scope'],
    ['search_trips', { ...SEARCH, offset: -1 }, 'offset'],
    ['search_trips', { ...SEARCH, offset: 1.5 }, 'offset'],
    ['search_trips', { ...SEARCH, offset: 100_001 }, 'offset'],
    ['search_trips', { ...SEARCH, hints: ['onlyTrip'] }, 'hints の onlyTrip は判断材料の名前ではありません'],
    ['search_trips', { ...SEARCH, scope: 'added', hints: ['morning'] }, 'hints で絞れるのは、scope が removed か base_weekday'],
    ['summarize_impact', { date: '20261232', step_hours: null }, 'date'],
    ['summarize_impact', { date: null, step_hours: 2 }, 'step_hours'],
  ])('%s %j', async (name, input, word) => {
    const { store, deps } = setup()
    const r = await runTool(name, input, deps)
    expect(r.isError).toBe(true)
    const body = parse(r.content)
    expect(body.status).toBe('error')
    expect(String(body.message)).toContain(word)
    expect(store.getState().draft).toBeNull()
  })

  it('知らないツールもエラーにする', async () => {
    const { deps } = setup()
    const r = await runTool('delete_everything', {}, deps)
    expect(r.isError).toBe(true)
    expect(parse(r.content).message).toBe('delete_everything というツールはありません。')
  })
})

describe('型の確かめ(strict が無いので、すべてブラウザで確かめる)', () => {
  it.each([
    // 入力がオブジェクトでない
    ['undo_edit', null, 'オブジェクトではありません'],
    ['undo_edit', [], 'オブジェクトではありません'],
    ['run_validation', 'はい', 'オブジェクトではありません'],
    ['run_validation', undefined, 'オブジェクトではありません'],
    // 知らない項目
    ['apply_policy', { ...POLICY_INPUT, weekday_service: 'WK' }, '知らない項目 weekday_service'],
    ['undo_edit', { draft_id: '1' }, '知らない項目 draft_id'],
    ['run_validation', { strict: true }, '知らない項目 strict'],
    ['search_trips', { ...SEARCH, cursor: 10 }, '知らない項目 cursor'],
    ['summarize_impact', { date: null, step_hours: null, band: '6〜9時' }, '知らない項目 band'],
    // items の要素の知らない項目・形
    ['add_back_trips', { items: [{ trip_id: 'R3_0730_WK', reason: '通学', school_days_only: false, feed: 'base' }] }, 'items[0]に知らない項目 feed'],
    ['add_back_trips', { items: [{ trip_id: 'R3_0730_WK', reason: '通学' }] }, 'items[0]に school_days_only がありません'],
    ['add_back_trips', { items: ['R3_0730_WK'] }, 'items[0]がオブジェクトではありません'],
    ['add_back_trips', { items: { trip_id: 'R3_0730_WK' } }, 'items は配列'],
    // 型の違い
    ['apply_policy', { ...POLICY_INPUT, kind: 1 }, 'kind は文字列'],
    ['apply_policy', { ...POLICY_INPUT, kind: 'constructor' }, 'kind'],
    ['apply_policy', { ...POLICY_INPUT, start_date: 20261109 }, 'start_date'],
    ['apply_policy', { ...POLICY_INPUT, end_date: 20261130 }, 'end_date'],
    ['apply_policy', { ...POLICY_INPUT, excluded_route_ids: null }, 'excluded_route_ids は文字列の配列'],
    ['apply_policy', { ...POLICY_INPUT, excluded_route_ids: 'R1' }, 'excluded_route_ids は文字列の配列'],
    ['apply_policy', { ...POLICY_INPUT, excluded_route_ids: [1] }, 'excluded_route_ids は文字列の配列'],
    ['apply_policy', { ...POLICY_INPUT, reason_category: 'toString' }, 'reason_category'],
    ['apply_policy', { ...POLICY_INPUT, reason_category: true }, 'reason_category'],
    ['apply_policy', { ...POLICY_INPUT, reason_note: null }, 'reason_note は文字列'],
    ['add_back_trips', { items: [{ trip_id: 7, reason: '', school_days_only: false }] }, 'items[0].trip_id は文字列'],
    ['add_back_trips', { items: [{ trip_id: '  ', reason: '', school_days_only: false }] }, 'items[0].trip_id が空'],
    ['add_back_trips', { items: [{ trip_id: 'R3_0730_WK', reason: null, school_days_only: false }] }, 'items[0].reason は文字列'],
    ['search_trips', { ...SEARCH, scope: null }, 'scope は文字列'],
    ['search_trips', { ...SEARCH, route_ids: 'R1' }, 'route_ids は文字列の配列か null'],
    ['search_trips', { ...SEARCH, stop_name: 3 }, 'stop_name は文字列か null'],
    ['search_trips', { ...SEARCH, depart_to: 700 }, 'depart_to'],
    ['search_trips', { ...SEARCH, limit: '10' }, 'limit'],
    ['search_trips', { ...SEARCH, offset: '10' }, 'offset'],
    ['search_trips', { ...SEARCH, hints: 'morning' }, 'hints は文字列の配列か null'],
    ['summarize_impact', { date: 20261110, step_hours: null }, 'date'],
    ['summarize_impact', { date: null, step_hours: '3' }, 'step_hours'],
  ])('%s %j', async (name, input, word) => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const r = await runTool(name, input, deps)
    expect(r.isError).toBe(true)
    expect(String(parse(r.content).message)).toContain(word)
    expect(store.getState().draft).toBeNull()
  })

  it('長すぎる文字列・多すぎる配列・大きすぎる入力を断る', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const cases: [string, unknown, string][] = [
      ['apply_policy', { ...POLICY_INPUT, reason_note: 'あ'.repeat(201) }, 'reason_note は 200 字まで'],
      ['add_back_trips', { items: [{ trip_id: 'R3_0730_WK', reason: '理'.repeat(201), school_days_only: false }] }, 'items[0].reason は 200 字まで'],
      ['search_trips', { ...SEARCH, stop_name: '駅'.repeat(101) }, 'stop_name は 100 字まで'],
      ['search_trips', { ...SEARCH, route_ids: Array.from({ length: 201 }, (_, i) => `R${i}`) }, 'route_ids は 200 件まで'],
      ['apply_policy', { ...POLICY_INPUT, excluded_route_ids: Array.from({ length: 201 }, (_, i) => `R${i}`) }, 'excluded_route_ids は 200 件まで'],
      [
        'add_back_trips',
        { items: Array.from({ length: 50 }, (_, i) => ({ trip_id: `T${i}`.padEnd(300, 'x'), reason: '', school_days_only: false })) },
        '入力が大きすぎます',
      ],
    ]
    for (const [name, input, word] of cases) {
      const r = await runTool(name, input, deps)
      expect(r.isError, `${name} ${word}`).toBe(true)
      expect(String(parse(r.content).message)).toContain(word)
    }
    expect(store.getState().draft).toBeNull()
    // ちょうど上限なら受け付ける(サロゲートペアは1字と数える)
    const okNote = await runTool('apply_policy', { ...POLICY_INPUT, reason_note: '𠮷'.repeat(INPUT_LIMITS.reasonChars) }, setup().deps)
    expect(okNote.isError).toBe(false)
  })
})

describe('並べて呼ばれた2つ目の編集は、下書きが承認待ちなのでエラーになる', () => {
  it('apply_policy の下書きがある間の add_back_trips・undo_edit・apply_policy は断る', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const first = await runTool('add_back_trips', { items: [{ trip_id: 'R3_0730_WK', reason: '通学', school_days_only: false }] }, deps)
    expect(first.isError).toBe(false)
    const id = parse(first.content).draft_id
    for (const [name, input] of [
      ['add_back_trips', { items: [{ trip_id: 'R1_0800_WK', reason: '通勤', school_days_only: false }] }],
      ['undo_edit', {}],
      ['apply_policy', POLICY_INPUT],
    ] as const) {
      const r = await runTool(name, input, deps)
      expect(r.isError).toBe(true)
      expect(parse(r.content)).toEqual({ status: 'error', message: `下書き #${id} が承認待ちです。利用者が「承認する」か「やめる」を押すまで、次の編集はできません。` })
    }
    // 先の下書きは残る
    expect(store.getState().draft?.id).toBe(id)
  })
})

describe('add_back_trips は基準の平日便の trip_id だけを受け付け、便の始発時刻と系統を返す', () => {
  it('方針が承認される前は使えない', async () => {
    const { deps } = setup()
    const r = await runTool('add_back_trips', { items: [{ trip_id: 'R3_0730_WK', reason: '通学', school_days_only: false }] }, deps)
    expect(r.isError).toBe(true)
    expect(String(parse(r.content).message)).toContain('方針が承認されていない')
  })

  it('平日便でない trip_id があれば、下書きを作らずにその trip_id を返す', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const r = await runTool(
      'add_back_trips',
      {
        items: [
          { trip_id: 'R3_0730_WK', reason: '通学', school_days_only: false },
          { trip_id: 'R1_0805_SA', reason: '土曜便', school_days_only: false },
          { trip_id: 'NOPE', reason: '', school_days_only: false },
        ],
      },
      deps,
    )
    expect(r.isError).toBe(true)
    expect(String(parse(r.content).message)).toContain('R1_0805_SA、NOPE')
    expect(store.getState().draft).toBeNull()
  })

  it('受け付けた便ごとの始発時刻・系統・始発 → 終着と、受け付けなかった理由と、足し戻しの合計を返す', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const r = await runTool(
      'add_back_trips',
      {
        items: [
          { trip_id: ' R3_0730_WK ', reason: '学校前を通る唯一の便(推定)', school_days_only: true },
          { trip_id: 'R1_0700_WK', reason: '土曜便と同じ', school_days_only: false },
          { trip_id: 'R3_0730_WK', reason: '重複', school_days_only: false },
        ],
      },
      deps,
    )
    expect(r.isError).toBe(false)
    expect(r.draft).toEqual({ id: '2', kind: 'op' })
    const body = parse(r.content)
    expect(body.merged_duplicates).toBe(1)
    const addBack = (body.summary as Record<string, unknown>).add_back as Record<string, unknown>
    expect(addBack.accepted).toEqual([
      { trip_id: 'R3_0730_WK', route_id: 'R3', route_name: '3', headsign: '市役所', first_departure: '07:30', first_stop: '駅前', last_stop: '市役所' },
    ])
    expect(addBack.not_accepted).toEqual([
      { trip_id: 'R1_0700_WK', reason: '土曜ダイヤに同じ時刻の便(R1_0700_SA)があるため、平日に戻す必要がありません。' },
    ])
    expect(addBack.totals).toMatchObject({ trips: 1, service_minutes: 20, service_time: '0時間20分', earliest_start: '07:30', latest_end: '07:50' })
    // 便ごとの理由と休校日運休の印は、操作に残る(重複は最初の理由)
    const draft = store.getState().draft
    expect(draft?.kind === 'op' && draft.record.op).toEqual({
      type: 'addBack',
      items: [
        { tripId: 'R3_0730_WK', reason: '学校前を通る唯一の便(推定)', schoolDaysOnly: true },
        { tripId: 'R1_0700_WK', reason: '土曜便と同じ', schoolDaysOnly: false },
      ],
    })
  })
})

describe('結果が 20KB を超えたら切り詰めて件数を書く', () => {
  it('一覧を後ろから切り、切った件数を書く(バイト数は UTF-8 で数える)', () => {
    const trips = Array.from({ length: 50 }, (_, i) => ({ trip_id: `T${i}`, headsign: 'あ'.repeat(200) }))
    const text = fitResult({ status: 'ok', total: 50, trips }, ['trips'])
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    const body = parse(text)
    const kept = (body.trips as unknown[]).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(50)
    expect(body.truncated).toBe(50 - kept)
    expect(String(body.truncated_note)).toContain(`${50 - kept} 件`)
    // 前から残す
    expect((body.trips as { trip_id: string }[])[0].trip_id).toBe('T0')
    // 20KB 以下ならそのまま
    expect(fitResult({ trips: trips.slice(0, 2) }, ['trips'])).toBe(JSON.stringify({ trips: trips.slice(0, 2) }))
  })

  it('search_trips の便の一覧も 20KB に収める', async () => {
    const n = 50
    const feed = feedOf({
      agency: rowsOf(AGENCY),
      routes: rowsOf('route_id,agency_id,route_short_name,route_long_name,route_type\nR1,1,1,長い線,3'),
      stops: rowsOf('stop_id,stop_name,stop_lat,stop_lon\nA,駅前,43.76,142.36\nB,市役所,43.77,142.37'),
      calendar: rowsOf('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261001,20261130'),
      trips: Array.from({ length: n }, (_, i) => ({ route_id: 'R1', service_id: 'WK', trip_id: `T${String(i).padStart(2, '0')}`, trip_headsign: '行き先'.repeat(100) })),
      stop_times: Array.from({ length: n }, (_, i) => [
        { trip_id: `T${String(i).padStart(2, '0')}`, arrival_time: '07:00:00', departure_time: '07:00:00', stop_id: 'A', stop_sequence: '1' },
        { trip_id: `T${String(i).padStart(2, '0')}`, arrival_time: '07:10:00', departure_time: '07:10:00', stop_id: 'B', stop_sequence: '2' },
      ]).flat(),
      feed_info: rowsOf(FEED_INFO),
    })
    const { deps } = setup({}, feed)
    const r = await runTool('search_trips', { ...SEARCH, scope: 'base_weekday', limit: 50 }, deps)
    expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    const body = parse(r.content)
    expect(body.total).toBe(50)
    expect((body.trips as unknown[]).length + Number(body.truncated)).toBe(50)
    // returned は省いた後の便の数で、offset + returned + truncated + omitted_over_limit が total になる(続きの位置を読み違えないように)
    expect(body.returned).toBe((body.trips as unknown[]).length)
    expect(Number(body.offset) + Number(body.returned) + Number(body.truncated) + Number(body.omitted_over_limit)).toBe(body.total)
    expect(String(body.truncated_note)).toContain(`returned は trips に入れた ${String(body.returned)} 件`)
    // 続きは next_offset から読む(truncated_note も offset を案内する)
    expect(body.next_offset).toBe(body.returned)
    expect(String(body.truncated_note)).toContain(`offset を ${String(body.returned)} にして読んでください`)
    const next = parse((await runTool('search_trips', { ...SEARCH, scope: 'base_weekday', limit: 50, offset: body.next_offset }, deps)).content)
    expect((next.trips as { trip_id: string }[])[0].trip_id).toBe(`T${String(body.returned).padStart(2, '0')}`)
  })

  it('search_trips で limit を超えた便と 20KB で省いた便を分けて数える(fitTrips)', () => {
    const trips = Array.from({ length: 30 }, (_, i) => ({ trip_id: `T${i}`, headsign: 'あ'.repeat(400) }))
    const text = fitTrips({ status: 'ok', total: 45, offset: 5, returned: 30, omitted_over_limit: 10, next_offset: 35, notes: [], trips })
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    const body = parse(text)
    const kept = (body.trips as unknown[]).length
    expect(kept).toBeLessThan(30)
    // 続きの位置は、省いた便の先頭(offset + 残した便の数)
    expect(body).toMatchObject({ total: 45, offset: 5, returned: kept, omitted_over_limit: 10, truncated: 30 - kept, next_offset: 5 + kept })
    // 20KB 以下ならそのまま
    const small = { status: 'ok', total: 1, returned: 1, omitted_over_limit: 0, trips: trips.slice(0, 1) }
    expect(fitTrips(small)).toBe(JSON.stringify(small))
  })

  // tools.ts の HINT_TEXTS_NOTE と同じ文(hint_texts を省いたら外す)
  const HINT_TEXTS_NOTE = '利用者には「唯一の便」とは書かず、hint_texts の言い方を使ってください。系統の便数は route_weekday_trips です。'
  const OMITTED_NOTE_HEAD = '結果を 20KB に収めるため、次を省きました:'

  it('便を省く前に、調べた施設の結果・前の便と同じ施設の詳しい項目・hint_texts・via の順に省き、省いたものを1つの文に書く(波5のレビュー)', () => {
    // 施設は 2 つ(便ごとに交互)。どの便も hint_texts と via を持つ。調べた施設の結果は 1 件 3KB ほど
    const facility = (i: number) => ({ target_id: `P04:病院${i}`, name: `病院${i}`.repeat(10), category: '入院設備のある病院', priority_rank: 1, matches: [`07:${String(10 + i)}着 病院前${i}`] })
    // via を省いても収まらず、便も省く大きさ(1便 600 バイトほど × 60 便)
    const trips = Array.from({ length: 60 }, (_, i) => ({
      feed: 'base',
      trip_id: `T${String(i).padStart(2, '0')}`,
      headsign: '行き先'.repeat(30),
      via: ['経由の停留所'.repeat(5), '次の停留所'.repeat(5)],
      hints: ['weekdayOnlyRoute', 'routeWouldVanish', 'nearFacility'],
      hint_texts: ['平日だけの系統', '全曜日で便がなくなる系統', '学校・病院の近く(2 施設)'],
      nearby_facilities: [facility(i % 2)],
    }))
    const research = Array.from({ length: 3 }, (_, i) => ({ target_id: `P04:病院${i}`, facts: [{ value: 'あ'.repeat(1000) }] }))
    const body = { status: 'ok', total: 60, offset: 0, returned: 60, omitted_over_limit: 0, next_offset: null, notes: ['状態の文', HINT_TEXTS_NOTE], facility_research: research, trips }
    const text = fitTrips(body)
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    const out = parse(text)
    // 1. 調べた施設の結果は件数だけ
    expect(out.facility_research).toEqual([])
    expect(out.facility_research_omitted).toBe(3)
    const kept = out.trips as Record<string, unknown>[]
    expect(kept.length).toBeGreaterThan(0)
    // 2. 施設ごとに最初の便だけ name・category・priority_rank を持ち、後の便は target_id と matches だけ
    const seen = new Set<unknown>()
    for (const t of kept) {
      const f = (t.nearby_facilities as Record<string, unknown>[])[0]
      if (seen.has(f.target_id)) expect(Object.keys(f).sort()).toEqual(['matches', 'target_id'])
      else expect(f).toMatchObject({ name: expect.any(String), category: '入院設備のある病院', priority_rank: 1 })
      seen.add(f.target_id)
      expect(f.matches).toHaveLength(1)
      // 3・4. hint_texts と via は省き、hints は残す
      expect(t).not.toHaveProperty('hint_texts')
      expect(t).not.toHaveProperty('via')
      expect(t.hints).toEqual(['weekdayOnlyRoute', 'routeWouldVanish', 'nearFacility'])
    }
    // 省いたものの文は1つ。無い hint_texts の言い方を使うよう求める文は外す。ほかの文は残す
    const notes = out.notes as string[]
    const omitted = notes.filter((n) => n.startsWith(OMITTED_NOTE_HEAD))
    expect(omitted).toHaveLength(1)
    for (const part of ['facility_research の後ろから 3 件', '前の便に出た施設の nearby_facilities の target_id・matches 以外', 'hint_texts(', 'via(']) {
      expect(omitted[0]).toContain(part)
    }
    expect(notes).not.toContain(HINT_TEXTS_NOTE)
    expect(notes).toContain('状態の文')
    // 便も省き、数を合わせる
    expect(out.returned).toBe(kept.length)
    expect(kept.length + Number(out.truncated)).toBe(60)
    expect(out.next_offset).toBe(kept.length)
  })

  it('一つ前の段で収まれば、その先は省かない(hint_texts を省けば収まるなら via と便は残す)', () => {
    const trips = Array.from({ length: 30 }, (_, i) => ({
      trip_id: `T${i}`,
      via: ['駅前'],
      hints: ['weekdayOnlyRoute'],
      hint_texts: ['平日だけの系統'.repeat(50)],
    }))
    const out = parse(fitTrips({ status: 'ok', total: 30, offset: 0, returned: 30, omitted_over_limit: 0, next_offset: null, notes: [HINT_TEXTS_NOTE], trips }))
    const kept = out.trips as Record<string, unknown>[]
    expect(kept).toHaveLength(30)
    expect(out).not.toHaveProperty('truncated')
    for (const t of kept) {
      expect(t).not.toHaveProperty('hint_texts')
      expect(t.via).toEqual(['駅前'])
    }
    const omitted = (out.notes as string[]).filter((n) => n.startsWith(OMITTED_NOTE_HEAD))
    expect(omitted).toHaveLength(1)
    expect(omitted[0]).not.toContain('via(')
  })

  describe('先頭の1便だけで 20KB を超えるとき(全部の便を省く)', () => {
    const big = { trip_id: 'BIG_TRIP', headsign: 'あ'.repeat(9000) }
    const small = (i: number) => ({ trip_id: `S${i}`, headsign: '駅前' })

    it('その便を飛ばして next_offset を1つ進め、同じ offset を読み続けないようにする', () => {
      // offset 1 の便が大きい。後ろの便も一緒に省き、続きは offset 2 から(offset 2 からは小さい便なので返せる)
      const text = fitTrips({ status: 'ok', total: 4, offset: 1, returned: 3, omitted_over_limit: 0, next_offset: null, notes: [], trips: [big, small(2), small(3)] })
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
      const out = parse(text)
      expect(out).toMatchObject({ total: 4, offset: 1, returned: 0, truncated: 3, next_offset: 2, trips: [] })
      // offset + returned + truncated + omitted_over_limit = total
      expect(Number(out.offset) + Number(out.returned) + Number(out.truncated) + Number(out.omitted_over_limit)).toBe(out.total)
      const note = String(out.truncated_note)
      expect(note).toContain('offset 1 の便(trip_id BIG_TRIP)は1便だけで 20KB を超える')
      expect(note).toContain('offset を 2 にしてください')
    })

    it('その便が最後なら next_offset は null', () => {
      const out = parse(fitTrips({ status: 'ok', total: 1, offset: 0, returned: 1, omitted_over_limit: 0, next_offset: null, notes: [], trips: [big] }))
      expect(out).toMatchObject({ total: 1, offset: 0, returned: 0, truncated: 1, next_offset: null, trips: [] })
      expect(String(out.truncated_note)).toContain('この便のほかに続きはありません')
    })
  })
})

describe('search_trips', () => {
  it('消える便を手がかりの多い順に返し、到達圏の比較が無ければそう書く', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const r = await runTool('search_trips', { ...SEARCH, limit: 2 }, deps)
    const body = parse(r.content)
    expect(body).toMatchObject({ status: 'ok', scope: 'removed', basis: '承認済みの編集', total: 3, returned: 2, omitted_over_limit: 1 })
    const trips = body.trips as Record<string, unknown>[]
    // R1_0800_WK と R2_0900_WK は手がかりが2つずつで、始発の早い R1 が先(U05 で時間帯を3時間ごとにし、R2 の onlyTripInBand が外れた)
    expect(trips.map((t) => t.trip_id)).toEqual(['R3_0730_WK', 'R1_0800_WK'])
    expect(trips[0]).toEqual({
      feed: 'base',
      trip_id: 'R3_0730_WK',
      route_id: 'R3',
      route_name: '3',
      headsign: '市役所',
      first_stop: '駅前',
      first_departure: '07:30',
      last_stop: '市役所',
      last_arrival: '07:50',
      // 通る停留所は数と、始発・終着を除く主な停留所だけ(結果の大きさを抑える。指摘18.4)
      stop_count: 3,
      via: ['学校前'],
      hints: ['weekdayOnlyRoute', 'routeWouldVanish', 'firstTripOfRoute', 'lastTripOfRoute', 'onlyTripInBand', 'morning'],
      // 判断材料の短い文(画面の名前。hints と同じ並び)と、時間帯・系統の便数(A07)
      hint_texts: ['平日だけの系統', '全曜日で便がなくなる系統', '系統の始発', '系統の終発', '時間帯の便がなくなる(6〜9時)', '朝(6〜9時)'],
      band: { label: '6〜9時', before: 1, after: 0 },
      route_weekday_trips: { before: 1, after: 0 },
    })
    // R1 は 6〜9時に土曜の便が加わるので、時間帯の判断材料は付かない(band は無い)。系統の平日の便数は前 2 便・後 3 便
    expect(trips[1]).toMatchObject({ trip_id: 'R1_0800_WK', route_weekday_trips: { before: 2, after: 3 } })
    expect(trips[1]).not.toHaveProperty('band')
    expect((trips[1].hint_texts as string[]).length).toBe((trips[1].hints as string[]).length)
    // 続きの位置(limit で止めたので、続きは offset 2 から)
    expect(body).toMatchObject({ offset: 0, next_offset: 2 })
    // 「唯一の便」とは書かず hint_texts の言い方を使うよう、notes で伝える
    expect((body.notes as string[]).some((n) => n.includes('「唯一の便」とは書かず、hint_texts の言い方を使ってください'))).toBe(true)
    expect(body.notes).toContain('到達圏の比較がまだないため、到達圏を使う判断材料は出していません。')
    expect((body.notes as string[]).some((n) => n.includes('学校・病院の判断材料(nearFacility・nearby_facilities)も、到達圏の比較ができてから出します'))).toBe(true)
    expect(body).not.toHaveProperty('facility_research')
  })

  it('同じ系統・同じ時間帯の便がすべてなくなるとき、どの便にも band と hint_texts で前後の便数を書き、「唯一」とは書かない(A07)', async () => {
    // R1 の平日 3 便(7:00・7:30・8:00)は、土曜の 12:00 の 1 便に入れ替わる
    const feed = feedOf({
      agency: rowsOf(AGENCY),
      routes: rowsOf('route_id,agency_id,route_short_name,route_long_name,route_type\nR1,1,1,駅前線,3'),
      stops: rowsOf('stop_id,stop_name,stop_lat,stop_lon\nA,駅前,43.76,142.36\nB,市役所,43.77,142.37'),
      calendar: rowsOf(
        'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSA,0,0,0,0,0,1,0,20261001,20261130\nWK,1,1,1,1,1,0,0,20261001,20261130',
      ),
      trips: rowsOf('route_id,service_id,trip_id,trip_headsign\nR1,SA,SA1200,市役所\nR1,WK,WK0700,市役所\nR1,WK,WK0730,市役所\nR1,WK,WK0800,市役所'),
      stop_times: rowsOf(`trip_id,arrival_time,departure_time,stop_id,stop_sequence
SA1200,12:00:00,12:00:00,A,1
SA1200,12:10:00,12:10:00,B,2
WK0700,07:00:00,07:00:00,A,1
WK0700,07:10:00,07:10:00,B,2
WK0730,07:30:00,07:30:00,A,1
WK0730,07:40:00,07:40:00,B,2
WK0800,08:00:00,08:00:00,A,1
WK0800,08:10:00,08:10:00,B,2`),
      feed_info: rowsOf(FEED_INFO),
    })
    const { store, deps } = setup({}, feed)
    await withPolicy(deps, store)
    const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
    const trips = body.trips as { trip_id: string; hints: string[]; hint_texts: string[]; band: unknown; route_weekday_trips: unknown }[]
    expect(trips.map((t) => t.trip_id).sort()).toEqual(['WK0700', 'WK0730', 'WK0800'])
    for (const t of trips) {
      expect(t.hints).toContain('onlyTripInBand')
      expect(t.band).toEqual({ label: '6〜9時', before: 3, after: 0 })
      expect(t.route_weekday_trips).toEqual({ before: 3, after: 1 })
      expect(t.hint_texts).toHaveLength(t.hints.length)
      expect(t.hint_texts[t.hints.indexOf('onlyTripInBand')]).toBe('時間帯の便がなくなる(6〜9時)')
      expect(t.hint_texts.some((x) => x.includes('唯一'))).toBe(false)
    }
    // 識別子の配列は残す
    expect(trips.find((t) => t.trip_id === 'WK0700')!.hints).toContain('firstTripOfRoute')
  })

  it('scope が added のときは判断材料を出さず、hints・hint_texts・band・route_weekday_trips の項目を入れない', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const body = parse((await runTool('search_trips', { ...SEARCH, scope: 'added', limit: 50 }, deps)).content)
    const trips = body.trips as Record<string, unknown>[]
    expect(trips.length).toBeGreaterThan(0)
    for (const t of trips) for (const key of ['hints', 'hint_texts', 'band', 'route_weekday_trips', 'lost_cells', 'nearby_facilities']) expect(t).not.toHaveProperty(key)
    expect((body.notes as string[]).some((n) => n.includes('hint_texts'))).toBe(false)
  })

  it('到達圏の ctx は比べる編集後のフィードで1回だけ受け取り、あれば「比較が無い」とは書かない', async () => {
    // 比較の日付が土曜(平日の便が走らない日)の、空の比較。手がかりは増えないが、比較はある
    const bands = makeBands(3)
    const counts = { counts: new Map<string, number[]>(), skippedBlankTime: 0, skippedBadTime: 0 }
    const empty = { cells: [], classes: [], reachable: bands.map(() => []), coverable: [], usedFallback: false, excludedStops: 0, cellPopulation: [] }
    const ctx = {
      before: counts,
      after: counts,
      bands,
      beforeResult: empty,
      afterResult: empty,
      date: '20261114',
      params: DEFAULT_REACH_PARAMS,
      stops: [],
    } as unknown as RestoreHintContext
    const hintContext = vi.fn(() => ctx)
    const { store, deps } = setup({ hintContext })
    await withPolicy(deps, store)
    const r = await runTool('search_trips', SEARCH, deps)
    expect(hintContext).toHaveBeenCalledTimes(1)
    expect(hintContext).toHaveBeenCalledWith(store.getState().versions[0].feed)
    expect(r.isError).toBe(false)
    expect(parse(r.content).notes).not.toContain('到達圏の比較がまだないため、到達圏を使う判断材料は出していません。')
  })

  it('到達圏の比較があれば、候補の一覧に restoresLostCells・onlyServiceAtStop と戻るセルの数を出す', async () => {
    const setupReach = reachSetup()
    const { store, deps } = setup(
      { hintContext: () => setupReach.ctx, policyServices: () => ({ weekday: 'WK', saturday: 'SA', sundayHoliday: null }) },
      reachBaseFeed(),
    )
    await withPolicy(deps, store, { ...POLICY_INPUT, start_date: '20261101' })
    const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
    const trips = body.trips as { trip_id: string; hints: string[]; lost_cells: { cells: number; population: number } | null }[]
    const b = trips.find((t) => t.trip_id === 'B_0855_WK')!
    expect(b.hints).toContain('restoresLostCells')
    expect(b.hints).toContain('onlyServiceAtStop')
    expect(b.lost_cells).not.toBeNull()
    expect(b.lost_cells!.cells).toBeGreaterThan(0)
    // 手がかりの多い順に並ぶ
    const counts = trips.map((t) => t.hints.length)
    expect(counts).toEqual([...counts].sort((x, y) => y - x))
    expect(body.notes).not.toContain('到達圏の比較がまだないため、到達圏を使う判断材料は出していません。')
    // どの日付・どの時間帯の幅の比較かを書く
    expect(body.notes).toContain('到達圏を使う判断材料(onlyServiceAtStop・restoresLostCells)は、比較する日付 2026/11/04 の減便前後の到達圏の比較から、画面の時間帯の幅(3 時間ごと)で出しています。')
    // 短い文に戻る区画の数は入れない(lost_cells にある)
    expect((trips.find((t) => t.trip_id === 'B_0855_WK') as unknown as { hint_texts: string[] }).hint_texts).toContain('到達圏が戻る')
  })

  describe('学校・病院(nearby_facilities と nearFacility。T19)', () => {
    // smallFeed の S9 学校前 (43.79, 142.39) の北 約 100m の高校と、C 病院前 (43.78, 142.38) の北 約 200m の病院、
    // A 駅前 (43.76, 142.36) の北 約 100m の中学校
    // 窓は、渡さなければ種類の既定の窓(調べた結果からの窓は store/restoreHintContext.ts の hintFacilities が作る)
    const school = (o: Partial<HintFacility> & Pick<HintFacility, 'targetId' | 'name' | 'lat' | 'lon'>): HintFacility => ({
      kind: 'school',
      categoryLabel: '高校・特別支援学校',
      rank: 3,
      radiusM: 400,
      windows: defaultFacilityWindows(o.kind ?? 'school'),
      longBreaks: [],
      ...o,
    })
    const HIGH = school({
      targetId: 'P29:高校',
      name: '学校前高校',
      lat: 43.79 + 100 / 111_000,
      lon: 142.39,
      research: {
        status: 'found',
        checkedAt: '2026-11-03T12:00:00+09:00',
        origin: 'demo',
        facts: [{ label: '始業', value: '8時40分', url: 'https://example.jp/high' }],
      },
    })
    const JUNIOR = school({ targetId: 'P29:中学', name: '駅前中学校', categoryLabel: '中学校', rank: 8, lat: 43.76 + 100 / 111_000, lon: 142.36 })
    const HOSPITAL = school({ targetId: 'P04:病院', name: '病院前病院', kind: 'hospital', categoryLabel: '入院設備のある病院', rank: 1, lat: 43.78 + 200 / 111_000, lon: 142.38 })

    /** 比較の日付が土曜の空の比較に、施設を入れた ctx(到達圏を使う2つは出ない) */
    function ctxWith(facilities: readonly HintFacility[] | undefined): RestoreHintContext {
      const bands = makeBands(3)
      const counts = { counts: new Map<string, number[]>(), skippedBlankTime: 0, skippedInvalidTime: 0, hasFrequencies: false }
      const empty = { cells: [], classes: [], reachable: bands.map(() => []), coverable: [], usedFallback: false, excludedStops: 0, cellPopulation: [] }
      return {
        before: counts,
        after: counts,
        bands,
        beforeResult: empty,
        afterResult: empty,
        date: '20261114',
        params: DEFAULT_REACH_PARAMS,
        stops: [],
        ...(facilities ? { facilities } : {}),
      }
    }

    it('便の停留所の徒歩圏の学校・病院のうち窓に当たるものを、名前・種類・距離・停留所と時刻つきで返し、nearFacility を付ける', async () => {
      const { store, deps } = setup({ hintContext: () => ctxWith([JUNIOR, HIGH, HOSPITAL]) })
      await withPolicy(deps, store)
      const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
      const trips = body.trips as { trip_id: string; hints: string[]; hint_texts: string[]; nearby_facilities?: Record<string, unknown>[] }[]
      const byId = new Map(trips.map((t) => [t.trip_id, t]))

      // R3 は A 07:30 発 → S9 学校前 07:40 → B。高校は始業前(7〜9時着)に当たり、駅前中学校は始発の A の近く(着かない)。
      // 窓に当たらない駅前中学校は、nearby_facilities に入れない
      const r3 = byId.get('R3_0730_WK')!
      expect(r3.hints).toContain('nearFacility')
      expect(r3.hint_texts[r3.hints.indexOf('nearFacility')]).toBe('学校・病院の近く(1 施設)')
      expect(r3.nearby_facilities).toEqual([
        { target_id: 'P29:高校', name: '学校前高校', category: '高校・特別支援学校', priority_rank: 3, matches: ['07:40着 学校前'] },
      ])
      // R2 は C 病院前(終点)に 09:20 に着く:病院の行き(8〜11時着)
      const r2 = byId.get('R2_0900_WK')!
      expect(r2.hints).toContain('nearFacility')
      expect(r2.nearby_facilities!.map((f) => [f.target_id, (f.matches as unknown[]).length])).toEqual([['P04:病院', 1]])
      // R1 は A → B。駅前中学校の徒歩圏は通るが、窓に当たらない:nearby_facilities の項目は無い
      const r1 = byId.get('R1_0800_WK')!
      expect(r1.hints).not.toContain('nearFacility')
      expect(r1).not.toHaveProperty('nearby_facilities')

      // 調べた施設の結果は、施設ごとに1回だけ入れる
      expect(body.facility_research).toEqual([
        {
          target_id: 'P29:高校',
          name: '学校前高校',
          status: 'found',
          checked_at: '2026-11-03T12:00:00+09:00',
          origin: 'demo',
          facts: [{ label: '始業', value: '8時40分', source_url: 'https://example.jp/high' }],
        },
      ])
      expect((body.notes as string[]).some((n) => n.startsWith('nearby_facilities は、便の停留所の徒歩圏にあり'))).toBe(true)
    })

    it('調べた結果から決めた窓の施設には window に窓と根拠を書き、既定の窓の施設には書かない(T27)', async () => {
      // 始業 8:40 の高校:着く窓は 7:40〜8:40(R3 は学校前に 07:40 に着く。窓の始まりちょうどは含む)。下校は既定のまま
      const researchedHigh = { ...HIGH, windows: facilityWindows('school', [{ label: '始業', value: '8時40分' }]) }
      // 名寄市立総合病院の外来受付時間(data/demo/research_dohoku.json)の病院:着く窓は 7:30〜11:30
      const researchedHospital = {
        ...HOSPITAL,
        windows: facilityWindows('hospital', [{ label: '外来受付時間', value: '〔午前〕8：00～11：30 〔午後〕13：00～15：15（公式ページ記載）' }]),
      }
      const { store, deps } = setup({ hintContext: () => ctxWith([researchedHigh, researchedHospital, JUNIOR]) })
      await withPolicy(deps, store)
      const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
      const byId = new Map((body.trips as { trip_id: string; nearby_facilities: Record<string, unknown>[] }[]).map((t) => [t.trip_id, t]))
      const high = byId.get('R3_0730_WK')!.nearby_facilities.find((f) => f.target_id === 'P29:高校')!
      expect(high.matches).toEqual(['07:40着 学校前'])
      expect(high.window).toBe('着 7:40〜8:40(調べた始業 8:40)・発 14:00〜18:00(既定)')
      const hospital = byId.get('R2_0900_WK')!.nearby_facilities.find((f) => f.target_id === 'P04:病院')!
      expect(hospital.window).toBe('着 7:30〜11:30・発 11:30〜17:15(調べた外来の受付 8:00〜11:30・13:00〜15:15)')
      const note = (body.notes as string[]).find((n) => n.startsWith('nearby_facilities は、'))!
      expect(note).toContain('施設ごとの時間帯の窓')
      expect(note).toContain('window のない施設は既定の窓')
    })

    it('B 市役所に 08:10 に着く R1 にも、近くの病院の行き(8〜11時着)で nearFacility を付け、手がかりの多い順に並べる', async () => {
      // 手がかりの数が同じときに優先順位で並べることは、restore.test.ts の compareByHints で確かめている
      const nearB = school({ targetId: 'P04:市役所病院', name: '市役所病院', kind: 'hospital', categoryLabel: '入院設備のある病院', rank: 1, lat: 43.77, lon: 142.37 + 0.001 })
      const { store, deps } = setup({ hintContext: () => ctxWith([nearB]) })
      await withPolicy(deps, store)
      const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
      const trips = body.trips as { trip_id: string; hints: string[] }[]
      expect(trips.find((t) => t.trip_id === 'R1_0800_WK')!.hints).toContain('nearFacility')
      const counts = trips.map((t) => t.hints.length)
      expect(counts).toEqual([...counts].sort((x, y) => y - x))
    })

    it('前提情報の施設を読めていなければ nearby_facilities を入れず、出していない理由を書く', async () => {
      const { store, deps } = setup({ hintContext: () => ctxWith(undefined) })
      await withPolicy(deps, store)
      const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
      for (const t of body.trips as { hints: string[] }[]) {
        expect(t).not.toHaveProperty('nearby_facilities')
        expect(t.hints).not.toContain('nearFacility')
      }
      expect((body.notes as string[]).some((n) => n.includes('学校・病院の参照データを読み込めていない') && n.includes('該当がないという意味ではありません'))).toBe(true)
      expect(body).not.toHaveProperty('facility_research')
    })

    it('施設を読めていて徒歩圏に施設が無い便と、写して入る便(scope added)には nearby_facilities を入れない', async () => {
      const { store, deps } = setup({ hintContext: () => ctxWith([]) })
      await withPolicy(deps, store)
      const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
      for (const t of body.trips as object[]) expect(t).not.toHaveProperty('nearby_facilities')
      expect(body.facility_research).toEqual([])
      const added = parse((await runTool('search_trips', { ...SEARCH, scope: 'added', limit: 50 }, deps)).content)
      for (const t of added.trips as object[]) expect(t).not.toHaveProperty('nearby_facilities')
    })

    it('便ごとの施設は優先順位・距離の順で 1 件にし、窓に当たる施設の数は hint_texts に書く', async () => {
      const many = Array.from({ length: 7 }, (_, i) => school({ targetId: `P29:学校${i}`, name: `学校${i}`, lat: 43.79 + (i * 10) / 111_000, lon: 142.39 }))
      const { store, deps } = setup({ hintContext: () => ctxWith(many) })
      await withPolicy(deps, store)
      const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
      const r3 = (body.trips as { trip_id: string; hints: string[]; hint_texts: string[]; nearby_facilities: unknown[] }[]).find((t) => t.trip_id === 'R3_0730_WK')!
      expect(r3.nearby_facilities).toHaveLength(1)
      expect((r3.nearby_facilities[0] as { target_id: string }).target_id).toBe('P29:学校0')
      expect(r3.hint_texts[r3.hints.indexOf('nearFacility')]).toBe('学校・病院の近く(7 施設)')
      // 1件は名前・種類・優先順位・窓に当たる停留所と時刻だけ(結果の 20KB の上限で便が多く省かれないように小さくする)
      for (const f of r3.nearby_facilities) expect(new TextEncoder().encode(JSON.stringify(f)).length).toBeLessThan(200)
    })

    // 調べた窓の施設は window(窓と根拠の文)が付くので、1件の上限を既定の窓の施設の 250 バイトから 400 バイトに上げる。
    // 根拠の文の範囲は MAX_BASIS_RANGES 件までなので、名前の長い病院(参照データで最も長い施設名と target_id で 100 バイトほど)でも収まる
    const MAX_NEARBY_BYTES_WITH_WINDOW = 400
    /** 名前の長い、調べた受付時間(範囲が3つ)の病院。lat・lon は呼ぶ側で決める */
    const longNamedHospital = (targetId: string, lat: number, lon: number): HintFacility =>
      school({
        targetId,
        name: 'ＪＡ北海道厚生連旭川厚生病院附属外来センター',
        kind: 'hospital',
        categoryLabel: '入院設備のある病院',
        rank: 1,
        lat,
        lon,
        windows: facilityWindows('hospital', [{ label: '一般外来受付時間', value: '初診は7：00～11：30、再診は7：50～11：00、午後は13時30分～15時' }]),
      })

    it('調べた窓の施設(名前が長く、根拠の範囲が3つ)の1件も上限のバイト数に収まる', async () => {
      const hospital = longNamedHospital('P04:長い名前の病院', 43.78 + 200 / 111_000, 142.38)
      const { store, deps } = setup({ hintContext: () => ctxWith([hospital]) })
      await withPolicy(deps, store)
      const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
      const r2 = (body.trips as { trip_id: string; nearby_facilities: Record<string, unknown>[] }[]).find((t) => t.trip_id === 'R2_0900_WK')!
      const item = r2.nearby_facilities.find((f) => f.target_id === 'P04:長い名前の病院')!
      expect(item.window).toBe('着 6:30〜11:30・発 11:30〜17:00(調べた外来の受付 7:00〜11:30・7:50〜11:00・13:30〜15:00)')
      const bytes = new TextEncoder().encode(JSON.stringify(item)).length
      expect(bytes).toBeGreaterThan(200)
      expect(bytes).toBeLessThan(MAX_NEARBY_BYTES_WITH_WINDOW)
    })

    describe('20KB を超えたら、調べた施設の結果を先に省き、便の省いた数と分けて書く', () => {
      /**
       * 平日の便 n 本(便 i は A 07:00 発 → S{i % 3} 学校前{i % 3} 07:10 着。土曜の便とは時刻が違うので、どれも消える便)。
       * 3 つの学校前は約 1.1km ずつ離れ、便ごとの施設(1 件)が便によって違う
       */
      function manyTripsFeed(n: number) {
        const id = (i: number) => `T${String(i).padStart(2, '0')}`
        return feedOf({
          agency: rowsOf(AGENCY),
          routes: rowsOf('route_id,agency_id,route_short_name,route_long_name,route_type\nR3,1,3,学校線,3'),
          stops: rowsOf('stop_id,stop_name,stop_lat,stop_lon\nA,駅前,43.76,142.36\nS9,学校前,43.79,142.39\nS0,学校前0,43.79,142.39\nS1,学校前1,43.8,142.39\nS2,学校前2,43.81,142.39'),
          calendar: rowsOf(
            'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSA,0,0,0,0,0,1,0,20261001,20261130\nWK,1,1,1,1,1,0,0,20261001,20261130',
          ),
          trips: [
            { route_id: 'R3', service_id: 'SA', trip_id: 'SA1', trip_headsign: '学校前' },
            ...Array.from({ length: n }, (_, i) => ({ route_id: 'R3', service_id: 'WK', trip_id: id(i), trip_headsign: '学校前'.repeat(20) })),
          ],
          stop_times: [
            { trip_id: 'SA1', arrival_time: '12:00:00', departure_time: '12:00:00', stop_id: 'A', stop_sequence: '1' },
            { trip_id: 'SA1', arrival_time: '12:10:00', departure_time: '12:10:00', stop_id: 'S9', stop_sequence: '2' },
            ...Array.from({ length: n }, (_, i) => [
              { trip_id: id(i), arrival_time: '07:00:00', departure_time: '07:00:00', stop_id: 'A', stop_sequence: '1' },
              { trip_id: id(i), arrival_time: '07:10:00', departure_time: '07:10:00', stop_id: `S${i % 3}`, stop_sequence: '2' },
            ]).flat(),
          ],
          feed_info: rowsOf(FEED_INFO),
        })
      }
      /**
       * 3 つの学校前のそれぞれの近くの調べた高校(事実の値と出典の URL を長くして、facility_research の1件を 7KB ほどにする。
       * 事実は先頭の 3 件・値は 40 字までに切るので、URL で大きくする)
       */
      const researchedSchools = Array.from({ length: 3 }, (_, i) =>
        school({
          targetId: `P29:調べた${i}`,
          name: `調べた高校${i}`,
          lat: 43.79 + i * 0.01 + 50 / 111_000,
          lon: 142.39,
          research: {
            status: 'found',
            checkedAt: '2026-11-03T12:00:00+09:00',
            origin: 'web',
            facts: Array.from({ length: 30 }, (_, k) => ({ label: `項目${k}`, value: 'あ'.repeat(80), url: `https://example.jp/${i}/${k}/${'x'.repeat(2500)}` })),
          },
        }),
      )

      it('便も省くときは、facility_research_omitted に施設の数、truncated に便の数だけを書く', async () => {
        const { store, deps } = setup({ hintContext: () => ctxWith(researchedSchools) }, manyTripsFeed(50))
        await withPolicy(deps, store)
        const r = await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)
        expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
        const body = parse(r.content)
        // 調べた施設の結果を先に省く
        expect(body.facility_research).toEqual([])
        expect(body.facility_research_omitted).toBe(3)
        // 省いたものは1つの文にまとめる(省くたびに文を足さない)
        const omittedNotes = (body.notes as string[]).filter((n) => n.startsWith('結果を 20KB に収めるため、次を省きました:'))
        expect(omittedNotes).toHaveLength(1)
        expect(omittedNotes[0]).toContain('facility_research の後ろから 3 件(get_research_results で読めます)')
        // 便の省いた数は便だけ(施設の数を足さない)
        const kept = (body.trips as unknown[]).length
        expect(kept).toBeGreaterThan(0)
        // returned は省いた後に trips に入れた便の数
        expect(body.returned).toBe(kept)
        expect(kept + Number(body.truncated)).toBe(50)
        expect(String(body.truncated_note)).toContain(`${50 - kept} 件`)
      })

      it('調べた窓の施設(window つき)が便ごとに付く一覧も 20KB に収め、省いた便の数を書く', async () => {
        // 学校前の近くの名前の長い病院 3 つ。受付 7:00〜 なので着く窓は 6:30〜11:30 で、07:10 着の便すべてに当たる。
        // research は持たせない(facility_research ではなく nearby_facilities の大きさで切り詰めが働くことを確かめる)
        const hospitals = Array.from({ length: 3 }, (_, i) => longNamedHospital(`P04:長い名前の病院${i}`, 43.79 + i * 0.01 + 50 / 111_000, 142.39))
        const { store, deps } = setup({ hintContext: () => ctxWith(hospitals) }, manyTripsFeed(50))
        await withPolicy(deps, store)
        const r = await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)
        expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
        const body = parse(r.content)
        expect(body.facility_research).toEqual([])
        expect(body).not.toHaveProperty('facility_research_omitted')
        const trips = body.trips as { nearby_facilities: Record<string, unknown>[] }[]
        expect(trips.length).toBeGreaterThan(0)
        // 施設ごとに、最初に出た便には window までの全部、同じ結果の後の便には target_id と matches だけを入れる
        const seen = new Set<unknown>()
        for (const t of trips) {
          expect(t.nearby_facilities).toHaveLength(1)
          for (const f of t.nearby_facilities) {
            if (seen.has(f.target_id)) {
              expect(Object.keys(f).sort()).toEqual(['matches', 'target_id'])
            } else {
              seen.add(f.target_id)
              expect(typeof f.window).toBe('string')
              expect(f.name).toBe('ＪＡ北海道厚生連旭川厚生病院附属外来センター')
            }
            expect(new TextEncoder().encode(JSON.stringify(f)).length).toBeLessThan(MAX_NEARBY_BYTES_WITH_WINDOW)
          }
        }
        expect(seen.size).toBe(3)
        expect(body.returned).toBe(trips.length)
        // 便を省いたときだけ truncated を書く(offset + returned + truncated + omitted_over_limit = total)
        const truncated = typeof body.truncated === 'number' ? body.truncated : 0
        expect(trips.length + truncated).toBe(50)
        if (truncated > 0) expect(String(body.truncated_note)).toContain(`${truncated} 件`)
        else expect(body).not.toHaveProperty('truncated')
        const omittedNotes = (body.notes as string[]).filter((n) => n.startsWith('結果を 20KB に収めるため、次を省きました:'))
        expect(omittedNotes).toHaveLength(1)
        expect(omittedNotes[0]).toContain('前の便に出た施設の nearby_facilities の target_id・matches 以外')
      })

      it('調べた施設の結果を省くだけで収まれば、便は省かず truncated を書かない', async () => {
        const { store, deps } = setup({ hintContext: () => ctxWith(researchedSchools) }, manyTripsFeed(3))
        await withPolicy(deps, store)
        const r = await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)
        expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
        const body = parse(r.content)
        expect((body.trips as unknown[]).length).toBe(3)
        expect(body.returned).toBe(3)
        expect(body).not.toHaveProperty('truncated')
        const research = body.facility_research as { target_id: string }[]
        const omitted = Number(body.facility_research_omitted)
        expect(omitted).toBeGreaterThan(0)
        expect(research.length).toBeGreaterThan(0)
        expect(research.length + omitted).toBe(3)
        // 前から残す
        expect(research[0].target_id).toBe('P29:調べた0')
      })
    })
  })

  it('比較の日付が平日ダイヤの運行日でなければ、手がかりが出ないのは「該当なし」ではないと書く', async () => {
    const setupReach = reachSetup()
    // 20261103 は WK の運休日(restore.fixture の calendar_dates)
    const holiday = { ...setupReach.ctx, date: '20261103' }
    const { store, deps } = setup(
      { hintContext: () => holiday, policyServices: () => ({ weekday: 'WK', saturday: 'SA', sundayHoliday: null }) },
      reachBaseFeed(),
    )
    await withPolicy(deps, store, { ...POLICY_INPUT, start_date: '20261101' })
    const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
    const trips = body.trips as { hints: string[]; lost_cells: unknown }[]
    expect(trips.length).toBeGreaterThan(0)
    for (const t of trips) {
      expect(t.hints).not.toContain('restoresLostCells')
      expect(t.hints).not.toContain('onlyServiceAtStop')
      expect(t).not.toHaveProperty('lost_cells')
    }
    const notes = body.notes as string[]
    expect(notes.some((n) => n.includes('比較する日付 2026/11/03 は平日ダイヤの運行日ではない') && n.includes('該当がないという意味ではありません'))).toBe(true)
    expect(notes.some((n) => n.includes('の減便前後の到達圏の比較から出しています'))).toBe(false)
  })

  it('到達圏の計算中なら終わるのを待ってから ctx を読み、待ちきれなければ手がかりを出さずにそう書く', async () => {
    let computing = true
    const listeners = new Set<() => void>()
    const reach: ReachAccess = {
      getState: () => ({ ...IDLE_REACH.getState(), computing }),
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    }
    const hintContext = vi.fn(() => null)
    const { store, deps } = setup({ reach, hintContext, hintWaitMs: 1000 })
    await withPolicy(deps, store)
    const pending = runTool('search_trips', SEARCH, deps)
    await Promise.resolve()
    expect(hintContext).not.toHaveBeenCalled()
    computing = false
    for (const l of listeners) l()
    expect((await pending).isError).toBe(false)
    expect(hintContext).toHaveBeenCalledTimes(1)

    // 終わらない
    computing = true
    const slow = setup({ reach, hintContext: vi.fn(() => null), hintWaitMs: 5 })
    await withPolicy(slow.deps, slow.store)
    const body = parse((await runTool('search_trips', SEARCH, slow.deps)).content)
    expect(body.status).toBe('ok')
    expect(String(body.notes)).toContain('到達圏の計算が終わらなかった')
    expect(slow.deps.hintContext).not.toHaveBeenCalled()
  })

  it('絞り込みで候補が残らなければ、手がかりの索引も ctx も作らない', async () => {
    const hintContext = vi.fn(() => null)
    const { store, deps } = setup({ hintContext })
    await withPolicy(deps, store)
    const body = parse((await runTool('search_trips', { ...SEARCH, stop_name: 'どこにも無い停留所' }, deps)).content)
    expect(body.total).toBe(0)
    expect(hintContext).not.toHaveBeenCalled()
  })

  it('系統・停留所名・始発の時刻で絞る(depart_from を含み depart_to を含まない)', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const ids = async (input: Record<string, unknown>) =>
      ((parse((await runTool('search_trips', { ...SEARCH, limit: 50, ...input }, deps)).content).trips as { trip_id: string }[]).map((t) => t.trip_id))
    expect(await ids({ stop_name: '学校' })).toEqual(['R3_0730_WK'])
    expect(await ids({ route_ids: ['R1', 'R2'] })).toEqual(['R1_0800_WK', 'R2_0900_WK'])
    expect(await ids({ depart_from: '07:30', depart_to: '08:00' })).toEqual(['R3_0730_WK'])
    // 写して入る便は feed が edited
    const added = parse((await runTool('search_trips', { ...SEARCH, scope: 'added', limit: 50 }, deps)).content)
    expect((added.trips as { feed: string; hints?: unknown[] }[]).every((t) => t.feed === 'edited' && t.hints === undefined)).toBe(true)
  })

  it('offset で続きから読み、重ならず漏れなく、最後は next_offset が null になる(指摘18.4)', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const all = parse((await runTool('search_trips', { ...SEARCH, limit: 50 }, deps)).content)
    const order = (all.trips as { trip_id: string }[]).map((t) => t.trip_id)
    expect(all).toMatchObject({ total: 3, offset: 0, returned: 3, omitted_over_limit: 0, next_offset: null })
    const seen: string[] = []
    let offset: number | null = 0
    let calls = 0
    while (offset !== null) {
      const body = parse((await runTool('search_trips', { ...SEARCH, limit: 1, offset }, deps)).content)
      expect(body).toMatchObject({ total: 3, offset, returned: 1, omitted_over_limit: 2 - offset })
      seen.push(...(body.trips as { trip_id: string }[]).map((t) => t.trip_id))
      offset = body.next_offset as number | null
      calls++
      // 項目の説明の notes は最初の回だけ
      expect((body.notes as string[]).includes('項目の説明は offset 0 の結果の notes と同じです(省きました)。')).toBe(calls > 1)
    }
    // 同じ入力なら同じ並び(1件ずつ読んでも、まとめて読んだときと同じ)
    expect(seen).toEqual(order)
    // total 以上の offset は、便を返さずに理由を書く(エラーにしない)
    const past = parse((await runTool('search_trips', { ...SEARCH, offset: 3 }, deps)).content)
    expect(past).toMatchObject({ status: 'ok', total: 3, offset: 3, returned: 0, omitted_over_limit: 0, next_offset: null, trips: [] })
    expect(String(past.notes)).toContain('offset(3)が対象の便の数(3)以上')
  })

  it('hints で、どれか1つの判断材料を持つ便に絞る。total は絞った後の数', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const body = parse((await runTool('search_trips', { ...SEARCH, limit: 50, hints: ['onlyTripInBand', 'weekdayOnlyRoute'] }, deps)).content)
    const trips = body.trips as { trip_id: string; hints: string[] }[]
    expect(body.total).toBe(trips.length)
    expect(trips.map((t) => t.trip_id)).toEqual(['R3_0730_WK'])
    for (const t of trips) expect(t.hints.some((h) => h === 'onlyTripInBand' || h === 'weekdayOnlyRoute')).toBe(true)
    // 空の配列は null と同じ(絞らない。結果も同じ)
    const empty = await runTool('search_trips', { ...SEARCH, limit: 50, hints: [] }, deps)
    expect(empty.isError).toBe(false)
    expect(parse(empty.content).total).toBe(3)
    expect(parse(empty.content)).toEqual(parse((await runTool('search_trips', { ...SEARCH, limit: 50, hints: null }, deps)).content))
    // 判断材料を出さない scope でも、空の配列は null と同じでエラーにしない
    const added = await runTool('search_trips', { ...SEARCH, scope: 'added', limit: 50, hints: [] }, deps)
    expect(added.isError).toBe(false)
    expect(parse(added.content)).toEqual(parse((await runTool('search_trips', { ...SEARCH, scope: 'added', limit: 50, hints: null }, deps)).content))
    // 方針が無ければ判断材料が無いので、hints では絞れない
    const none = setup()
    const r = await runTool('search_trips', { ...SEARCH, scope: 'base_weekday', hints: ['morning'] }, none.deps)
    expect(r.isError).toBe(true)
    expect(String(parse(r.content).message)).toContain('hints では絞れません')
  })

  it('調整役の版 3 が送らない offset・hints は、無ければ null として読む', async () => {
    const { store, deps } = setup()
    await withPolicy(deps, store)
    const legacy = { scope: 'removed', route_ids: null, stop_name: null, depart_from: null, depart_to: null, limit: 2 }
    const r = await runTool('search_trips', legacy, deps)
    expect(r.isError).toBe(false)
    expect(parse(r.content)).toMatchObject({ total: 3, offset: 0, returned: 2, next_offset: 2 })
  })

  it('方針が無ければ base_weekday だけ探せる(平日の service は画面の選択)', async () => {
    const { deps } = setup()
    const removed = await runTool('search_trips', { ...SEARCH, limit: 5 }, deps)
    expect(removed.isError).toBe(true)
    const all = parse((await runTool('search_trips', { ...SEARCH, scope: 'base_weekday', limit: 50 }, deps)).content)
    expect((all.trips as { trip_id: string }[]).map((t) => t.trip_id)).toEqual(['R1_0700_WK', 'R3_0730_WK', 'R1_0800_WK', 'R2_0900_WK'])
  })
})

describe('undo_edit と run_validation', () => {
  it('undo_edit は最後の承認済みの編集を取り消す下書きを作る', async () => {
    const { store, deps } = setup()
    const none = await runTool('undo_edit', {}, deps)
    expect(none.isError).toBe(true)
    await withPolicy(deps, store)
    const r = await runTool('undo_edit', {}, deps)
    expect(r.draft).toEqual({ id: '2', kind: 'undo' })
    expect(parse(r.content)).toMatchObject({ status: 'draft', draft_id: '2', summary: { after: '編集なし(読み込んだ GTFS のまま)' } })
    expect(store.getState().draft?.kind).toBe('undo')
  })

  it('run_validation は下書きがあれば下書きを検証し、出力できるかと、実施日までの注意を返す', async () => {
    const { deps } = setup()
    expect((await runTool('run_validation', {}, deps)).isError).toBe(true)
    await runTool('apply_policy', POLICY_INPUT, deps)
    const body = parse((await runTool('run_validation', {}, deps)).content)
    expect(body).toMatchObject({ status: 'ok', basis: '承認待ちの下書き', draft_id: '1', can_export: true })
    // 今日 11/4、開始 11/9 なので実施まで 5 日
    expect((body.timing as { code: string }[]).map((t) => t.code)).toContain('leadTimeUnder7')
  })
})

describe('summarize_impact', () => {
  function fakeReach(snapshot: ReachSnapshot | null, opts: { finish?: boolean } = {}) {
    let state: ReachView
    const listeners = new Set<() => void>()
    const setState = (patch: Partial<ReachView>) => {
      state = { ...state, ...patch }
      for (const l of listeners) l()
    }
    state = {
      date: '20261110',
      stepHours: 3,
      computing: false,
      error: null,
      snapshot,
      setDate: vi.fn((date: string) => {
        // 日付を変えると計算が始まり、あとで終わる
        setState({ date, computing: true })
        if (opts.finish !== false) setTimeout(() => setState({ computing: false, snapshot: snapshot && { ...snapshot, date } }), 0)
        return null
      }),
      setStepHours: vi.fn(),
    }
    const access: ReachAccess = {
      getState: () => state,
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    }
    return { access, get: () => state }
  }

  const bands = makeBands(3).slice(0, 2)
  const snapshot = {
    date: '20261110',
    stepHours: 3,
    bands,
    departures: { counts: new Map(), bands },
    result: {},
    summary: { bands: [{ unreachableCells: 30, unreachablePopulation: 120.4 }, { unreachableCells: 20, unreachablePopulation: 80 }] },
    params: {},
    origin: {},
    baseline: {
      departures: { counts: new Map(), bands },
      result: {},
      summary: { coverableCells: 200, coverablePopulation: 1000.2, bands: [{ unreachableCells: 10, unreachablePopulation: 40 }, { unreachableCells: 20, unreachablePopulation: 80 }] },
    },
    comparison: {
      bands: [
        { lostCells: 20, lostPopulation: 80.4, gainedCells: 0, gainedPopulation: 0 },
        { lostCells: 0, lostPopulation: 0, gainedCells: 0, gainedPopulation: 0 },
      ],
      dayLostCells: 5,
      dayLostPopulation: 12.6,
    },
    zeroStops: [
      { stopId: 'S9', name: '学校前', beforeDepartures: 1, scope: 'feed' },
      { stopId: 'A', name: '駅前', beforeDepartures: 4, scope: 'day' },
    ],
    zeroRoutes: [{ routeId: 'R3', name: '3', beforeTrips: 1, scope: 'feed' }],
    draft: false,
  } as unknown as ReachSnapshot

  it('日付を画面に渡して計算を待ち、時間帯ごとの前後の数を返す', async () => {
    const reach = fakeReach(snapshot)
    const { store, deps } = setup({ reach: reach.access })
    await withPolicy(deps, store)
    const r = await runTool('summarize_impact', { date: '20261111', step_hours: null }, deps)
    expect(r.isError).toBe(false)
    const body = parse(r.content)
    expect(reach.get().setDate).toHaveBeenCalledWith('20261111')
    expect(body).toMatchObject({
      status: 'ok',
      basis: '承認済みの編集',
      date: '20261111',
      step_hours: 3,
      coverable_cells: 200,
      coverable_population: 1000,
      day_lost_cells: 5,
      day_lost_population: 13,
      zero_service_stops: { count: 2, feed_scope_count: 1 },
      zero_service_routes: [{ route_id: 'R3', name: '3', before_trips: 1, scope: 'feed' }],
      add_back: null,
    })
    expect((body.bands as unknown[])[0]).toEqual({
      band: '6〜9時',
      before: { unreachable_cells: 10, unreachable_percent: '5.0%', unreachable_population: 40 },
      after: { unreachable_cells: 30, unreachable_percent: '15.0%', unreachable_population: 120 },
      lost_cells: 20,
      lost_population: 80,
      gained_cells: 0,
      gained_population: 0,
    })
  })

  it('編集が無ければ、比べるものが無いとエラーにする', async () => {
    const reach = fakeReach(snapshot)
    const { deps } = setup({ reach: reach.access })
    const r = await runTool('summarize_impact', { date: null, step_hours: null }, deps)
    expect(r.isError).toBe(true)
  })

  it('計算が終わらなければエラーにし、止めた(signal)なら AbortError で止まる', async () => {
    const reach = fakeReach(snapshot, { finish: false })
    const { store, deps } = setup({ reach: reach.access, reachTimeoutMs: 5 })
    await withPolicy(deps, store)
    const late = await runTool('summarize_impact', { date: '20261111', step_hours: null }, deps)
    expect(late.isError).toBe(true)
    expect(String(parse(late.content).message)).toContain('到達圏の計算が終わりませんでした')
    const ctrl = new AbortController()
    const pending = runTool('summarize_impact', { date: '20261112', step_hours: null }, { ...deps, reachTimeoutMs: 60_000 }, ctrl.signal)
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  describe('往復(round_trip)と学校・病院に着く便(facility_access)。A07', () => {
    /** R1 の平日は 駅前 → 市役所 7:00 と 市役所 → 駅前 17:00 の往復。土曜は 駅前 → 市役所 7:00 だけ(平日の行きと同じ時刻) */
    function roundTripFeed() {
      return feedOf({
        agency: rowsOf(AGENCY),
        routes: rowsOf('route_id,agency_id,route_short_name,route_long_name,route_type\nR1,1,1,駅前線,3'),
        stops: rowsOf('stop_id,stop_name,stop_lat,stop_lon\nA,駅前,43.76,142.36\nB,市役所,43.77,142.37\nB2,市役所 ,43.7701,142.3701'),
        calendar: rowsOf(
          'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSA,0,0,0,0,0,1,0,20261001,20261130\nWK,1,1,1,1,1,0,0,20261001,20261130',
        ),
        trips: rowsOf('route_id,service_id,trip_id,trip_headsign\nR1,SA,SA0700,市役所\nR1,WK,WK0700,市役所\nR1,WK,WK1700,駅前'),
        stop_times: rowsOf(`trip_id,arrival_time,departure_time,stop_id,stop_sequence
SA0700,07:00:00,07:00:00,A,1
SA0700,07:10:00,07:10:00,B,2
WK0700,07:00:00,07:00:00,A,1
WK0700,07:10:00,07:10:00,B,2
WK1700,17:00:00,17:00:00,B2,1
WK1700,17:10:00,17:10:00,A,2`),
        feed_info: rowsOf(FEED_INFO),
      })
    }

    /** smallFeed の S9 学校前 (43.79, 142.39) の北 約 100m の高校(窓は既定の 7〜9時着・14〜18時発) */
    const HIGH: HintFacility = {
      targetId: 'P29:高校',
      name: '学校前高校',
      kind: 'school',
      categoryLabel: '高校・特別支援学校',
      rank: 3,
      lat: 43.79 + 100 / 111_000,
      lon: 142.39,
      radiusM: 400,
      windows: defaultFacilityWindows('school'),
      longBreaks: [],
    }
    /** facility_access は ctx の facilities だけを読む */
    const ctxOf = (facilities?: readonly HintFacility[]) => ({ ...(facilities ? { facilities } : {}) }) as unknown as RestoreHintContext

    it('方向ごとの問題の件数と、上位の問題に系統・方向・前後の始発と終発、逆向きの無い系統の数を返す', async () => {
      const reach = fakeReach(snapshot)
      const { store, deps } = setup({ reach: reach.access }, roundTripFeed())
      await withPolicy(deps, store)
      const body = parse((await runTool('summarize_impact', { date: null, step_hours: null }, deps)).content)
      const rt = body.round_trip as Record<string, unknown>
      expect(rt).toMatchObject({
        date: '20261110',
        empty_reason: null,
        windows: { morning: '6:00〜9:00', evening: '15:00〜21:00', shift_min: 30 },
        counts: { direction_vanishes: 1, no_return: 1, last_earlier: 0, first_later: 0 },
        routes: { with_reverse: 1, same_route: 1, other_route: 0, no_reverse: 0, after_only: 0 },
        problems_omitted: 0,
      })
      const problems = rt.problems as Record<string, unknown>[]
      expect(problems).toEqual([
        {
          kind: 'directionVanishes',
          label: '方向の便がなくなる',
          route_id: 'R1',
          route_name: '1',
          from: '市役所',
          to: '駅前',
          before: { trips: 1, first: '17:00', last: '17:00' },
          after: { trips: 0, first: null, last: null },
        },
        {
          kind: 'noReturn',
          label: '帰りの便がない',
          route_id: 'R1',
          route_name: '1',
          from: '駅前',
          to: '市役所',
          before: { trips: 1, first: '07:00', last: '07:00' },
          after: { trips: 1, first: '07:00', last: '07:00' },
          return_trips: { route_ids: ['R1'], evening_before: 1, evening_after: 0 },
        },
      ])
      expect((body.notes as string[]).some((n) => n.startsWith('round_trip は'))).toBe(true)
    })

    it('逆向きの無い系統は no_reverse の数だけを返す(smallFeed はどの系統も片道)', async () => {
      const reach = fakeReach(snapshot)
      const { store, deps } = setup({ reach: reach.access })
      await withPolicy(deps, store)
      const rt = parse((await runTool('summarize_impact', { date: null, step_hours: null }, deps)).content).round_trip as Record<string, unknown>
      expect(rt.problems).toEqual([])
      expect((rt.routes as Record<string, number>).no_reverse).toBe(3)
    })

    it('学校・病院ごとに着く便・出る便が 0 便になる施設を、窓・出どころ・前後の便数つきで返す', async () => {
      const reach = fakeReach(snapshot)
      const { store, deps } = setup({ reach: reach.access, hintContext: () => ctxOf([HIGH]) })
      await withPolicy(deps, store)
      const body = parse((await runTool('summarize_impact', { date: null, step_hours: null }, deps)).content)
      expect(body).not.toHaveProperty('facility_access_unavailable')
      // R3 は 07:40 に学校前で降りられる(既定の 7〜9時着)。土曜ダイヤに R3 は無いので、着く便が 0 便になる
      expect(body.facility_access).toEqual({
        date: '20261110',
        counts: { arrive_lost: 1, depart_lost: 0 },
        facilities_with_stops: 1,
        facilities_without_stops: 0,
        facilities: [
          {
            target_id: 'P29:高校',
            name: '学校前高校',
            category: '高校・特別支援学校',
            priority_rank: 3,
            nearest_stop: '学校前',
            distance_m: expect.any(Number),
            problems: ['着く便がなくなる'],
            arrive: { window: '7:00〜9:00', source: 'default', before: { trips: 1, time: '07:40' }, after: { trips: 0, time: null } },
            depart: { window: '14:00〜18:00', source: 'default', before: { trips: 0, time: null }, after: { trips: 0, time: null } },
          },
        ],
        facilities_omitted: 0,
      })
      // 数え方の注意は notes に1回だけ書く(facility_access.note と重ねない)
      const notes = body.notes as string[]
      expect(notes.filter((n) => n.includes('乗り継ぎ'))).toHaveLength(1)
      expect(notes.find((n) => n.startsWith('facility_access は'))).toContain('窓は始業・外来の受付などに間に合う時間帯の目安')
    })

    it('調べた窓の施設は、読んだ時刻と出典の URL を書く', async () => {
      const facts = [{ label: '始業', value: '8時40分', url: 'https://example.jp/high' }]
      const researched: HintFacility = {
        ...HIGH,
        windows: facilityWindows('school', facts),
        research: { status: 'found', checkedAt: '2026-11-03T12:00:00+09:00', origin: 'demo', facts },
      }
      const reach = fakeReach(snapshot)
      const { store, deps } = setup({ reach: reach.access, hintContext: () => ctxOf([researched]) })
      await withPolicy(deps, store)
      const fa = parse((await runTool('summarize_impact', { date: null, step_hours: null }, deps)).content).facility_access as {
        facilities: { arrive: Record<string, unknown> }[]
      }
      expect(fa.facilities[0].arrive).toMatchObject({ source: 'research', basis: expect.stringContaining('8:40'), source_url: 'https://example.jp/high' })
    })

    it('施設を読めていない・比べられない・平日ダイヤが走らない日は、facility_access を null にして理由を書く', async () => {
      const cases: [Partial<ToolDeps>, ReachSnapshot, string][] = [
        [{}, snapshot, '到達圏の比較と今の減便後の GTFS が合っていない'],
        [{ hintContext: () => ctxOf(undefined) }, snapshot, '学校・病院の参照データを読み込めていない'],
        // 20261114 は土曜
        [{ hintContext: () => ctxOf([HIGH]) }, { ...snapshot, date: '20261114' } as ReachSnapshot, '平日ダイヤの運行日ではない'],
      ]
      for (const [overrides, snap, reason] of cases) {
        const reach = fakeReach(snap)
        const { store, deps } = setup({ reach: reach.access, ...overrides })
        await withPolicy(deps, store)
        const body = parse((await runTool('summarize_impact', { date: null, step_hours: null }, deps)).content)
        expect(body.facility_access).toBeNull()
        expect(String(body.facility_access_unavailable)).toContain(reason)
      }
      // 平日ダイヤが走らない日は、往復も理由つきで空にする
      const reach = fakeReach({ ...snapshot, date: '20261114' } as ReachSnapshot)
      const { store, deps } = setup({ reach: reach.access })
      await withPolicy(deps, store)
      const rt = parse((await runTool('summarize_impact', { date: null, step_hours: null }, deps)).content).round_trip as Record<string, unknown>
      expect(String(rt.empty_reason)).toContain('平日ダイヤが走らない')
      expect(rt.problems).toEqual([])
    })

    it('元に戻す下書きで減便前に戻るときも、承認済みの方針の平日ダイヤで、比較する日付に平日ダイヤが走るかを確かめる(画面と同じ)', async () => {
      // 20261114 は土曜。平日ダイヤが走らないので、学校・病院は確かめず、往復も理由つきで空にする
      const reach = fakeReach({ ...snapshot, date: '20261114' } as ReachSnapshot)
      const { store, deps } = setup({ reach: reach.access, hintContext: () => ctxOf([HIGH]) })
      await withPolicy(deps, store)
      expect((await runTool('undo_edit', {}, deps)).isError).toBe(false)
      const body = parse((await runTool('summarize_impact', { date: null, step_hours: null }, deps)).content)
      expect(body).toMatchObject({ status: 'ok', basis: '承認待ちの下書き' })
      expect(body.facility_access).toBeNull()
      expect(String(body.facility_access_unavailable)).toContain('平日ダイヤの運行日ではない')
      const rt = body.round_trip as Record<string, unknown>
      expect(String(rt.empty_reason)).toContain('平日ダイヤが走らない')
    })
  })

  describe('要る運転士の数(drivers。D06)', () => {
    it('減便の前後の営業運行時間と勤務の数(目安)、欠員との判定、使った仮定を返す', async () => {
      const reach = fakeReach(snapshot)
      const drivers = () => ({ params: { ...DUTY_DEFAULTS }, places: [], shortage: 1 })
      const { store, deps } = setup({ reach: reach.access, drivers })
      await withPolicy(deps, store)
      const body = parse((await runTool('summarize_impact', { date: null, step_hours: null }, deps)).content)
      const d = body.drivers as Record<string, unknown>
      // 画面の欄と同じ計算(store/drivers.ts の compareDrivers)
      const expected = compareDrivers({
        base: store.getState().base!.feed,
        edited: { feed: store.getState().versions[0].feed, draft: false },
        date: '20261110',
        weekdayServices: new Set(['WK']),
        params: { ...DUTY_DEFAULTS },
        places: [],
        shortage: 1,
      })
      expect(d).toMatchObject({
        date: '20261110',
        draft: false,
        service_hours: {
          before_min: expected.before.hours.serviceMinutes,
          after_min: expected.after!.hours.serviceMinutes,
          reduction_min: expected.hours!.reduction.serviceMinutes,
        },
        duties: { before: expected.before.duties.dutyCount, after: expected.after!.duties.dutyCount, diff: expected.dutyDiff },
        shortage: 1,
        places: 0,
      })
      expect((d.verdict as { kind: string }).kind).toBe(expected.verdict.kind === 'enough' ? 'enough' : 'short')
      expect(d.assumptions).toEqual(expected.assumptions)
      expect((body.notes as string[]).some((n) => n.startsWith('drivers は') && n.includes('目安'))).toBe(true)
    })

    it('比較する日付に平日ダイヤが走らなければ not_weekday、欠員を入れていなければ no_shortage', async () => {
      const saturday = fakeReach({ ...snapshot, date: '20261114' } as ReachSnapshot)
      const a = setup({ reach: saturday.access, drivers: () => ({ params: { ...DUTY_DEFAULTS }, places: [], shortage: 3 }) })
      await withPolicy(a.deps, a.store)
      const d1 = parse((await runTool('summarize_impact', { date: null, step_hours: null }, a.deps)).content).drivers as { verdict: unknown }
      expect(d1.verdict).toEqual({ kind: 'not_weekday' })
      const b = setup({ reach: fakeReach(snapshot).access, drivers: () => ({ params: { ...DUTY_DEFAULTS }, places: [], shortage: null }) })
      await withPolicy(b.deps, b.store)
      const d2 = parse((await runTool('summarize_impact', { date: null, step_hours: null }, b.deps)).content).drivers as { verdict: { kind: string } }
      expect(d2.verdict.kind).toBe('no_shortage')
    })

    it('営業所を置いたとき、places は数(営業所の数)だけにし、assumptions にも営業所の名前を入れない(F02)', async () => {
      const NAMES = ['秘匿の営業所T', '秘匿の出張所T', '秘匿の本社T']
      const places: DutyPlace[] = [
        { name: NAMES[0], lat: 43.76, lon: 142.36 },
        { name: NAMES[1], lat: 43.77, lon: 142.36 },
        { name: NAMES[2], lat: 43.76, lon: 142.37 },
      ]
      const { store, deps } = setup({ reach: fakeReach(snapshot).access, drivers: () => ({ params: { ...DUTY_DEFAULTS }, places, shortage: 1 }) })
      await withPolicy(deps, store)
      const r = await runTool('summarize_impact', { date: null, step_hours: null }, deps)
      const d = parse(r.content).drivers as { places: unknown; assumptions: string[] }
      expect(d.places).toBe(3)
      // 営業所は 3 か所と、数だけを書く
      expect(d.assumptions.some((a) => a.includes('営業所(3 か所)'))).toBe(true)
      expect(d.assumptions.join('\n')).not.toMatch(/車庫|休憩施設/)
      for (const name of NAMES) expect(r.content).not.toContain(name)
    })

    it('在籍の運転士の数を入れたときだけ roster_check を足し、その意味を notes で伝える。場所の名前は送らない', async () => {
      const NAME = '秘匿の営業所R'
      const places: DutyPlace[] = [{ name: NAME, lat: 43.76, lon: 142.36 }]
      const without = setup({ reach: fakeReach(snapshot).access, drivers: () => ({ params: { ...DUTY_DEFAULTS }, places, shortage: 1 }) })
      await withPolicy(without.deps, without.store)
      const b0 = parse((await runTool('summarize_impact', { date: null, step_hours: null }, without.deps)).content)
      expect((b0.drivers as Record<string, unknown>).roster_check).toBeUndefined()
      expect((b0.notes as string[]).some((n) => n.startsWith('drivers.roster_check'))).toBe(false)

      const { store, deps } = setup({ reach: fakeReach(snapshot).access, drivers: () => ({ params: { ...DUTY_DEFAULTS }, places, shortage: 1, roster: 3 }) })
      await withPolicy(deps, store)
      const r = await runTool('summarize_impact', { date: null, step_hours: null }, deps)
      const body = parse(r.content)
      const d = body.drivers as { duties: { after: number }; verdict: unknown; roster_check: Record<string, unknown> }
      expect(d.roster_check).toEqual({
        roster: 3,
        available: 2,
        shortage_over_roster: false,
        needed_duties: d.duties.after,
        needed_basis: 'after',
        over: Math.max(0, d.duties.after - 2),
      })
      // 主な判定は在籍に関係なく、減る勤務の数と欠員の比較のまま
      expect(d.verdict).toEqual((b0.drivers as { verdict: unknown }).verdict)
      expect((body.notes as string[]).some((n) => n.startsWith('drivers.roster_check') && n.includes('下限の目安'))).toBe(true)
      expect(r.content).not.toContain(NAME)
    })

    it('20KB を超えたら、ほかの一覧より先に facility_access → round_trip の一覧を後ろから省き、省いた数を書く(fitImpactLists)', () => {
      const big = (i: number) => ({ name: `施設${i}`, filler: 'あ'.repeat(300) })
      const body = {
        status: 'ok',
        zero_service_routes: Array.from({ length: 5 }, (_, i) => ({ route_id: `R${i}` })),
        round_trip: { counts: {}, problems: Array.from({ length: MAX_IMPACT_ITEMS }, (_, i) => big(i)), problems_omitted: 4 },
        facility_access: { counts: {}, facilities: Array.from({ length: MAX_IMPACT_ITEMS }, (_, i) => big(i)), facilities_omitted: 0 },
        notes: ['元の注意'],
      }
      // 1つの一覧(約 18KB)を省けば収まる:facility_access だけを省く
      const fitted = fitImpactLists(body)
      expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
      const fa = fitted.facility_access as { facilities: unknown[]; facilities_omitted: number }
      const rt = fitted.round_trip as { problems: unknown[]; problems_omitted: number }
      expect(fa.facilities.length).toBeLessThan(MAX_IMPACT_ITEMS)
      expect(fa.facilities_omitted).toBe(MAX_IMPACT_ITEMS - fa.facilities.length)
      expect(rt.problems).toHaveLength(MAX_IMPACT_ITEMS)
      expect(rt.problems_omitted).toBe(4)
      expect(fitted.zero_service_routes).toHaveLength(5)
      expect(fitted.notes).toEqual([
        '元の注意',
        `結果が 20KB を超えたため、facility_access.facilities の後ろから ${MAX_IMPACT_ITEMS - fa.facilities.length} 件を省きました(省いた数は facilities_omitted に含めています)。`,
      ])
      // 前から残す
      expect((fa.facilities[0] as { name: string }).name).toBe('施設0')

      // 2つとも大きければ、facility_access を空にしてから round_trip を省く(省いた数は、上位 20 件の外の数に足す)
      const huge = (i: number) => ({ name: `施設${i}`, filler: 'あ'.repeat(600) })
      const both = fitImpactLists({
        ...body,
        round_trip: { ...body.round_trip, problems: Array.from({ length: MAX_IMPACT_ITEMS }, (_, i) => huge(i)) },
        facility_access: { ...body.facility_access, facilities: Array.from({ length: MAX_IMPACT_ITEMS }, (_, i) => huge(i)) },
      })
      expect(new TextEncoder().encode(JSON.stringify(both)).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
      const fa2 = both.facility_access as { facilities: unknown[]; facilities_omitted: number }
      const rt2 = both.round_trip as { problems: unknown[]; problems_omitted: number }
      expect(fa2.facilities).toEqual([])
      expect(fa2.facilities_omitted).toBe(MAX_IMPACT_ITEMS)
      expect(rt2.problems.length).toBeGreaterThan(0)
      expect(rt2.problems_omitted).toBe(4 + MAX_IMPACT_ITEMS - rt2.problems.length)
      expect(both.zero_service_routes).toHaveLength(5)
      expect((both.notes as string[]).length).toBe(3)

      // 20KB 以下ならそのまま
      const small = { ...body, round_trip: { problems: [] }, facility_access: null }
      expect(fitImpactLists(small)).toBe(small)
    })
  })
})

describe('判断材料の短い文(shortHintText。search_trips の hint_texts)', () => {
  const detail = (o: Partial<RestoreHintDetail> = {}): RestoreHintDetail => ({
    hints: [],
    lostCells: null,
    band: null,
    routeTrips: { before: 2, after: 0 },
    ...o,
  })
  /** 窓に当たった時刻の数が matched の施設(matched が 0 なら徒歩圏にあるだけ) */
  const near = (matched: number): NearFacility => ({
    facility: { targetId: 'P29:x', name: '高校' } as HintFacility,
    stopId: 'S',
    stopName: '学校前',
    distanceM: 120,
    matches: Array.from({ length: matched }, () => ({ timing: 'arrive' as const, stopId: 'S', stopName: '学校前', time: '07:40', distanceM: 120 })),
  })

  it('onlyTripInBand は、band があれば時間帯を括弧に入れ、無ければ名前だけ', () => {
    expect(shortHintText('onlyTripInBand', detail({ band: { label: '6〜9時', before: 2, after: 0 } }))).toBe('時間帯の便がなくなる(6〜9時)')
    expect(shortHintText('onlyTripInBand', detail())).toBe('時間帯の便がなくなる')
  })

  it('nearFacility は、窓に当たる施設の数を括弧に入れる(窓に当たらない施設は数えない。0 なら名前だけ)', () => {
    expect(shortHintText('nearFacility', detail())).toBe('学校・病院の近く')
    expect(shortHintText('nearFacility', detail({ facilities: [] }))).toBe('学校・病院の近く')
    expect(shortHintText('nearFacility', detail({ facilities: [near(0)] }))).toBe('学校・病院の近く')
    expect(shortHintText('nearFacility', detail({ facilities: [near(1), near(0)] }))).toBe('学校・病院の近く(1 施設)')
    expect(shortHintText('nearFacility', detail({ facilities: [near(1), near(2), near(0), near(1)] }))).toBe('学校・病院の近く(3 施設)')
  })

  it('ほかの判断材料は、画面の名前だけ(数を添えない。「唯一」と書かない)', () => {
    const d = detail({ band: { label: '6〜9時', before: 1, after: 0 }, lostCells: { cells: 3, population: 10 }, facilities: [near(1)] })
    const expected: Record<string, string> = {
      weekdayOnlyRoute: '平日だけの系統',
      routeWouldVanish: '全曜日で便がなくなる系統',
      firstTripOfRoute: '系統の始発',
      lastTripOfRoute: '系統の終発',
      morning: '朝(6〜9時)',
      evening: '夕方・夜(15〜21時)',
      onlyServiceAtStop: '停留所の発車がなくなる',
      restoresLostCells: '到達圏が戻る',
    }
    for (const [hint, text] of Object.entries(expected)) {
      const got = shortHintText(hint as RestoreHintDetail['hints'][number], d)
      expect(got).toBe(text)
      expect(got).not.toContain('唯一')
    }
  })
})
