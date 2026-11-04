import { afterEach, describe, expect, it, vi } from 'vitest'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { featuresOf, feedFrom, kyotoLike, svc } from '@/gtfs/groups/groups.fixture'
import { proposeGroups } from '@/gtfs/groups/rules'
import type { JevJudgeRequest, JevJudgeResponse, JevOutcome, JevStatus, JevTargetResult, ServiceGroups } from '@/gtfs/groups/types'
import type { GtfsFeed } from '@/gtfs/load'
import { useGtfsStore } from './gtfs'
import type { HolidayState } from './holidays'
import { resetAll } from './reset'
import { attentionCount } from '@/components/steps/load/serviceGroupsText'
import { createServiceGroupsStore, useServiceGroupsStore } from './serviceGroups'

const SAT: PolicyKind = 'weekdayToSaturday'
const FEED = { tables: new Map(), warnings: [] } as GtfsFeed
const AVAILABLE: JevStatus = { available: true, provider: 'TypeSafe AI Jev', via: 'Vercel AI Gateway', reason: null }

/** 外から解決できる Promise */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

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

function result(serviceId: string, role: JevTargetResult['role'], extra: Partial<JevTargetResult> = {}): JevTargetResult {
  return { serviceId, role, provider: 'typesafe-ai', sent: { state: { target: serviceId }, questions: { q: 1 } }, ...extra }
}

function response(results: JevTargetResult[], failures: JevJudgeResponse['failures'] = []): JevJudgeResponse {
  return { model: 'typesafe-ai/jev', results, failures, usage: { inputTokens: 100, costUsd: 0.0004 } }
}

function setup(opts: { groups?: () => ServiceGroups; holidays?: HolidayState; status?: JevStatus; judge?: (r: JevJudgeRequest) => Promise<JevOutcome> } = {}) {
  let holidays: HolidayState = opts.holidays ?? { status: 'missing' }
  const compute = vi.fn((_feed: GtfsFeed, _list: unknown) => (opts.groups ?? (() => proposeGroups(kyotoLike())))())
  const fetchStatus = vi.fn(async (_signal: AbortSignal) => opts.status ?? AVAILABLE)
  const judge = vi.fn(async (r: JevJudgeRequest, _signal: AbortSignal): Promise<JevOutcome> =>
    opts.judge ? opts.judge(r) : { ok: true, response: response([]) },
  )
  const store = createServiceGroupsStore({ holidays: () => holidays, compute, fetchStatus, judge })
  return {
    store,
    compute,
    fetchStatus,
    judge,
    setHolidays(h: HolidayState) {
      holidays = h
      store.getState().holidaysChanged()
    },
  }
}

/** 問い合わせが落ち着くまで待つ */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** 読み込んで、Jev に送るかを聞かれたら「Jev に送る」と答える */
async function startAndAccept(t: ReturnType<typeof setup>) {
  t.store.getState().start(FEED)
  expect(t.store.getState().jev.state).toBe('awaitingConsent')
  void t.store.getState().acceptJev()
  await settle()
}

describe('計算の時機', () => {
  it('祝日一覧を待ってから1回だけ計算する', async () => {
    const t = setup({ holidays: { status: 'loading' } })
    t.store.getState().start(FEED)
    expect(t.store.getState().status).toBe('waitingHolidays')
    expect(t.compute).not.toHaveBeenCalled()

    const list = { names: new Map(), first: '20260101', coveredUntil: '20271231', source: '' }
    t.setHolidays({ status: 'ready', list })
    expect(t.compute).toHaveBeenCalledTimes(1)
    expect(t.compute.mock.calls[0][1]).toBe(list)
    expect(t.store.getState().status).toBe('ready')
    // 後から祝日一覧が変わっても計算し直さない
    t.setHolidays({ status: 'error', message: 'x' })
    expect(t.compute).toHaveBeenCalledTimes(1)
  })

  it('祝日一覧が読めなかったら、祝日一覧なしで計算する', () => {
    const t = setup({ holidays: { status: 'error', message: '失敗' } })
    t.store.getState().start(FEED)
    expect(t.compute.mock.calls[0][1]).toBeNull()
  })
})

describe('単純な GTFS', () => {
  it('Jev を呼ばず(サーバーにも聞かない)、読み込んだ時点で確定', async () => {
    const t = setup({ groups: () => proposeGroups(featuresOf([svc('01', { weekday: 98 }), svc('03', { saturday: 19 }), svc('06', { sundayHoliday: 25 })])) })
    t.store.getState().start(FEED)
    await settle()
    const s = t.store.getState()
    expect(s.groups?.simple).toBe(true)
    expect(s.confirmed).toBe(true)
    expect(s.jev.state).toBe('notNeeded')
    expect(t.fetchStatus).not.toHaveBeenCalled()
    expect(t.judge).not.toHaveBeenCalled()
  })
})

describe('Jev に送るかを聞く', () => {
  it('単純でない GTFS では、答えの前にサーバーに聞かず・送らない。問う service の数と、上限で問わない service を持つ', async () => {
    const t = setup()
    t.store.getState().start(FEED)
    await settle()
    const s = t.store.getState()
    expect(s.jev.state).toBe('awaitingConsent')
    expect(s.jev.sent).toBe(false)
    expect(s.jev.asking).toBeGreaterThan(0)
    expect(s.jev.message).toBeNull()
    expect(t.fetchStatus).not.toHaveBeenCalled()
    expect(t.judge).not.toHaveBeenCalled()
    // 送った judge の targets の service の数と同じ
    void t.store.getState().acceptJev()
    await settle()
    const sentIds = new Set(t.judge.mock.calls[0][0].targets.map((x) => x.serviceId))
    expect(t.store.getState().jev.asking).toBe(sentIds.size)
  })

  it('「Jev に送る」と答えたら、使えるかを確かめてから送る(checking → sending)', async () => {
    const d = deferred<JevOutcome>()
    const t = setup({ judge: () => d.promise })
    t.store.getState().start(FEED)
    void t.store.getState().acceptJev()
    // 答えたらすぐ checking にする(サーバーに聞く前)
    expect(t.store.getState().jev.state).toBe('checking')
    await settle()
    expect(t.fetchStatus).toHaveBeenCalledTimes(1)
    expect(t.judge).toHaveBeenCalledTimes(1)
    expect(t.store.getState().jev.state).toBe('sending')
    expect(t.store.getState().jev.sent).toBe(true)
    // 送ったあとに「送らない」が来ても(AlertDialog が閉じたときの onOpenChange)、何もしない
    t.store.getState().declineJev()
    expect(t.store.getState().jev.state).toBe('sending')
  })

  it('「送らずに規則だけで進める」と答えたら、送らずに off にする。あとからボタンで頼めば送る', async () => {
    const t = setup()
    t.store.getState().start(FEED)
    t.store.getState().declineJev()
    await settle()
    const s = t.store.getState()
    expect(s.jev.state).toBe('off')
    expect(s.jev.message).toBe('Jev に送らず、規則だけで分けました。')
    expect(s.jev.sent).toBe(false)
    expect(t.fetchStatus).not.toHaveBeenCalled()
    expect(t.judge).not.toHaveBeenCalled()
    // 断ったあとに acceptJev が来ても送らない(答えは1回だけ)
    await t.store.getState().acceptJev()
    expect(t.judge).not.toHaveBeenCalled()

    await t.store.getState().askJev()
    expect(t.fetchStatus).toHaveBeenCalledTimes(1)
    expect(t.judge).toHaveBeenCalledTimes(1)
  })

  it('聞いている間も、ボタン(askJev)で頼めば送る', async () => {
    const t = setup()
    t.store.getState().start(FEED)
    await t.store.getState().askJev()
    expect(t.judge).toHaveBeenCalledTimes(1)
  })

  it('聞いている間に読み込み直し・削除(reset)したら、何も送らない', async () => {
    const t = setup()
    t.store.getState().start(FEED)
    expect(t.store.getState().jev.state).toBe('awaitingConsent')
    t.store.getState().reset()
    expect(t.store.getState().jev.state).toBe('idle')
    // 閉じたダイアログの答えが遅れて来ても送らない
    await t.store.getState().acceptJev()
    t.store.getState().declineJev()
    await settle()
    expect(t.fetchStatus).not.toHaveBeenCalled()
    expect(t.judge).not.toHaveBeenCalled()
    expect(t.store.getState().jev.state).toBe('idle')
  })

  it('聞いている間は確定できない', () => {
    const t = setup()
    t.store.getState().start(FEED)
    expect(t.store.getState().confirm()).toBe(false)
  })

  it('規則で決まらない service が無ければ、聞かずに notNeeded', async () => {
    const t = setup({ groups: () => proposeGroups(featuresOf([svc('01', { weekday: 98 }), svc('03', { saturday: 19 }), svc('06', { sundayHoliday: 25 })])) })
    t.store.getState().start(FEED)
    await t.store.getState().acceptJev()
    expect(t.store.getState().jev.state).toBe('notNeeded')
    expect(t.judge).not.toHaveBeenCalled()
  })
})

describe('Jev の呼び出し(送ると答えたあと)', () => {
  it('単純でない GTFS では、使えるかを確かめてから送り、答えを合わせる', async () => {
    const res = response([result('03001_A', 'saturday', { weekdayCounterpart: { choice: '01001_A', probabilities: { '01001_A': 0.95 }, confidence: 0.95 } })])
    const t = setup({ judge: async () => ({ ok: true, response: res }) })
    await startAndAccept(t)
    expect(t.fetchStatus).toHaveBeenCalledTimes(1)
    expect(t.judge).toHaveBeenCalledTimes(1)
    const s = t.store.getState()
    expect(s.jev.state).toBe('done')
    expect(s.jev.response).toBe(res)
    expect(s.groups?.jev).toHaveLength(1)
    const row = s.groups!.byKind[SAT].rows.find((r) => r.serviceId === '03001_A')!
    expect(row.intoMark).toBe('agreed')
    expect(s.confirmed).toBe(false)
  })

  it('Jev を使えない(キーが無い)ときは送らず、規則だけで続ける', async () => {
    const t = setup({ status: { available: false, provider: null, via: null, reason: 'noKey' } })
    await startAndAccept(t)
    const s = t.store.getState()
    expect(s.jev.state).toBe('unavailable')
    expect(s.jev.message).toContain('キーが設定されていない')
    expect(t.judge).not.toHaveBeenCalled()
    expect(s.groups?.jev).toBeNull()
  })

  it('送って失敗(回数の上限)したら、規則だけで続ける', async () => {
    const t = setup({ judge: async () => ({ ok: false, error: 'rateLimited', message: 'Jev への問い合わせの回数の上限に達したため、規則だけで分けました。' }) })
    await startAndAccept(t)
    const s = t.store.getState()
    expect(s.jev.state).toBe('failed')
    expect(s.jev.message).toContain('上限')
    expect(s.groups?.jev).toBeNull()
  })

  it('一部だけ答えを得たら partial。答えを得られなかった数と理由を出す', async () => {
    const res = response([result('03001_A', 'saturday')], [{ serviceId: '01001', role: 'weekday', error: 'timeout', sent: { state: {}, questions: {} } }])
    const t = setup({ judge: async () => ({ ok: true, response: res }) })
    await startAndAccept(t)
    const s = t.store.getState()
    expect(s.jev.state).toBe('partial')
    expect(s.jev.message).toContain('1 件は答えを得られませんでした(時間切れ)')
  })

  it('答えが1つも無ければ failed にし、上限(budget)と出す', async () => {
    const res = response([], [{ serviceId: '01001', role: 'weekday', error: 'budget' }])
    const t = setup({ judge: async () => ({ ok: true, response: res }) })
    await startAndAccept(t)
    const s = t.store.getState()
    expect(s.jev.state).toBe('failed')
    expect(s.jev.message).toContain('1日の上限')
    expect(s.groups?.jev).toBeNull()
  })
})

describe('中断と捨てる', () => {
  it('送っている間に中断したら、あとから届いた答えを捨てる', async () => {
    const d = deferred<JevOutcome>()
    const t = setup({ judge: () => d.promise })
    await startAndAccept(t)
    expect(t.store.getState().jev.state).toBe('sending')
    // 送っている間は確定できない
    expect(t.store.getState().confirm()).toBe(false)

    t.store.getState().stopJev()
    expect(t.store.getState().jev.state).toBe('stopped')
    expect(t.judge.mock.calls[0][1].aborted).toBe(true)
    // 送っている段階まで進んだので、送ったかもしれない側に数える(運営情報のページの「データの送り先」)
    expect(t.store.getState().jev.sent).toBe(true)

    d.resolve({ ok: true, response: response([result('03001_A', 'saturday')]) })
    await settle()
    expect(t.store.getState().jev.state).toBe('stopped')
    expect(t.store.getState().groups?.jev).toBeNull()

    // 中断のあとは、頼めばもう一度送れる
    await t.store.getState().askJev()
    expect(t.judge).toHaveBeenCalledTimes(2)
  })

  it('使えるかを確かめている間に止めたら、送っていない(sent は false)', async () => {
    const status = deferred<JevStatus>()
    const t = setup()
    t.fetchStatus.mockImplementation(() => status.promise)
    await startAndAccept(t)
    expect(t.store.getState().jev.state).toBe('checking')
    t.store.getState().stopJev()
    status.resolve(AVAILABLE)
    await settle()
    expect(t.store.getState().jev.state).toBe('stopped')
    expect(t.store.getState().jev.sent).toBe(false)
    expect(t.judge).not.toHaveBeenCalled()
  })

  it('答えを捨てると規則の案に戻り、利用者が直した行と、送った情報は残る', async () => {
    const res = response([result('03001_A', 'saturday', { weekdayCounterpart: { choice: '01001', probabilities: { '01001': 0.95 }, confidence: 0.95 } })])
    const t = setup({ judge: async () => ({ ok: true, response: res }) })
    await startAndAccept(t)
    expect(t.store.getState().groups!.byKind[SAT].rows.find((r) => r.serviceId === '03001_A')!.intoMark).toBe('conflict')
    t.store.getState().edit({ kind: SAT, serviceId: '03001', into: null })

    t.store.getState().dropJev()
    const s = t.store.getState()
    expect(s.jev.state).toBe('dropped')
    expect(s.jev.response).toBe(res)
    expect(s.groups?.jev).toBeNull()
    const rows = s.groups!.byKind[SAT].rows
    expect(rows.find((r) => r.serviceId === '03001_A')!.intoMark).toBe('rule')
    expect(rows.find((r) => r.serviceId === '03001')!.intoMark).toBe('edited')
  })

  it('読み込み直し(reset)のあとに届いた答えは捨てる', async () => {
    const d = deferred<JevOutcome>()
    const t = setup({ judge: () => d.promise })
    await startAndAccept(t)
    t.store.getState().reset()
    expect(t.judge.mock.calls[0][1].aborted).toBe(true)
    d.resolve({ ok: true, response: response([result('03001_A', 'saturday')]) })
    await settle()
    const s = t.store.getState()
    expect(s.status).toBe('idle')
    expect(s.groups).toBeNull()
    expect(s.jev.state).toBe('idle')
  })
})

describe('直しと確定', () => {
  it('決まらない行が残っている間は確定できない。選べば確定できる', async () => {
    const t = setup({ groups: undecidedGroups, status: { available: false, provider: null, via: null, reason: 'noKey' } })
    await startAndAccept(t)
    const g = t.store.getState().groups!
    expect(g.simple).toBe(false)
    const row = g.byKind[SAT].rows.find((r) => r.serviceId === '03001_X')!
    expect(row.intoMark).toBe('undecided')
    expect(attentionCount(g)).toBe(1)
    expect(t.store.getState().confirm()).toBe(false)
    expect(t.store.getState().confirmed).toBe(false)

    for (const kind of ['weekdayToSaturday', 'weekdayToSundayHoliday'] as const) {
      if (t.store.getState().groups!.byKind[kind].rows.some((r) => r.serviceId === '03001_X' && r.intoMark === 'undecided')) {
        t.store.getState().edit({ kind, serviceId: '03001_X', into: '11001_X' })
      }
    }
    const edited = t.store.getState().groups!.byKind[SAT].rows.find((r) => r.serviceId === '03001_X')!
    expect(edited).toMatchObject({ into: '11001_X', intoMark: 'edited' })
    expect(t.store.getState().confirm()).toBe(true)
    expect(t.store.getState().confirmed).toBe(true)

    // 案に戻すと、また決まらない。決まらない行が戻ったので、確定も外れる(減便の方針の手順と言うことをそろえる)
    t.store.getState().resetRow('03001_X')
    expect(t.store.getState().groups!.byKind[SAT].rows.find((r) => r.serviceId === '03001_X')!.intoMark).toBe('undecided')
    expect(t.store.getState().confirmed).toBe(false)
  })

  it('確定したあとに直して、決まらない行が残らなければ確定のまま', async () => {
    const t = setup({ status: { available: false, provider: null, via: null, reason: 'noKey' } })
    await startAndAccept(t)
    expect(t.store.getState().confirm()).toBe(true)
    t.store.getState().edit({ kind: SAT, serviceId: '01005_MSN', treatment: 'keep' })
    expect(t.store.getState().confirmed).toBe(true)
  })

  it('確定したあとに Jev に問い合わせ直して分け方が変わったら、確定を外し、表を開くよう頼む', async () => {
    let call = 0
    const conflict = response([
      result('03001_A', 'saturday', { weekdayCounterpart: { choice: '01005_MSN', probabilities: { '01005_MSN': 0.95 }, confidence: 0.95 } }),
    ])
    const t = setup({
      judge: async () => {
        call += 1
        return call === 1 ? { ok: false, error: 'rateLimited', message: '上限です。Jev には送っていません。' } : { ok: true, response: conflict }
      },
    })
    await startAndAccept(t)
    expect(t.store.getState().jev.state).toBe('failed')
    expect(t.store.getState().confirm()).toBe(true)
    const request = t.store.getState().tableRequest

    // 失敗したあとは、もう一度頼める
    await t.store.getState().askJev()
    expect(t.judge).toHaveBeenCalledTimes(2)
    const s = t.store.getState()
    expect(s.groups!.byKind[SAT].rows.find((r) => r.serviceId === '03001_A')!.intoMark).toBe('conflict')
    expect(s.confirmed).toBe(false)
    expect(s.jev.message).toContain('確定を外しました')
    expect(s.tableRequest).toBe(request + 1)
  })

  it('確定したあとに Jev の判断を捨てても、決まらない行が出なければ確定のまま', async () => {
    const agreed = response([
      result('03001_A', 'saturday', { weekdayCounterpart: { choice: '01001_A', probabilities: { '01001_A': 0.95 }, confidence: 0.95 } }),
    ])
    const t = setup({ judge: async () => ({ ok: true, response: agreed }) })
    await startAndAccept(t)
    expect(t.store.getState().confirm()).toBe(true)
    t.store.getState().dropJev()
    expect(t.store.getState().jev.state).toBe('dropped')
    expect(t.store.getState().confirmed).toBe(true)
  })

  it('Jev が埋めた決まらない行は、答えを捨てると決まらない行に戻り、確定が外れる', async () => {
    const res = response([
      result('03001_X', 'saturday', { weekdayCounterpart: { choice: '12001_X', probabilities: { '12001_X': 0.92 }, confidence: 0.93 } }),
    ])
    const t = setup({ groups: undecidedGroups, judge: async () => ({ ok: true, response: res }) })
    await startAndAccept(t)
    expect(t.store.getState().confirm()).toBe(true)
    t.store.getState().dropJev()
    expect(t.store.getState().confirmed).toBe(false)
  })

  it('Jev の確信の高い答えが、決まらない割り当てを埋める', async () => {
    const res = response([
      result('03001_X', 'saturday', { weekdayCounterpart: { choice: '12001_X', probabilities: { '12001_X': 0.92 }, confidence: 0.93 } }),
    ])
    const t = setup({ groups: undecidedGroups, judge: async () => ({ ok: true, response: res }) })
    await startAndAccept(t)
    const row = t.store.getState().groups!.byKind[SAT].rows.find((r) => r.serviceId === '03001_X')!
    expect(row).toMatchObject({ into: '12001_X', intoMark: 'jev' })
  })
})

describe('読み込みと削除(本物の store)', () => {
  afterEach(() => resetAll('delete'))

  it('GTFS を読み込むと計算し、削除で最初の状態に戻る', async () => {
    const { useHolidayStore } = await import('./holidays')
    useHolidayStore.setState({ holidays: { status: 'missing' } })
    useGtfsStore.getState().setLoaded({ label: 'small.zip', feed: smallFeed() })
    const s = useServiceGroupsStore.getState()
    expect(s.status).toBe('ready')
    expect(s.groups?.simple).toBe(true)
    expect(s.groups?.features.services.map((f) => f.serviceId)).toEqual(['SA', 'SU', 'WK'])

    resetAll('delete')
    const after = useServiceGroupsStore.getState()
    expect(after.status).toBe('idle')
    expect(after.groups).toBeNull()
    expect(after.confirmed).toBe(false)
  })

  it('単純でない GTFS では送るかを聞き、送ると答えてサーバーにつながらなければ、Jev を使えない扱いで規則だけで続ける', async () => {
    const { useHolidayStore } = await import('./holidays')
    useHolidayStore.setState({ holidays: { status: 'missing' } })
    // 平日だけの service が2つ(W1・W2)あるので単純でない
    const feed = feedFrom({
      agency: 'agency_id,agency_name\nA,テストバス',
      routes: 'route_id,route_short_name,route_long_name\nR1,1,\nR2,2,',
      calendar: [
        'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
        'W1,1,1,1,1,1,0,0,20261001,20261130',
        'W2,1,1,1,1,1,0,0,20261001,20261130',
        'S1,0,0,0,0,0,1,0,20261001,20261130',
      ].join('\n'),
      trips: 'route_id,service_id,trip_id,trip_headsign\nR1,W1,t1,駅前\nR1,W1,t2,駅前\nR2,W2,t3,病院\nR1,S1,t4,駅前',
      stop_times: 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,07:00:00,07:00:00,P1,1\nt2,08:00:00,08:00:00,P1,1\nt3,09:00:00,09:00:00,P1,1\nt4,10:00:00,10:00:00,P1,1',
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      useGtfsStore.getState().setLoaded({ label: 'w2.zip', feed })
      expect(useServiceGroupsStore.getState().groups?.simple).toBe(false)
      expect(useServiceGroupsStore.getState().jev.state).toBe('awaitingConsent')
      void useServiceGroupsStore.getState().acceptJev()
      await vi.waitFor(() => expect(useServiceGroupsStore.getState().jev.state).toBe('unavailable'))
      expect(useServiceGroupsStore.getState().jev.message).toContain('規則だけで分けました')
      expect(useServiceGroupsStore.getState().confirmed).toBe(false)
      await settle()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
