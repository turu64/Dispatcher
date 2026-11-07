import { describe, expect, it, vi } from 'vitest'
import { meshCenter, parentCode } from './mesh'
import { computeReach, DEFAULT_REACH_PARAMS, type ReachInput, type ReachResult } from './reach'
import { computeReachInWorker, createReachWorkerClient, type ReachWorkerLike } from './workerClient'
import {
  handleReachWorkerRequest,
  type ReachWorkerRequest,
  type ReachWorkerResponse,
  type ReachWorkerScope,
  startReachWorker,
} from './worker'

// 旭川市内の 125m セルと、その親の 250m セル
const T = '65425228243'
const C = meshCenter(T)

/** 参照データ(Map・Set)つきの小さな条件。bandCount を目印に使う */
function inputOf(bandCount = 2): ReachInput {
  return {
    stops: [{ lat: C.lat, lon: C.lon, bandCounts: new Array<number>(bandCount).fill(1) }],
    ref: { pop250: new Map([[parentCode(T, 10), 100]]), did125: new Set([T]), stations: [] },
    fallbackClass: 'suburban',
    params: DEFAULT_REACH_PARAMS,
    bandCount,
  }
}

/** 中身の目印にするため、時間帯の数だけが違う結果を作る */
function resultOf(bandCount: number): ReachResult {
  return {
    cells: [T],
    classes: ['urban'],
    reachable: Array.from({ length: bandCount }, () => [true]),
    coverable: [true],
    usedFallback: false,
    excludedStops: 0,
    cellPopulation: [25],
  }
}

/** 偽の Worker。送られた要求を記録し、返事やイベントはテストから好きな順で送る */
function fakeWorker() {
  const listeners = {
    message: [] as Array<(event: Event) => void>,
    error: [] as Array<(event: Event) => void>,
    messageerror: [] as Array<(event: Event) => void>,
  }
  const sent: ReachWorkerRequest[] = []
  const worker: ReachWorkerLike = {
    postMessage: (message) => void sent.push(message),
    addEventListener: (type, listener) => void listeners[type].push(listener),
    terminate: vi.fn(),
  }
  const emit = (type: 'message' | 'error' | 'messageerror', data?: unknown) =>
    listeners[type].forEach((l) => l({ data } as unknown as Event))
  return {
    worker,
    sent,
    emit,
    /** n 番目に送られた要求に、その時間帯の数の結果で答える */
    answer: (n: number) => emit('message', { id: sent[n].id, ok: true, result: resultOf(sent[n].input.bandCount) }),
  }
}

/**
 * Worker の本物の代わりに、画面側と Worker 側を structuredClone でつなぐ。
 * startReachWorker の登録と返事、Map・Set の複製までを、プロセスの中で通す。
 */
function createLoopback(compute?: (input: ReachInput) => ReachResult) {
  const toWorkerSide: Array<(event: { data: unknown }) => void> = []
  const toClientSide: Array<(event: Event) => void> = []
  const scope: ReachWorkerScope = {
    addEventListener: (_type, listener) => void toWorkerSide.push(listener),
    postMessage: (message) => {
      const copy = structuredClone(message)
      queueMicrotask(() => toClientSide.forEach((l) => l({ data: copy } as unknown as Event)))
    },
  }
  const worker: ReachWorkerLike = {
    postMessage: (message) => {
      const copy = structuredClone(message)
      queueMicrotask(() => toWorkerSide.forEach((l) => l({ data: copy })))
    },
    addEventListener: (type, listener) => {
      if (type === 'message') toClientSide.push(listener)
    },
    terminate: vi.fn(),
  }
  startReachWorker(scope, compute)
  return worker
}

describe('handleReachWorkerRequest', () => {
  it('到達圏を計算し、要求の番号つきで返す', () => {
    const input = inputOf()
    const response = handleReachWorkerRequest({ id: 7, input })
    expect(response).toEqual({ id: 7, ok: true, result: computeReach(input) })
  })

  it('computeReach の日本語のエラーは、そのまま失敗のメッセージにする(例外にしない)', () => {
    const response = handleReachWorkerRequest({ id: 3, input: { ...inputOf(), bandCount: -1 } })
    expect(response).toEqual({ id: 3, ok: false, message: '時間帯の数は 0 以上の整数で指定してください:-1' })
  })

  it('英語のエラーや Error でない値は、日本語の固定のメッセージにする', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fixed = '到達圏を計算できませんでした。ページを読み込み直して、もう一度お試しください。'
    const english = handleReachWorkerRequest({ id: 1, input: inputOf() }, () => {
      throw new RangeError('Invalid array length')
    })
    expect(english).toEqual({ id: 1, ok: false, message: fixed })
    const notError = handleReachWorkerRequest({ id: 2, input: inputOf() }, () => {
      throw 'boom'
    })
    expect(notError).toEqual({ id: 2, ok: false, message: fixed })
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('渡した条件をそのまま計算の関数に渡す', () => {
    const compute = vi.fn(() => resultOf(1))
    const input = inputOf()
    handleReachWorkerRequest({ id: 1, input }, compute)
    expect(compute).toHaveBeenCalledWith(input)
  })

  // 検証担当が足したもの:参照データを JSON のまま(Map・Set にせず)渡す誤りは、英語の TypeError ではなく日本語で知らせる
  it('参照データを JSON のまま渡したら、日本語のメッセージで失敗を返す(固定のメッセージにしない)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const json = { pop250: { [parentCode(T, 10)]: 100 }, did125: [T], stations: [] }
    const response = handleReachWorkerRequest({ id: 8, input: { ...inputOf(), ref: json as unknown as ReachInput['ref'] } })
    expect(response.ok).toBe(false)
    expect(!response.ok && response.message).toContain('参照データの形が正しくありません')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('startReachWorker', () => {
  function fakeScope() {
    let listener: ((event: { data: unknown }) => void) | undefined
    const posted: ReachWorkerResponse[] = []
    const scope: ReachWorkerScope = {
      addEventListener: (_type, l) => void (listener = l),
      postMessage: (m) => void posted.push(m),
    }
    return { scope, posted, receive: (data: unknown) => listener?.({ data }) }
  }

  it('受け取った要求を計算して、返事を送る', () => {
    const { scope, posted, receive } = fakeScope()
    startReachWorker(scope)
    receive({ id: 5, input: inputOf(3) })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ id: 5, ok: true })
    expect(posted[0].ok && posted[0].result.reachable).toHaveLength(3)
  })

  it('番号はあるが形の違う要求には、失敗の返事をして待ちを終わらせる', () => {
    const { scope, posted, receive } = fakeScope()
    const compute = vi.fn(() => resultOf(1))
    startReachWorker(scope, compute)
    receive({ id: 9, input: '条件ではない文字' })
    receive({ id: 10, input: { stops: 'x', params: {} } })
    receive({ id: 11, input: { stops: [], params: null } })
    expect(posted).toEqual([
      { id: 9, ok: false, message: '到達圏の計算要求の形が正しくありません。' },
      { id: 10, ok: false, message: '到達圏の計算要求の形が正しくありません。' },
      { id: 11, ok: false, message: '到達圏の計算要求の形が正しくありません。' },
    ])
    expect(compute).not.toHaveBeenCalled()
  })

  it('番号も無い要求は捨てる', () => {
    const { scope, posted, receive } = fakeScope()
    const compute = vi.fn(() => resultOf(1))
    startReachWorker(scope, compute)
    for (const junk of [null, undefined, 'x', 42, {}, { input: inputOf() }, { id: 'a', input: inputOf() }]) receive(junk)
    expect(posted).toEqual([])
    expect(compute).not.toHaveBeenCalled()
  })

  it('結果を複製できず送れなかったときは、失敗の返事を送り直す', () => {
    const posted: ReachWorkerResponse[] = []
    let listener: ((event: { data: unknown }) => void) | undefined
    let first = true
    const scope: ReachWorkerScope = {
      addEventListener: (_type, l) => void (listener = l),
      postMessage: (m) => {
        if (first) {
          first = false
          throw new Error('DataCloneError')
        }
        posted.push(m)
      },
    }
    startReachWorker(scope, () => resultOf(1))
    listener?.({ data: { id: 4, input: inputOf() } })
    expect(posted).toEqual([{ id: 4, ok: false, message: '計算した到達圏を画面に渡せませんでした。' }])
  })
})

describe('createReachWorkerClient', () => {
  it('Worker は最初の計算まで作らず、以降は使い回す', async () => {
    const worker = createLoopback()
    const createWorker = vi.fn(() => worker)
    const client = createReachWorkerClient(createWorker)
    expect(createWorker).not.toHaveBeenCalled()
    await client.compute(inputOf())
    await client.compute(inputOf())
    expect(createWorker).toHaveBeenCalledTimes(1)
  })

  it('本物の computeReach を、構造化複製を通しても同じ結果で受け取る(参照データの Map・Set も渡る)', async () => {
    const client = createReachWorkerClient(() => createLoopback())
    const input = inputOf(6)
    const result = await client.compute(input)
    expect(result).toEqual(computeReach(input))
    expect(result.classes[result.cells.indexOf(T)]).toBe('urban') // did125(Set)が Worker 側に届いている
    // 呼び出し側の条件は変わらずに使える
    expect(input.ref?.pop250).toBeInstanceOf(Map)
  })

  // 検証担当が足したもの
  it('参照データが無い(ref が null)条件も、構造化複製を通して usedFallback が true の結果で受け取る', async () => {
    const client = createReachWorkerClient(() => createLoopback())
    const input: ReachInput = { ...inputOf(3), ref: null, fallbackClass: 'rural' }
    const result = await client.compute(input)
    expect(result).toEqual(computeReach(input))
    expect(result.usedFallback).toBe(true)
    expect(new Set(result.classes)).toEqual(new Set(['rural']))
  })

  it('要求ごとに異なる番号を付ける', () => {
    const fake = fakeWorker()
    const client = createReachWorkerClient(() => fake.worker)
    void client.compute(inputOf(1))
    void client.compute(inputOf(2))
    void client.compute(inputOf(3))
    expect(new Set(fake.sent.map((r) => r.id)).size).toBe(3)
  })

  it('同時の計算で返事の順番が入れ替わっても、取り違えない', async () => {
    const fake = fakeWorker()
    const client = createReachWorkerClient(() => fake.worker)
    const first = client.compute(inputOf(1))
    const second = client.compute(inputOf(2))
    const third = client.compute(inputOf(3))
    fake.answer(2)
    fake.answer(0)
    fake.answer(1)
    expect((await first).reachable).toHaveLength(1)
    expect((await second).reachable).toHaveLength(2)
    expect((await third).reachable).toHaveLength(3)
  })

  it('1 件の失敗は、その要求だけを日本語のメッセージで reject し、ほかの要求と後続には影響しない', async () => {
    const client = createReachWorkerClient(() => createLoopback())
    const bad = client.compute({ ...inputOf(), bandCount: -1 })
    const good = client.compute(inputOf())
    await expect(bad).rejects.toThrow('時間帯の数は 0 以上の整数で指定してください')
    await expect(good).resolves.toBeDefined()
    await expect(client.compute(inputOf())).resolves.toBeDefined()
  })

  it('番号に当たらない返事と、形の違う返事は捨てて、待ちはそのまま続ける', async () => {
    const fake = fakeWorker()
    const client = createReachWorkerClient(() => fake.worker)
    const result = client.compute(inputOf(4))
    for (const junk of [null, 'x', 1, {}, { id: 999, ok: true, result: resultOf(9) }, { id: 'a', ok: false, message: 'x' }]) {
      fake.emit('message', junk)
    }
    fake.answer(0)
    expect((await result).reachable).toHaveLength(4)
  })

  it('失敗の返事にメッセージが無ければ、途中で止まった旨のメッセージにする', async () => {
    const fake = fakeWorker()
    const client = createReachWorkerClient(() => fake.worker)
    const result = client.compute(inputOf())
    fake.emit('message', { id: fake.sent[0].id, ok: false })
    await expect(result).rejects.toThrow('到達圏を計算する処理が途中で止まりました')
  })

  it('終わった要求と同じ番号の返事があとから届いても、無視して、いま待っている別の計算に影響しない', async () => {
    const fake = fakeWorker()
    const client = createReachWorkerClient(() => fake.worker)
    const done = client.compute(inputOf(3))
    fake.answer(0)
    expect((await done).reachable).toHaveLength(3)

    const waiting = client.compute(inputOf(4))
    fake.emit('message', { id: fake.sent[0].id, ok: false, message: 'あとから届いた失敗' })
    fake.emit('message', { id: fake.sent[0].id, ok: true, result: resultOf(99) })
    fake.answer(1)
    expect((await waiting).reachable).toHaveLength(4)
  })

  it('Worker が異常終了したら、待っている計算をすべて失敗にし、次は新しい Worker を作る', async () => {
    const first = fakeWorker()
    const second = fakeWorker()
    const workers = [first.worker, second.worker]
    const createWorker = vi.fn(() => workers.shift() as ReachWorkerLike)
    const client = createReachWorkerClient(createWorker)

    const a = client.compute(inputOf(1))
    const b = client.compute(inputOf(2))
    first.emit('error')
    await expect(a).rejects.toThrow('到達圏を計算する処理が途中で止まりました')
    await expect(b).rejects.toThrow('到達圏を計算する処理が途中で止まりました')
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)

    const c = client.compute(inputOf(5))
    expect(createWorker).toHaveBeenCalledTimes(2)
    second.answer(0)
    expect((await c).reachable).toHaveLength(5)
  })

  it('messageerror(返事を読み取れない)も異常終了として扱う', async () => {
    const fake = fakeWorker()
    const client = createReachWorkerClient(() => fake.worker)
    const result = client.compute(inputOf())
    fake.emit('messageerror')
    await expect(result).rejects.toThrow('到達圏を計算する処理が途中で止まりました')
  })

  it('捨てた Worker から遅れて届いた error は、新しい Worker の計算に影響しない', async () => {
    const first = fakeWorker()
    const second = fakeWorker()
    const workers = [first.worker, second.worker]
    const client = createReachWorkerClient(() => workers.shift() as ReachWorkerLike)

    const done = client.compute(inputOf(1))
    first.answer(0)
    await done
    first.emit('error') // 待ちが無くても Worker は捨てる
    const waiting = client.compute(inputOf(7)) // 新しい Worker が受ける
    first.emit('error') // 捨てた Worker のイベントが、もう一度遅れて届く
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)
    second.answer(0)
    expect((await waiting).reachable).toHaveLength(7)
  })

  it('Worker を作れなければ、日本語のメッセージで reject し、次の計算でもう一度作る', async () => {
    let calls = 0
    const client = createReachWorkerClient(() => {
      if (calls++ === 0) throw new Error('boom')
      return createLoopback()
    })
    await expect(client.compute(inputOf())).rejects.toThrow('到達圏を計算する処理を開始できませんでした')
    await expect(client.compute(inputOf())).resolves.toBeDefined()
  })

  it('要求を送れなければ(条件を複製できない)、日本語のメッセージで reject する', async () => {
    const worker: ReachWorkerLike = {
      postMessage: () => {
        throw new Error('DataCloneError')
      },
      addEventListener: () => {},
      terminate: () => {},
    }
    const client = createReachWorkerClient(() => worker)
    await expect(client.compute(inputOf())).rejects.toThrow('到達圏の計算の条件を計算処理に渡せませんでした')
  })

  it('dispose で Worker を止め、待っている計算を失敗にする。その後の計算は新しい Worker で動く', async () => {
    const first = fakeWorker()
    const workers = [first.worker, createLoopback()]
    const client = createReachWorkerClient(() => workers.shift() as ReachWorkerLike)

    const waiting = client.compute(inputOf())
    client.dispose()
    await expect(waiting).rejects.toThrow('到達圏の計算を中止しました')
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)
    await expect(client.compute(inputOf(3))).resolves.toMatchObject({ cells: expect.any(Array) })
  })

  it('Worker を作る前の dispose は何も起こさない', () => {
    const createWorker = vi.fn()
    const client = createReachWorkerClient(createWorker)
    expect(() => client.dispose()).not.toThrow()
    expect(createWorker).not.toHaveBeenCalled()
  })
})

describe('computeReachInWorker', () => {
  // Vitest の node 環境には Worker が無い。ここでは、無いときの失敗の仕方だけを確かめる
  it.skipIf(typeof Worker !== 'undefined')('Worker を使えない環境では、日本語のメッセージで reject する', async () => {
    await expect(computeReachInWorker(inputOf())).rejects.toThrow('到達圏を計算する処理を開始できませんでした')
  })
})
