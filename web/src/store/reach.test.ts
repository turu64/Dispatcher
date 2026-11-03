import { afterEach, describe, expect, it, vi } from 'vitest'
import { servicesFor } from '../gtfs/calendar'
import { departureCountsByBand, makeBands } from '../gtfs/departures'
import type { GtfsFeed, GtfsRow } from '../gtfs/load'
import { toStops } from '../gtfs/parse'
import { cellsWithinRadius } from '../reach/mesh'
import { computeReach, type ReachInput, type ReachResult } from '../reach/reach'
import type { RefLoadResult } from '../reach/refData'
import { createReachStore, selectablePeriod, type EditedSource, type ReachSource, type ReachStoreDeps } from './reach'

function table(fileName: string, rows: GtfsRow[]) {
  return { fileName, fields: Object.keys(rows[0] ?? {}), rows }
}

/** 平日(01)だけの小さなフィード。停留所 A・B を 1 便が 7:00・7:10 に通り、B が終点(乗れる行が無いので起点にしない) */
function makeFeed(stopRows: GtfsRow[] = DEFAULT_STOPS): GtfsFeed {
  return {
    tables: new Map([
      ['stops', table('stops.txt', stopRows)],
      [
        'calendar',
        table('calendar.txt', [
          {
            service_id: '01',
            monday: '1',
            tuesday: '1',
            wednesday: '1',
            thursday: '1',
            friday: '1',
            saturday: '0',
            sunday: '0',
            start_date: '20261001',
            end_date: '20261130',
          },
        ]),
      ],
      ['calendar_dates', table('calendar_dates.txt', [{ service_id: '01', date: '20261103', exception_type: '2' }])],
      ['trips', table('trips.txt', [{ route_id: 'R', service_id: '01', trip_id: 'T1' }])],
      [
        'stop_times',
        table('stop_times.txt', [
          { trip_id: 'T1', stop_id: 'A', stop_sequence: '1', arrival_time: '07:00:00', departure_time: '07:00:00' },
          { trip_id: 'T1', stop_id: 'B', stop_sequence: '2', arrival_time: '07:10:00', departure_time: '07:10:00' },
        ]),
      ],
    ]),
    warnings: [],
  }
}

const DEFAULT_STOPS: GtfsRow[] = [
  { stop_id: 'A', stop_name: 'A', stop_lat: '43.6667', stop_lon: '142.5' },
  { stop_id: 'B', stop_name: 'B', stop_lat: '43.6700', stop_lon: '142.51' },
]

function sourceOf(feed: GtfsFeed): ReachSource {
  return { feed, stops: toStops(feed).stops, period: { start: '20261001', end: '20261130' } }
}

function fakeResult(input: ReachInput): ReachResult {
  // 時間帯ごとに、出発がある停留所が1つでもあれば1つ目のセルに届く、という偽の計算
  const reachable = Array.from({ length: input.bandCount }, (_, b) => [input.stops.some((s) => s.bandCounts[b] > 0), false])
  return {
    cells: ['65423700111', '65423700112'],
    classes: [input.ref ? 'urban' : input.fallbackClass, input.ref ? 'rural' : input.fallbackClass],
    reachable,
    coverable: [true, true],
    usedFallback: input.ref === null,
    excludedStops: 0,
    cellPopulation: input.ref ? [10, 5] : [0, 0],
  }
}

const REF_OK: RefLoadResult = {
  ok: true,
  mesh1s: ['6542'],
  ref: { pop250: new Map([['6542370011', 60]]), did125: new Set(), stations: [] },
  stations: [],
  sources: [],
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(overrides: Partial<ReachStoreDeps> = {}) {
  const compute = vi.fn(async (input: ReachInput) => fakeResult(input))
  const loadRef = vi.fn(async (mesh1s: string[]): Promise<RefLoadResult> => ({ ...REF_OK, mesh1s }))
  const deps: ReachStoreDeps = { compute, loadRef, today: () => '20261103', paramDelayMs: 0, ...overrides }
  const store = createReachStore(deps)
  return { store, compute: deps.compute as typeof compute, loadRef: deps.loadRef as typeof loadRef }
}

/** すべての非同期の処理が終わるまで待つ */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useReachStore(createReachStore)', () => {
  it('最初は何も計算していない', () => {
    const { store } = setup()
    const s = store.getState()
    expect(s.source).toBeNull()
    expect(s.date).toBeNull()
    expect(s.stepHours).toBe(3)
    expect(s.snapshot).toBeNull()
    expect(s.params.walkMinutes.rural.rail).toBe(20)
    expect(s.fallbackClass).toBe('suburban')
  })

  it('GTFS を渡すと、既定の日付(今日 11/3 は祝日で運休なので 11/4)で計算する', async () => {
    const { store, compute, loadRef } = setup()
    store.getState().setSource(sourceOf(makeFeed()))
    expect(store.getState().date).toBe('20261104')
    expect(store.getState().computing).toBe(true)
    await settle()

    expect(loadRef).toHaveBeenCalledWith(['6542'])
    expect(compute).toHaveBeenCalledTimes(1)
    const input = compute.mock.calls[0][0]
    expect(input.bandCount).toBe(6)
    // A は 7:00 に出発(6〜9時)。B はどの便でも終点で乗れる行が無いので、起点にしない
    expect(input.stops).toEqual([{ lat: 43.6667, lon: 142.5, bandCounts: [1, 0, 0, 0, 0, 0] }])
    expect(input.ref).toBe(REF_OK.ref)
    expect(input.params).toEqual(store.getState().params)
    expect(input.params).not.toBe(store.getState().params)

    const s = store.getState()
    expect(s.computing).toBe(false)
    expect(s.error).toBeNull()
    expect(s.ref).toMatchObject({ status: 'done', key: '6542' })
    expect(s.snapshot?.date).toBe('20261104')
    expect(s.snapshot?.bands.map((b) => b.label)).toEqual(['6〜9時', '9〜12時', '12〜15時', '15〜18時', '18〜21時', '21〜24時'])
    expect(s.snapshot?.departures.counts.get('A')).toEqual([1, 0, 0, 0, 0, 0])
    expect(s.snapshot?.summary.bands[0]).toEqual({ unreachableCells: 1, unreachablePopulation: 5 })
    expect(s.snapshot?.summary.bands[1]).toEqual({ unreachableCells: 2, unreachablePopulation: 15 })
    expect(s.snapshot?.origin).toEqual({ origins: 1, unused: 0, nonStop: 0, noBoarding: 1 })
    // 編集後が無ければ、基準だけを計算し、比較は入れない
    expect(s.edited).toBeNull()
    expect(s.snapshot?.baseline).toBeUndefined()
    expect(s.snapshot?.comparison).toBeUndefined()
  })

  it('日付を続けて切り替えたら、後から届いた古い結果では上書きしない', async () => {
    const pending: { input: ReachInput; d: ReturnType<typeof deferred<ReachResult>> }[] = []
    const { store } = setup({
      compute: (input) => {
        const d = deferred<ReachResult>()
        pending.push({ input, d })
        return d.promise
      },
    })
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    expect(store.getState().setDate('20261105')).toBeNull()
    await settle()
    expect(store.getState().setDate('20261107')).toBeNull()
    await settle()
    expect(pending).toHaveLength(3)

    // 最新(11/7 は土曜で便が無い)を先に返し、そのあと古い 11/4・11/5 を返す
    pending[2].d.resolve(fakeResult(pending[2].input))
    await settle()
    pending[0].d.resolve(fakeResult(pending[0].input))
    pending[1].d.resolve(fakeResult(pending[1].input))
    await settle()
    const s = store.getState()
    expect(s.snapshot?.date).toBe('20261107')
    expect(s.snapshot?.departures.counts.size).toBe(0)
    expect(s.computing).toBe(false)
  })

  it('古い計算が失敗しても、新しい計算の結果を消さない', async () => {
    const pending: ReturnType<typeof deferred<ReachResult>>[] = []
    const inputs: ReachInput[] = []
    const { store } = setup({
      compute: (input) => {
        const d = deferred<ReachResult>()
        pending.push(d)
        inputs.push(input)
        return d.promise
      },
    })
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    store.getState().setStepHours(1)
    await settle()
    pending[1].resolve(fakeResult(inputs[1]))
    await settle()
    pending[0].reject(new Error('古い計算の失敗'))
    await settle()
    expect(store.getState().error).toBeNull()
    expect(store.getState().snapshot?.stepHours).toBe(1)
    expect(store.getState().snapshot?.bands).toHaveLength(18)
  })

  it('運行期間の外や不正な日付は、変えずに理由を返す', async () => {
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    expect(store.getState().setDate('20261201')).toBe('運行期間の中の日付を選んでください。')
    expect(store.getState().setDate('20261131')).toBe('運行期間の中の日付を選んでください。')
    expect(store.getState().date).toBe('20261104')
    // 同じ日付を選び直しても計算し直さない
    expect(store.getState().setDate('20261104')).toBeNull()
    await settle()
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('時間帯の選択は計算し直さない', async () => {
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    store.getState().selectHour(12)
    await settle()
    expect(store.getState().selectedHour).toBe(12)
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('1時間ごとに切り替えると、18 の時間帯で計算する', async () => {
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    store.getState().setStepHours(1)
    await settle()
    expect(compute).toHaveBeenCalledTimes(2)
    expect(compute.mock.calls[1][0].bandCount).toBe(18)
    expect(compute.mock.calls[1][0].stops[0].bandCounts[1]).toBe(1)
  })

  it('参照データは同じ1次メッシュの組なら読み直さない。分数を増やして範囲が広がれば、読み直す', async () => {
    // 6542 の南端(43.333…度)から約 3.3km の停留所。既定の読み込み範囲(バス停 1,200m + 駅 1,600m = 2,800m)には南の 6442 が入らない
    const stops = [{ stop_id: 'A', stop_name: 'A', stop_lat: String(130 / 3 + 0.03), stop_lon: '142.5' }]
    const { store, loadRef } = setup()
    store.getState().setSource(sourceOf(makeFeed(stops)))
    await settle()
    store.getState().setDensityThreshold(2000)
    await settle()
    expect(loadRef).toHaveBeenCalledTimes(1)
    expect(loadRef.mock.calls[0][0]).toEqual(['6542'])

    // 都市部のバス停を 30 分(2,400m)にすると、読み込み範囲は 2,400m + 1,600m = 4,000m になり、6442 も読む
    store.getState().setWalkMinutes('urban', 'bus', 30)
    await settle()
    expect(loadRef).toHaveBeenCalledTimes(2)
    expect(loadRef.mock.calls[1][0]).toEqual(['6442', '6542'])
    expect(store.getState().snapshot?.params.walkMinutes.urban.bus).toBe(30)
  })

  it('参照データの読み込み範囲は「バス停の距離の最大 + 駅の距離の最大」(駅の分数を増やしても広がる)', async () => {
    // 6542 の南端から約 2.2km の停留所。バス停 1,200m + 駅 1,600m = 2,800m なので、既定でも 6442 を読む
    const near = [{ stop_id: 'A', stop_name: 'A', stop_lat: String(130 / 3 + 0.02), stop_lon: '142.5' }]
    const first = setup()
    first.store.getState().setSource(sourceOf(makeFeed(near)))
    await settle()
    expect(first.loadRef.mock.calls[0][0]).toEqual(['6442', '6542'])

    // 約 3.3km の停留所は、中山間・地方の駅を 30 分(2,400m)にすると 1,200m + 2,400m = 3,600m で 6442 も読む
    const far = [{ stop_id: 'A', stop_name: 'A', stop_lat: String(130 / 3 + 0.03), stop_lon: '142.5' }]
    const second = setup()
    second.store.getState().setSource(sourceOf(makeFeed(far)))
    await settle()
    expect(second.loadRef.mock.calls[0][0]).toEqual(['6542'])
    second.store.getState().setWalkMinutes('rural', 'rail', 30)
    await settle()
    expect(second.loadRef.mock.calls[1][0]).toEqual(['6442', '6542'])
  })

  it('起点は stop_times に出てくる、location_type が 0 か空の停留所だけ(計算にも地図にもそれだけを使う)', async () => {
    const stops: GtfsRow[] = [
      { stop_id: ' A ', stop_name: 'A', stop_lat: '43.6667', stop_lon: '142.5', location_type: '' },
      { stop_id: 'B', stop_name: 'B', stop_lat: '43.6700', stop_lon: '142.51', location_type: '0' },
      // stop_times に出てこない停留所
      { stop_id: 'C', stop_name: '使われない停留所', stop_lat: '43.6800', stop_lon: '142.52' },
      // 駅舎(location_type 1)。stop_times に出てきても起点にしない
      { stop_id: 'S', stop_name: '駅舎', stop_lat: '43.6900', stop_lon: '142.53', location_type: '1' },
      { stop_id: 'E', stop_name: '出入口', stop_lat: '43.6910', stop_lon: '142.53', location_type: '2' },
    ]
    const feed = makeFeed(stops)
    feed.tables.get('stop_times')!.rows.push({
      trip_id: 'T1',
      stop_id: 'S',
      stop_sequence: '3',
      arrival_time: '07:20:00',
      departure_time: '07:20:00',
    })
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(feed))
    await settle()

    const origins = store.getState().origins!
    expect(origins.stops.map((s) => s.id)).toEqual(['A', 'B'])
    expect(origins.unused).toBe(1)
    expect(origins.nonStop).toBe(2)
    // B は駅舎 S の手前なので出発として数える(S は終点)
    expect(compute.mock.calls[0][0].stops).toEqual([
      { lat: 43.6667, lon: 142.5, bandCounts: [1, 0, 0, 0, 0, 0] },
      { lat: 43.67, lon: 142.51, bandCounts: [1, 0, 0, 0, 0, 0] },
    ])
    expect(store.getState().snapshot?.origin).toEqual({ origins: 2, unused: 1, nonStop: 2, noBoarding: 0 })
  })

  it('stop_times に出てくる停留所に位置の分かるものが無ければ、計算せずに理由を出す', async () => {
    // A・B は stop_times に出てくるが位置が (0, 0)。C は位置が分かるが stop_times に出てこない
    const stops: GtfsRow[] = [
      { stop_id: 'A', stop_name: 'A', stop_lat: '0', stop_lon: '0' },
      { stop_id: 'B', stop_name: 'B', stop_lat: '0', stop_lon: '0' },
      { stop_id: 'C', stop_name: 'C', stop_lat: '43.68', stop_lon: '142.52' },
    ]
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(makeFeed(stops)))
    await settle()
    expect(compute).not.toHaveBeenCalled()
    expect(store.getState().error).toContain('stop_times.txt に出てくる停留所')
  })

  it('前日(日曜だけの service)の 30:10:00 の便は、月曜を選んだときの 6〜9時の出発として計算に届く', async () => {
    const feed = makeFeed()
    feed.tables.get('calendar')!.rows.push({
      service_id: '06',
      monday: '0',
      tuesday: '0',
      wednesday: '0',
      thursday: '0',
      friday: '0',
      saturday: '0',
      sunday: '1',
      start_date: '20261001',
      end_date: '20261130',
    })
    feed.tables.get('trips')!.rows.push({ route_id: 'R', service_id: '06', trip_id: 'T6' })
    feed.tables.get('stop_times')!.rows.push(
      { trip_id: 'T6', stop_id: 'B', stop_sequence: '1', arrival_time: '30:10:00', departure_time: '30:10:00' },
      { trip_id: 'T6', stop_id: 'A', stop_sequence: '2', arrival_time: '30:20:00', departure_time: '30:20:00' },
    )
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(feed))
    await settle()

    // 2026-11-02 は月曜、前日の 11/1 は日曜(service 06 が走る)
    expect(store.getState().setDate('20261102')).toBeNull()
    await settle()
    const monday = compute.mock.calls.at(-1)![0]
    expect(store.getState().snapshot?.date).toBe('20261102')
    // A は平日の便(7:00)、B は前日の便(30:10 = 月曜の 6:10)。どちらも 6〜9時
    expect(monday.stops).toEqual([
      { lat: 43.6667, lon: 142.5, bandCounts: [1, 0, 0, 0, 0, 0] },
      { lat: 43.67, lon: 142.51, bandCounts: [1, 0, 0, 0, 0, 0] },
    ])
    expect(store.getState().snapshot?.departures.counts.get('B')).toEqual([1, 0, 0, 0, 0, 0])

    // 日曜(11/1)を選ぶと、30:10 は月曜の朝なので日曜の時間帯には入らない(平日の便も走らない)
    expect(store.getState().setDate('20261101')).toBeNull()
    await settle()
    expect(compute.mock.calls.at(-1)![0].stops.map((s) => s.bandCounts)).toEqual([
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ])
    expect(store.getState().snapshot?.departures.counts.size).toBe(0)
  })

  it('参照データが読めなければ fallback の区分で計算し、区分を変えたら計算し直す', async () => {
    const failed: RefLoadResult = { ok: false, mesh1s: ['6542'], missing: ['6542'], message: '読めません' }
    const { store, compute } = setup({ loadRef: vi.fn(async () => failed) })
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    expect(compute.mock.calls[0][0].ref).toBeNull()
    expect(compute.mock.calls[0][0].fallbackClass).toBe('suburban')
    expect(store.getState().ref).toEqual({ status: 'done', key: '6542', result: failed })

    store.getState().setFallbackClass('rural')
    await settle()
    expect(compute).toHaveBeenCalledTimes(2)
    expect(compute.mock.calls[1][0].fallbackClass).toBe('rural')
    expect(store.getState().snapshot?.result.classes[0]).toBe('rural')
  })

  it('参照データがあるときは、fallback の区分を変えても計算し直さない', async () => {
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    store.getState().setFallbackClass('urban')
    await settle()
    expect(store.getState().fallbackClass).toBe('urban')
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('読み込み直すと、参照データをもう一度取りにいく', async () => {
    const loadRef = vi
      .fn<(m: string[]) => Promise<RefLoadResult>>()
      .mockResolvedValueOnce({ ok: false, mesh1s: ['6542'], missing: ['6542'], message: '読めません' })
      .mockResolvedValueOnce(REF_OK)
    const { store, compute } = setup({ loadRef })
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    store.getState().retryRef()
    await settle()
    expect(loadRef).toHaveBeenCalledTimes(2)
    expect(compute.mock.calls[1][0].ref).toBe(REF_OK.ref)
  })

  it('参照データの取得が例外を投げても、fallback として計算する', async () => {
    const { store, compute } = setup({ loadRef: vi.fn(async () => Promise.reject(new Error('想定外'))) })
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    expect(compute.mock.calls[0][0].ref).toBeNull()
    const ref = store.getState().ref
    expect(ref.status === 'done' && !ref.result.ok && ref.result.message).toBe('想定外')
  })

  it('同じ参照データを読み込み中に条件を変えても、取りにいくのは1回', async () => {
    const d = deferred<RefLoadResult>()
    const loadRef = vi.fn(() => d.promise)
    const { store, compute } = setup({ loadRef })
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    store.getState().setDensityThreshold(500)
    await settle()
    expect(store.getState().ref.status).toBe('loading')
    d.resolve(REF_OK)
    await settle()
    expect(loadRef).toHaveBeenCalledTimes(1)
    expect(compute).toHaveBeenCalledTimes(1)
    expect(compute.mock.calls[0][0].params.densityThreshold).toBe(500)
    expect(store.getState().ref.status).toBe('done')
  })

  it('分数の入力は、続けて打つ間は計算せず、止まってから1回だけ計算する', async () => {
    vi.useFakeTimers()
    const { store, compute } = setup({ paramDelayMs: 300 })
    store.getState().setSource(sourceOf(makeFeed()))
    await vi.runAllTimersAsync()
    expect(compute).toHaveBeenCalledTimes(1)

    store.getState().setWalkMinutes('suburban', 'bus', 1)
    store.getState().setWalkMinutes('suburban', 'bus', 12)
    expect(store.getState().computing).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(compute).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    await vi.runAllTimersAsync()
    expect(compute).toHaveBeenCalledTimes(2)
    expect(compute.mock.calls[1][0].params.walkMinutes.suburban.bus).toBe(12)
    expect(store.getState().computing).toBe(false)
  })

  it('既定に戻すと、既定の条件で計算し直す', async () => {
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    store.getState().setWalkMinutes('rural', 'rail', 25)
    await settle()
    store.getState().resetParams()
    await settle()
    expect(store.getState().params.walkMinutes.rural.rail).toBe(20)
    expect(compute.mock.calls.at(-1)?.[0].params.walkMinutes.rural.rail).toBe(20)
  })

  it('計算に失敗したら、理由を出す', async () => {
    const { store } = setup({ compute: vi.fn(async () => Promise.reject(new Error('到達圏を計算する処理が途中で止まりました。'))) })
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    expect(store.getState().error).toBe('到達圏を計算する処理が途中で止まりました。')
    expect(store.getState().computing).toBe(false)
  })

  it('位置の分かる停留所が無ければ、計算せずに理由を出す', async () => {
    const { store, compute } = setup()
    store.getState().setSource(sourceOf(makeFeed([{ stop_id: 'A', stop_name: 'A', stop_lat: '0', stop_lon: '0' }])))
    await settle()
    expect(compute).not.toHaveBeenCalled()
    expect(store.getState().error).toContain('位置の分かる停留所がありません')
  })

  it('運行期間が無いフィードは、日付が null で計算しない', async () => {
    const { store, compute } = setup()
    store.getState().setSource({ ...sourceOf(makeFeed()), period: null })
    await settle()
    expect(store.getState().date).toBeNull()
    expect(compute).not.toHaveBeenCalled()
    expect(store.getState().setDate('20261104')).toBe('GTFS に運行日がありません。')
  })

  it('GTFS を捨てると結果も捨て、計算中の結果は使わない', async () => {
    const d = deferred<ReachResult>()
    let input: ReachInput | null = null
    const { store } = setup({
      compute: (i) => {
        input = i
        return d.promise
      },
    })
    store.getState().setSource(sourceOf(makeFeed()))
    await settle()
    store.getState().setSource(null)
    d.resolve(fakeResult(input!))
    await settle()
    const s = store.getState()
    expect(s.source).toBeNull()
    expect(s.snapshot).toBeNull()
    expect(s.computing).toBe(false)
  })
})

// ---- 前後の比較(docs/interfaces-1104.md §7・§11、docs/interfaces-1103.md の追記3) ----

/**
 * 基準の小さなフィード(平日 WK・土曜 SA・日曜 SU。2026-11-03 は平日を運休)。
 * - R1:平日 A→B 7:00、平日 A→C→B 19:00、土曜 A→B 8:00
 * - R3:平日 S9→B 7:30。S9 を通るのはこの便だけ(消すと S9 が stop_times から無くなる)
 * - R4:平日 D→B 9:00、日曜 D→B 9:00
 * B はどの便でも終点なので、乗れる行が無く起点にしない。S9・D は A・B・C から 3km 以上離れている
 */
function compareFeed(extraStops: GtfsRow[] = [], r1Morning: [string, string, string?][] = [['A', '07:00:00'], ['B', '07:10:00']]): GtfsFeed {
  const days = (wk: string) => ({
    monday: wk,
    tuesday: wk,
    wednesday: wk,
    thursday: wk,
    friday: wk,
  })
  return {
    tables: new Map([
      [
        'stops',
        table('stops.txt', [
          { stop_id: 'A', stop_name: 'A', stop_lat: '43.6667', stop_lon: '142.5' },
          { stop_id: 'C', stop_name: 'C', stop_lat: '43.6680', stop_lon: '142.505' },
          { stop_id: 'B', stop_name: 'B', stop_lat: '43.6700', stop_lon: '142.51' },
          { stop_id: 'S9', stop_name: 'S9', stop_lat: '43.70', stop_lon: '142.60' },
          { stop_id: 'D', stop_name: 'D', stop_lat: '43.63', stop_lon: '142.44' },
          ...extraStops,
        ]),
      ],
      ['routes', table('routes.txt', ['R1', 'R3', 'R4'].map((id) => ({ route_id: id, route_short_name: id, route_long_name: '' })))],
      [
        'calendar',
        table('calendar.txt', [
          { service_id: 'WK', ...days('1'), saturday: '0', sunday: '0', start_date: '20261001', end_date: '20261130' },
          { service_id: 'SA', ...days('0'), saturday: '1', sunday: '0', start_date: '20261001', end_date: '20261130' },
          { service_id: 'SU', ...days('0'), saturday: '0', sunday: '1', start_date: '20261001', end_date: '20261130' },
        ]),
      ],
      ['calendar_dates', table('calendar_dates.txt', [{ service_id: 'WK', date: '20261103', exception_type: '2' }])],
      [
        'trips',
        table('trips.txt', [
          { route_id: 'R1', service_id: 'WK', trip_id: 'R1_0700_WK' },
          { route_id: 'R1', service_id: 'WK', trip_id: 'R1_1900_WK' },
          { route_id: 'R3', service_id: 'WK', trip_id: 'R3_0730_WK' },
          { route_id: 'R4', service_id: 'WK', trip_id: 'R4_0900_WK' },
          { route_id: 'R1', service_id: 'SA', trip_id: 'R1_0800_SA' },
          { route_id: 'R4', service_id: 'SU', trip_id: 'R4_0900_SU' },
        ]),
      ],
      [
        'stop_times',
        table('stop_times.txt', [
          ...timesOf('R1_0700_WK', r1Morning),
          ...timesOf('R1_1900_WK', [['A', '19:00:00'], ['C', '19:05:00'], ['B', '19:10:00']]),
          ...R3_TIMES,
          ...timesOf('R4_0900_WK', [['D', '09:00:00'], ['B', '09:30:00']]),
          ...timesOf('R1_0800_SA', [['A', '08:00:00'], ['B', '08:10:00']]),
          ...timesOf('R4_0900_SU', [['D', '09:00:00'], ['B', '09:30:00']]),
        ]),
      ],
    ]),
    warnings: [],
  }
}

/** stop_times の行(stops は [stop_id, 時刻, pickup_type] の並び。stop_sequence は 1 から) */
function timesOf(tripId: string, stops: [string, string, string?][]): GtfsRow[] {
  return stops.map(([stopId, time, pickup], i) => ({
    trip_id: tripId,
    stop_id: stopId,
    stop_sequence: String(i + 1),
    arrival_time: time,
    departure_time: time,
    ...(pickup === undefined ? {} : { pickup_type: pickup }),
  }))
}

const R3_TIMES = timesOf('R3_0730_WK', [['S9', '07:30:00'], ['B', '07:50:00']])
const R3_TRIP: GtfsRow = { route_id: 'R3', service_id: 'WK', trip_id: 'R3_0730_WK' }

/**
 * 「平日を土曜ダイヤに」を当てたような編集後のフィード(手で作る。form2 は使わない)。
 * 平日の便は土曜の R1 8:00 の写しだけ(R1_0800_WK)。R3 は消え(addBackR3 なら足し戻す)、R4 は日曜だけに残る。
 * stops・routes・calendar・calendar_dates は基準と同じ表を使う
 */
function editedOf(base: GtfsFeed, addBackR3: boolean, draft = false, period = { start: '20261101', end: '20261130' }): EditedSource {
  const tables = new Map(base.tables)
  tables.set(
    'trips',
    table('trips.txt', [
      { route_id: 'R1', service_id: 'WK', trip_id: 'R1_0800_WK' },
      ...(addBackR3 ? [R3_TRIP] : []),
      { route_id: 'R1', service_id: 'SA', trip_id: 'R1_0800_SA' },
      { route_id: 'R4', service_id: 'SU', trip_id: 'R4_0900_SU' },
    ]),
  )
  tables.set(
    'stop_times',
    table('stop_times.txt', [
      ...timesOf('R1_0800_WK', [['A', '08:00:00'], ['B', '08:10:00']]),
      ...(addBackR3 ? R3_TIMES : []),
      ...timesOf('R1_0800_SA', [['A', '08:00:00'], ['B', '08:10:00']]),
      ...timesOf('R4_0900_SU', [['D', '09:00:00'], ['B', '09:30:00']]),
    ]),
  )
  return { feed: { tables, warnings: [] }, period, draft }
}

const REF_MISSING: RefLoadResult = { ok: false, mesh1s: ['6542'], missing: ['6542'], message: '読めません' }

/** 本物の computeReach で計算する(参照データは無いものとし、すべて郊外 = バス停 800m)。渡された条件を記録する */
function setupReal() {
  const inputs: ReachInput[] = []
  const { store, compute } = setup({
    compute: vi.fn(async (input: ReachInput) => {
      inputs.push(structuredClone(input))
      return computeReach(input)
    }),
    loadRef: vi.fn(async () => REF_MISSING),
  })
  return { store, compute, inputs }
}

/** S9 から 800m 以内のセルの、結果の中での番号 */
function cellsAroundS9(cells: readonly string[]): number[] {
  const around = new Set(cellsWithinRadius([{ lat: 43.7, lon: 142.6 }], 800))
  const out: number[] = []
  cells.forEach((c, i) => {
    if (around.has(c)) out.push(i)
  })
  expect(out).toHaveLength(around.size)
  return out
}

describe('到達圏の前後の比較(基準の起点を使う)', () => {
  it('便を消して停留所が stop_times から消えても、基準の起点を使うので、そのまわりのセルは外れるセルに残り分母から消えない', async () => {
    const { store, inputs } = setupReal()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    const edited = editedOf(base, false)
    // 編集後のフィードには S9 の行が無い
    expect(edited.feed.tables.get('stop_times')!.rows.some((r) => r.stop_id === 'S9')).toBe(false)
    store.getState().setEdited(edited)
    await settle()

    // 起点は基準の A・C・S9・D(B は乗れる行が無い)。編集後の計算にも同じ起点を渡し、S9 の出発は 0
    const ids = store.getState().origins!.stops.map((s) => s.id)
    expect(ids).toEqual(['A', 'C', 'S9', 'D'])
    expect(inputs).toHaveLength(2)
    expect(inputs[1].stops).toHaveLength(4)
    expect(inputs[1].stops[ids.indexOf('S9')]).toEqual({ lat: 43.7, lon: 142.6, bandCounts: [0, 0, 0, 0, 0, 0] })
    expect(inputs[0].stops[ids.indexOf('S9')].bandCounts).toEqual([1, 0, 0, 0, 0, 0])

    const snap = store.getState().snapshot!
    const baseline = snap.baseline!
    expect(snap.result.cells).toEqual(baseline.result.cells)
    expect(snap.result.coverable).toEqual(baseline.result.coverable)
    expect(snap.summary.coverableCells).toBe(baseline.summary.coverableCells)
    // S9 のまわりのセルは見込みがあり(分母に残り)、編集後はどの時間帯でも外れる(分子に入る)
    const around = cellsAroundS9(snap.result.cells)
    for (const i of around) {
      expect(snap.result.coverable[i]).toBe(true)
      expect(baseline.result.reachable[0][i]).toBe(true)
      expect(snap.result.reachable.every((row) => !row[i])).toBe(true)
    }
    expect(snap.summary.bands[0].unreachableCells).toBe(baseline.summary.bands[0].unreachableCells + around.length)
    // 6〜9時に減便で外れたのは S9 のまわりだけ(A は 8:00 の便が残る)
    expect(snap.comparison!.bands[0].lostCells).toBe(around.length)
  })

  it('編集後を渡すと、同じ日付で基準と編集後を計算し、表示は編集後、baseline は基準になる', async () => {
    const { store, compute } = setup()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    const edited = editedOf(base, false, true)
    store.getState().setEdited(edited)
    await settle()

    const s = store.getState()
    expect(s.edited).toBe(edited)
    expect(s.compareMode).toBe('diff')
    const snap = s.snapshot!
    expect(snap.date).toBe('20261104')
    expect(snap.draft).toBe(true)
    // 表示する側は編集後(A は 8:00 だけ)。baseline は同じ日付の基準(A は 7:00 と 19:00)
    const bands = makeBands(3)
    expect(snap.departures.counts).toEqual(departureCountsByBand(edited.feed, servicesFor(edited.feed, '20261104'), bands).counts)
    expect(snap.baseline!.departures.counts).toEqual(departureCountsByBand(base, servicesFor(base, '20261104'), bands).counts)
    expect(snap.departures.counts.get('A')).toEqual([1, 0, 0, 0, 0, 0])
    expect(snap.baseline!.departures.counts.get('A')).toEqual([1, 0, 0, 0, 1, 0])
    // 計算の条件は、基準と編集後で出発の数だけが違う
    const [baseInput, editedInput] = compute.mock.calls.map((c) => c[0])
    expect(editedInput.stops.map((p) => [p.lat, p.lon])).toEqual(baseInput.stops.map((p) => [p.lat, p.lon]))
    expect(editedInput.ref).toBe(baseInput.ref)
    expect(editedInput.params).toEqual(baseInput.params)
    expect(snap.comparison?.bands).toHaveLength(6)
    expect(snap.zeroRoutes?.map((r) => [r.routeId, r.scope])).toEqual([
      ['R3', 'feed'],
      ['R4', 'day'],
    ])

    // 地図の塗り分けは計算し直さない
    s.setCompareMode('before')
    await settle()
    expect(store.getState().compareMode).toBe('before')
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('編集後だけが変わったときは、基準の側を計算し直さない', async () => {
    const { store, compute } = setup()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    expect(compute).toHaveBeenCalledTimes(1)

    store.getState().setEdited(editedOf(base, false))
    await settle()
    expect(compute).toHaveBeenCalledTimes(2)
    // 足し戻しで編集後だけが変わる
    store.getState().setEdited(editedOf(base, true))
    await settle()
    expect(compute).toHaveBeenCalledTimes(3)
    // すべて戻すと基準だけになり、基準は計算し直さない
    store.getState().setEdited(null)
    await settle()
    expect(compute).toHaveBeenCalledTimes(3)
    expect(store.getState().snapshot?.baseline).toBeUndefined()
    expect(store.getState().snapshot?.departures.counts.get('A')).toEqual([1, 0, 0, 0, 1, 0])

    // 日付や時間帯の幅を変えれば、基準も計算し直す
    store.getState().setEdited(editedOf(base, false))
    await settle()
    expect(compute).toHaveBeenCalledTimes(4)
    expect(store.getState().setDate('20261105')).toBeNull()
    await settle()
    expect(compute).toHaveBeenCalledTimes(6)
    store.getState().setStepHours(1)
    await settle()
    expect(compute).toHaveBeenCalledTimes(8)
    expect(store.getState().snapshot?.baseline?.result.reachable).toHaveLength(18)
  })

  it('基準の計算中に編集後を渡しても、基準は1回だけ計算し、失敗した基準の結果は使い回さない', async () => {
    const pending: { input: ReachInput; d: ReturnType<typeof deferred<ReachResult>> }[] = []
    const { store } = setup({
      compute: (input) => {
        const d = deferred<ReachResult>()
        pending.push({ input, d })
        return d.promise
      },
    })
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    expect(pending).toHaveLength(1)
    // 基準を計算している間に編集後が届く。基準の計算を待ち、編集後だけを計算する
    store.getState().setEdited(editedOf(base, false))
    await settle()
    expect(pending).toHaveLength(2)
    pending[1].d.resolve(fakeResult(pending[1].input))
    pending[0].d.resolve(fakeResult(pending[0].input))
    await settle()
    expect(store.getState().snapshot?.baseline?.result.reachable[0]).toEqual([true, false])
    expect(store.getState().error).toBeNull()

    // 基準の計算が失敗したら、次の計算では基準を計算し直す
    expect(store.getState().setDate('20261105')).toBeNull()
    await settle()
    expect(pending).toHaveLength(4)
    pending[2].d.reject(new Error('基準の計算の失敗'))
    pending[3].d.resolve(fakeResult(pending[3].input))
    await settle()
    expect(store.getState().error).toBe('基準の計算の失敗')
    store.getState().setEdited(editedOf(base, true))
    await settle()
    expect(pending).toHaveLength(6)
  })

  it('編集後の有効期間の外の日付は選べず、編集後を渡したときに日付が外なら期間の中の日に移す', async () => {
    const { store } = setup()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    expect(store.getState().date).toBe('20261104')

    // 編集後の期間は 11/10(火)から。11/4 は外なので、期間の中の最初の平日に移す
    const edited = editedOf(base, false, false, { start: '20261110', end: '20261130' })
    store.getState().setEdited(edited)
    expect(store.getState().date).toBe('20261110')
    expect(selectablePeriod(store.getState())).toEqual({ start: '20261110', end: '20261130' })
    await settle()
    expect(store.getState().snapshot?.date).toBe('20261110')
    expect(store.getState().snapshot?.baseline).toBeDefined()

    expect(store.getState().setDate('20261105')).toBe('比較できるのは減便後の GTFS の運行期間(2026/11/10〜2026/11/30)の日付です。')
    expect(store.getState().date).toBe('20261110')
    expect(store.getState().setDate('20261112')).toBeNull()
    await settle()
    expect(store.getState().snapshot?.date).toBe('20261112')

    // 期間の中の日付なら、編集後を渡しても動かさない
    store.getState().setEdited(editedOf(base, true, false, { start: '20261110', end: '20261130' }))
    expect(store.getState().date).toBe('20261112')

    // 編集後が無くなれば、基準の運行期間で選べる
    store.getState().setEdited(null)
    expect(selectablePeriod(store.getState())).toEqual({ start: '20261001', end: '20261130' })
    expect(store.getState().setDate('20261105')).toBeNull()
  })

  it('読み込み直すと編集後を捨てる', async () => {
    const { store, compute } = setup()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    store.getState().setEdited(editedOf(base, false))
    await settle()
    expect(store.getState().snapshot?.baseline).toBeDefined()

    store.getState().setSource(sourceOf(compareFeed()))
    expect(store.getState().edited).toBeNull()
    await settle()
    // 読み込み直した基準は、同じ条件でも計算し直す(前の基準の結果は使わない)
    expect(compute).toHaveBeenCalledTimes(3)
    expect(store.getState().snapshot?.baseline).toBeUndefined()
    expect(store.getState().snapshot?.comparison).toBeUndefined()

    // 捨てたあとに基準が無ければ、編集後は受け取らない
    store.getState().setSource(null)
    store.getState().setEdited(editedOf(base, false))
    expect(store.getState().edited).toBeNull()
  })

  it('乗れる行が1つも無い停留所は起点にしない', async () => {
    const { store, compute } = setup()
    // P は R1 7:00 の途中だが pickup_type が 1(降車専用)。B はどの便でも終点
    const feed = compareFeed(
      [{ stop_id: 'P', stop_name: '降車専用', stop_lat: '43.6690', stop_lon: '142.507' }],
      [['A', '07:00:00'], ['P', '07:05:00', '1'], ['B', '07:10:00']],
    )
    store.getState().setSource(sourceOf(feed))
    await settle()

    expect(store.getState().origins!.stops.map((s) => s.id)).toEqual(['A', 'C', 'S9', 'D'])
    expect(compute.mock.calls[0][0].stops).toHaveLength(4)
    expect(store.getState().snapshot?.origin).toEqual({ origins: 4, unused: 0, nonStop: 0, noBoarding: 2 })
  })

  it('便を足し戻すと、そのまわりのセルが減便で外れたセルから外れる', async () => {
    const { store } = setupReal()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()

    store.getState().setEdited(editedOf(base, false))
    await settle()
    const removed = store.getState().snapshot!
    const around = cellsAroundS9(removed.result.cells)
    expect(removed.comparison!.bands[0].lostCells).toBe(around.length)
    expect(around.length).toBeGreaterThan(0)

    // R3_0730_WK を足し戻す
    store.getState().setEdited(editedOf(base, true))
    await settle()
    const restored = store.getState().snapshot!
    expect(restored.comparison!.bands[0].lostCells).toBe(0)
    for (const i of around) expect(restored.result.reachable[0][i]).toBe(true)
    // 19:00 の便(A・C)は足し戻していないので、18〜21時の外れたセルは変わらない
    expect(restored.comparison!.bands[4].lostCells).toBe(removed.comparison!.bands[4].lostCells)
    expect(restored.comparison!.bands[4].lostCells).toBeGreaterThan(0)
    expect(restored.zeroStops?.some((z) => z.stopId === 'S9')).toBe(false)
  })

  it('方針を承認したあと、外れたセルが最も多い時間帯を選ぶ', async () => {
    const { store } = setupReal()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    expect(store.getState().selectedHour).toBe(6)

    // 下書きの間は動かさない
    store.getState().setEdited(editedOf(base, false, true))
    await settle()
    expect(store.getState().selectedHour).toBe(6)

    // 承認すると、外れたセルが最も多い 18〜21時(A・C の 19:00 が消える)を選ぶ
    store.getState().setEdited(editedOf(base, false, false))
    await settle()
    const lost = store.getState().snapshot!.comparison!.bands.map((b) => b.lostCells)
    expect(Math.max(...lost)).toBe(lost[4])
    expect(lost[4]).toBeGreaterThan(lost[0])
    expect(store.getState().selectedHour).toBe(18)
  })

  it('外れたセルの数が同じ時間帯が複数あれば、遅い時間帯を選ぶ(夜の空白を見せるため)', async () => {
    // 偽の計算:その時間帯に出発のある停留所が1つでもあれば1つ目のセルに届く。
    // 基準は 6〜9時(A 7:00・S9 7:30)・9〜12時(D 9:00)・18〜21時(A・C 19:00)、編集後は 6〜9時(A 8:00)だけ
    const { store } = setup()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    store.getState().setEdited(editedOf(base, false, false))
    await settle()
    expect(store.getState().snapshot!.comparison!.bands.map((b) => b.lostCells)).toEqual([0, 1, 0, 0, 1, 0])
    expect(store.getState().selectedHour).toBe(18)
  })

  it('利用者が時間帯を選んだあとは、方針を承認しても時間帯を動かさない', async () => {
    const { store } = setupReal()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    store.getState().selectHour(9)
    store.getState().setEdited(editedOf(base, false, false))
    await settle()
    expect(store.getState().snapshot?.comparison?.bands[4].lostCells).toBeGreaterThan(0)
    expect(store.getState().selectedHour).toBe(9)
  })

  it("全便で乗れる行が無くなった停留所は 'feed'、その日だけ 0 なら 'day' にする", async () => {
    const { store } = setup()
    const base = compareFeed()
    store.getState().setSource(sourceOf(base))
    await settle()
    store.getState().setEdited(editedOf(base, false))
    await settle()
    // C(19:05)と S9(7:30)は編集後のどの便も通らない。D は日曜の便が残る(水曜だけ 0)。A は 8:00 が残る
    expect(store.getState().snapshot?.zeroStops).toEqual([
      { stopId: 'C', name: 'C', beforeDepartures: 1, scope: 'feed' },
      { stopId: 'S9', name: 'S9', beforeDepartures: 1, scope: 'feed' },
      { stopId: 'D', name: 'D', beforeDepartures: 1, scope: 'day' },
    ])
  })
})
