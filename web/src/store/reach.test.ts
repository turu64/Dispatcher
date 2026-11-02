import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GtfsFeed, GtfsRow } from '../gtfs/load'
import { toStops } from '../gtfs/parse'
import type { ReachInput, ReachResult } from '../reach/reach'
import type { RefLoadResult } from '../reach/refData'
import { createReachStore, type ReachSource, type ReachStoreDeps } from './reach'

function table(fileName: string, rows: GtfsRow[]) {
  return { fileName, fields: Object.keys(rows[0] ?? {}), rows }
}

/** 平日(01)だけの小さなフィード。停留所 A・B を 1 便が 7:00・7:10 に通り、B が終点 */
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
    // A は 7:00 に出発(6〜9時)、B は終点なので数えない
    expect(input.stops).toEqual([
      { lat: 43.6667, lon: 142.5, bandCounts: [1, 0, 0, 0, 0, 0] },
      { lat: 43.67, lon: 142.51, bandCounts: [0, 0, 0, 0, 0, 0] },
    ])
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
    // 6542 の南端(43.333…度)から約 2.2km の停留所
    const stops = [{ stop_id: 'A', stop_name: 'A', stop_lat: String(130 / 3 + 0.02), stop_lon: '142.5' }]
    const { store, loadRef } = setup()
    store.getState().setSource(sourceOf(makeFeed(stops)))
    await settle()
    store.getState().setDensityThreshold(2000)
    await settle()
    expect(loadRef).toHaveBeenCalledTimes(1)
    expect(loadRef.mock.calls[0][0]).toEqual(['6542'])

    store.getState().setWalkMinutes('urban', 'bus', 30)
    await settle()
    expect(loadRef).toHaveBeenCalledTimes(2)
    expect(loadRef.mock.calls[1][0]).toEqual(['6442', '6542'])
    expect(store.getState().snapshot?.params.walkMinutes.urban.bus).toBe(30)
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
