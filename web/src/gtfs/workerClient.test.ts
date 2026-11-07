import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import { type GtfsFeed, loadGtfsZip } from './load'
import { createGtfsWorkerClient, type GtfsWorkerLike, loadGtfsInWorker } from './workerClient'
import {
  type GtfsWorkerRequest,
  type GtfsWorkerResponse,
  type GtfsWorkerScope,
  handleGtfsWorkerRequest,
  startGtfsWorker,
} from './worker'

async function makeZip(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'arraybuffer' })
}

/** 中身の目印にするため、行数だけが違う最小のフィードを作る */
function feedOf(rows: number): GtfsFeed {
  return {
    tables: new Map([
      [
        'stops',
        { fileName: 'stops.txt', fields: ['stop_id'], rows: Array.from({ length: rows }, (_, i) => ({ stop_id: `S${i}` })) },
      ],
    ]),
    warnings: [],
  }
}

/** 「ArrayBuffer の長さ = 行数」のフィードを返す読み込み。resolvers で完了の順番を操れる */
function controlledLoad() {
  const resolvers = new Map<number, () => void>()
  const load = vi.fn(
    (data: Blob | ArrayBuffer) =>
      new Promise<GtfsFeed>((resolve) => {
        const size = (data as ArrayBuffer).byteLength
        resolvers.set(size, () => resolve(feedOf(size)))
      }),
  )
  return { load, finish: (size: number) => resolvers.get(size)?.() }
}

/**
 * Worker の本物の代わりに、画面側と Worker 側を structuredClone でつなぐ。
 * startGtfsWorker の登録と返事、Map の複製までを、プロセスの中で通す。
 */
function createLoopback(load?: (data: Blob | ArrayBuffer) => Promise<GtfsFeed>) {
  const toWorkerSide: Array<(event: { data: unknown }) => void> = []
  const toClientSide = { message: [] as Array<(event: Event) => void>, error: [] as Array<(event: Event) => void>, messageerror: [] as Array<(event: Event) => void> }
  const sent: GtfsWorkerRequest[] = []

  const scope: GtfsWorkerScope = {
    addEventListener: (_type, listener) => void toWorkerSide.push(listener),
    postMessage: (message) => {
      const copy = structuredClone(message)
      queueMicrotask(() => toClientSide.message.forEach((l) => l({ data: copy } as unknown as Event)))
    },
  }
  const worker: GtfsWorkerLike = {
    postMessage: (message) => {
      sent.push(message)
      const copy = structuredClone(message)
      queueMicrotask(() => toWorkerSide.forEach((l) => l({ data: copy })))
    },
    addEventListener: (type, listener) => void toClientSide[type].push(listener),
    terminate: vi.fn(),
  }
  startGtfsWorker(scope, load)
  return {
    worker,
    sent,
    /** Worker 側から、画面側にそのままの値を送る */
    emit: (type: 'message' | 'error' | 'messageerror', data?: unknown) =>
      toClientSide[type].forEach((l) => l({ data } as unknown as Event)),
  }
}

describe('handleGtfsWorkerRequest', () => {
  it('ZIP を読み、要求の番号つきで feed を返す', async () => {
    const data = await makeZip({ 'stops.txt': 'stop_id,stop_name\nA,駅前\n' })
    const response = await handleGtfsWorkerRequest({ id: 7, data })
    expect(response).toMatchObject({ id: 7, ok: true })
    if (!response.ok) return
    expect(response.feed.tables.get('stops')?.rows).toEqual([{ stop_id: 'A', stop_name: '駅前' }])
  })

  it('読めない ZIP は、日本語のメッセージの失敗にする(例外にしない)', async () => {
    const response = await handleGtfsWorkerRequest({ id: 3, data: new Blob(['<html>not found</html>']) })
    expect(response).toEqual({
      id: 3,
      ok: false,
      message: 'ZIP として開けませんでした。GTFS の ZIP ファイルを選んでください。',
    })
  })

  it('Error でない値が投げられても、文字にして失敗にする', async () => {
    const response = await handleGtfsWorkerRequest({ id: 1, data: new ArrayBuffer(0) }, () => Promise.reject('壊れた'))
    expect(response).toEqual({ id: 1, ok: false, message: '壊れた' })
  })

  it('渡したデータをそのまま読み込み関数に渡す', async () => {
    const load = vi.fn(async () => feedOf(0))
    const data = new ArrayBuffer(4)
    await handleGtfsWorkerRequest({ id: 1, data }, load)
    expect(load).toHaveBeenCalledWith(data)
  })
})

describe('startGtfsWorker', () => {
  function fakeScope() {
    let listener: ((event: { data: unknown }) => void) | undefined
    const posted: GtfsWorkerResponse[] = []
    const scope: GtfsWorkerScope = {
      addEventListener: (_type, l) => void (listener = l),
      postMessage: (m) => void posted.push(m),
    }
    return { scope, posted, receive: (data: unknown) => listener?.({ data }) }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('受け取った要求を処理して、返事を送る', async () => {
    const { scope, posted, receive } = fakeScope()
    startGtfsWorker(scope, async () => feedOf(2))
    receive({ id: 5, data: new ArrayBuffer(1) })
    await tick()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ id: 5, ok: true })
  })

  it('完了の順番が入れ替わっても、返事は要求の番号で対応する', async () => {
    const { scope, posted, receive } = fakeScope()
    const { load, finish } = controlledLoad()
    startGtfsWorker(scope, load)
    receive({ id: 1, data: new ArrayBuffer(10) })
    receive({ id: 2, data: new ArrayBuffer(20) })
    finish(20)
    await tick()
    finish(10)
    await tick()
    expect(posted.map((r) => r.id)).toEqual([2, 1])
    expect(posted.map((r) => (r.ok ? r.feed.tables.get('stops')?.rows.length : null))).toEqual([20, 10])
  })

  it('番号はあるが形の違う要求には、失敗の返事をして待ちを終わらせる', async () => {
    const { scope, posted, receive } = fakeScope()
    startGtfsWorker(scope, async () => feedOf(0))
    receive({ id: 9, data: 'ZIP ではない文字' })
    await tick()
    expect(posted).toEqual([{ id: 9, ok: false, message: 'GTFS の読み込み要求の形が正しくありません。' }])
  })

  it('番号も無い要求は捨てる', async () => {
    const { scope, posted, receive } = fakeScope()
    const load = vi.fn(async () => feedOf(0))
    startGtfsWorker(scope, load)
    for (const junk of [null, undefined, 'x', 42, {}, { data: new ArrayBuffer(1) }, { id: 'a', data: new ArrayBuffer(1) }]) {
      receive(junk)
    }
    await tick()
    expect(posted).toEqual([])
    expect(load).not.toHaveBeenCalled()
  })

  it('結果を複製できず送れなかったときは、失敗の返事を送り直す', async () => {
    const posted: GtfsWorkerResponse[] = []
    let listener: ((event: { data: unknown }) => void) | undefined
    let first = true
    const scope: GtfsWorkerScope = {
      addEventListener: (_type, l) => void (listener = l),
      postMessage: (m) => {
        if (first) {
          first = false
          throw new Error('DataCloneError')
        }
        posted.push(m)
      },
    }
    startGtfsWorker(scope, async () => feedOf(1))
    listener?.({ data: { id: 4, data: new ArrayBuffer(1) } })
    await tick()
    expect(posted).toEqual([{ id: 4, ok: false, message: '読み込んだ結果を画面に渡せませんでした。' }])
  })
})

describe('createGtfsWorkerClient', () => {
  it('Worker は最初の読み込みまで作らず、以降は使い回す', async () => {
    const loopback = createLoopback(async () => feedOf(1))
    const createWorker = vi.fn(() => loopback.worker)
    const client = createGtfsWorkerClient(createWorker)
    expect(createWorker).not.toHaveBeenCalled()
    await client.load(new ArrayBuffer(1))
    await client.load(new ArrayBuffer(1))
    expect(createWorker).toHaveBeenCalledTimes(1)
  })

  it('要求ごとに異なる番号を付ける', async () => {
    const loopback = createLoopback(async () => feedOf(1))
    const client = createGtfsWorkerClient(() => loopback.worker)
    await Promise.all([client.load(new ArrayBuffer(1)), client.load(new ArrayBuffer(2)), client.load(new ArrayBuffer(3))])
    const ids = loopback.sent.map((r) => r.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('同時の読み込みで返事の順番が入れ替わっても、取り違えない', async () => {
    const { load, finish } = controlledLoad()
    const loopback = createLoopback(load)
    const client = createGtfsWorkerClient(() => loopback.worker)
    const first = client.load(new ArrayBuffer(10))
    const second = client.load(new ArrayBuffer(20))
    const third = client.load(new ArrayBuffer(30))
    // 完了の順番を 3 → 1 → 2 にする
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3))
    finish(30)
    const feed3 = await third
    finish(10)
    const feed1 = await first
    finish(20)
    const feed2 = await second
    expect(feed1.tables.get('stops')?.rows).toHaveLength(10)
    expect(feed2.tables.get('stops')?.rows).toHaveLength(20)
    expect(feed3.tables.get('stops')?.rows).toHaveLength(30)
  })

  it('1 件の失敗は、その要求だけを日本語のメッセージで reject し、ほかの要求と後続には影響しない', async () => {
    const loopback = createLoopback(async (data) => {
      if ((data as ArrayBuffer).byteLength === 0) throw new Error('GTFS のファイル(.txt)が見つかりません。')
      return feedOf(1)
    })
    const client = createGtfsWorkerClient(() => loopback.worker)
    const bad = client.load(new ArrayBuffer(0))
    const good = client.load(new ArrayBuffer(8))
    await expect(bad).rejects.toThrow('GTFS のファイル(.txt)が見つかりません。')
    await expect(good).resolves.toBeDefined()
    await expect(client.load(new ArrayBuffer(8))).resolves.toBeDefined()
  })

  it('本物の ZIP を、構造化複製を通しても同じ feed で受け取る(Map のまま)', async () => {
    const files = {
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,駅前,43.76,142.36\n',
      'calendar.txt': 'service_id,monday\n平日,1\n',
    }
    const data = await makeZip(files)
    const expected = await loadGtfsZip(data)
    const loopback = createLoopback()
    const client = createGtfsWorkerClient(() => loopback.worker)

    const fromBuffer = await client.load(data)
    const fromBlob = await client.load(new Blob([data]))
    expect(fromBuffer.tables).toBeInstanceOf(Map)
    expect(fromBuffer).toEqual(expected)
    expect(fromBlob).toEqual(expected)
    // 渡した ArrayBuffer は取り上げられず、呼び出し側で使い続けられる
    expect(data.byteLength).toBeGreaterThan(0)
  })

  it('読めない ZIP の失敗を、日本語のメッセージのまま受け取る', async () => {
    const loopback = createLoopback()
    const client = createGtfsWorkerClient(() => loopback.worker)
    await expect(client.load(new Blob(['not a zip']))).rejects.toThrow('ZIP として開けませんでした')
  })

  it('番号に当たらない返事と、形の違う返事は捨てて、待ちはそのまま続ける', async () => {
    const { load, finish } = controlledLoad()
    const loopback = createLoopback(load)
    const client = createGtfsWorkerClient(() => loopback.worker)
    const result = client.load(new ArrayBuffer(5))
    await vi.waitFor(() => expect(load).toHaveBeenCalled())
    for (const junk of [null, 'x', 1, {}, { id: 999, ok: true, feed: feedOf(0) }, { id: 'a', ok: false, message: 'x' }]) {
      loopback.emit('message', junk)
    }
    finish(5)
    await expect(result).resolves.toBeDefined()
  })

  it('終わった要求と同じ番号の返事があとから届いても、無視して、いま待っている別の読み込みに影響しない', async () => {
    const { load, finish } = controlledLoad()
    const loopback = createLoopback(load)
    const client = createGtfsWorkerClient(() => loopback.worker)
    const done = client.load(new ArrayBuffer(3))
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    finish(3)
    const doneFeed = await done
    const doneId = loopback.sent[0].id

    const waiting = client.load(new ArrayBuffer(4))
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    // 終わった番号の失敗と成功が、待ちの途中でもう一度届く
    loopback.emit('message', { id: doneId, ok: false, message: 'あとから届いた失敗' })
    loopback.emit('message', { id: doneId, ok: true, feed: feedOf(99) })
    finish(4)
    const waitingFeed = await waiting
    expect(waitingFeed.tables.get('stops')?.rows).toHaveLength(4)
    expect(doneFeed.tables.get('stops')?.rows).toHaveLength(3)
  })

  it('Worker が異常終了したら、待っている読み込みをすべて失敗にし、次は新しい Worker を作る', async () => {
    const { load } = controlledLoad()
    const first = createLoopback(load)
    const second = createLoopback(async () => feedOf(2))
    const workers = [first.worker, second.worker]
    const createWorker = vi.fn(() => workers.shift() as GtfsWorkerLike)
    const client = createGtfsWorkerClient(createWorker)

    const a = client.load(new ArrayBuffer(10))
    const b = client.load(new ArrayBuffer(20))
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    first.emit('error')
    await expect(a).rejects.toThrow('GTFS を読み込む処理が途中で止まりました')
    await expect(b).rejects.toThrow('GTFS を読み込む処理が途中で止まりました')
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)

    const feed = await client.load(new ArrayBuffer(1))
    expect(createWorker).toHaveBeenCalledTimes(2)
    expect(feed.tables.get('stops')?.rows).toHaveLength(2)
  })

  it('messageerror(返事を読み取れない)も異常終了として扱う', async () => {
    const { load } = controlledLoad()
    const loopback = createLoopback(load)
    const client = createGtfsWorkerClient(() => loopback.worker)
    const result = client.load(new ArrayBuffer(10))
    await vi.waitFor(() => expect(load).toHaveBeenCalled())
    loopback.emit('messageerror')
    await expect(result).rejects.toThrow('GTFS を読み込む処理が途中で止まりました')
  })

  it('捨てた Worker から遅れて届いた error は、新しい Worker の読み込みに影響しない', async () => {
    const first = createLoopback(async () => feedOf(1))
    const { load, finish } = controlledLoad()
    const second = createLoopback(load)
    const workers = [first.worker, second.worker]
    const client = createGtfsWorkerClient(() => workers.shift() as GtfsWorkerLike)

    await client.load(new ArrayBuffer(1))
    first.emit('error') // 待ちが無くても Worker は捨てる
    const waiting = client.load(new ArrayBuffer(7)) // 新しい Worker が受ける
    await vi.waitFor(() => expect(load).toHaveBeenCalled())
    first.emit('error') // 捨てた Worker のイベントが、もう一度遅れて届く
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)
    finish(7)
    await expect(waiting).resolves.toBeDefined()
  })

  it('Worker を作れなければ、日本語のメッセージで reject し、次の読み込みでもう一度作る', async () => {
    const loopback = createLoopback(async () => feedOf(1))
    let calls = 0
    const client = createGtfsWorkerClient(() => {
      if (calls++ === 0) throw new Error('boom')
      return loopback.worker
    })
    await expect(client.load(new ArrayBuffer(1))).rejects.toThrow('GTFS を読み込む処理を開始できませんでした')
    await expect(client.load(new ArrayBuffer(1))).resolves.toBeDefined()
  })

  it('要求を送れなければ(データを複製できない)、日本語のメッセージで reject する', async () => {
    const worker: GtfsWorkerLike = {
      postMessage: () => {
        throw new Error('DataCloneError')
      },
      addEventListener: () => {},
      terminate: () => {},
    }
    const client = createGtfsWorkerClient(() => worker)
    await expect(client.load(new ArrayBuffer(1))).rejects.toThrow('選んだファイルを読み込み処理に渡せませんでした')
  })

  it('dispose で Worker を止め、待っている読み込みを失敗にする。その後の読み込みは新しい Worker で動く', async () => {
    const { load } = controlledLoad()
    const first = createLoopback(load)
    const second = createLoopback(async () => feedOf(3))
    const workers = [first.worker, second.worker]
    const client = createGtfsWorkerClient(() => workers.shift() as GtfsWorkerLike)

    const waiting = client.load(new ArrayBuffer(10))
    await vi.waitFor(() => expect(load).toHaveBeenCalled())
    client.dispose()
    await expect(waiting).rejects.toThrow('GTFS の読み込みを中止しました')
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)

    const feed = await client.load(new ArrayBuffer(1))
    expect(feed.tables.get('stops')?.rows).toHaveLength(3)
  })

  it('Worker を作る前の dispose は何も起こさない', () => {
    const createWorker = vi.fn()
    const client = createGtfsWorkerClient(createWorker)
    expect(() => client.dispose()).not.toThrow()
    expect(createWorker).not.toHaveBeenCalled()
  })
})

describe('loadGtfsInWorker', () => {
  // Vitest の node 環境には Worker が無い。ここでは、無いときの失敗の仕方だけを確かめる
  it.skipIf(typeof Worker !== 'undefined')('Worker を使えない環境では、日本語のメッセージで reject する', async () => {
    await expect(loadGtfsInWorker(new ArrayBuffer(0))).rejects.toThrow('GTFS を読み込む処理を開始できませんでした')
  })
})
