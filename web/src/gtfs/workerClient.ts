/**
 * GTFS の読み込みを Web Worker に頼む、画面側の窓口。
 * 呼び出し側は loadGtfsInWorker(data) だけを使う。
 * 同時に複数の読み込みが来ても取り違えないよう、要求ごとに番号を付けて返事と突き合わせる。
 */
import type { GtfsFeed } from './load'
// 型だけを読み込む(worker.ts 本体と、その中の JSZip・Papa Parse を画面側の部品に含めないため)
import type { GtfsWorkerRequest } from './worker'

/** Worker のうち、ここで使う部分。テストでは偽物に差し替える */
export interface GtfsWorkerLike {
  postMessage(message: GtfsWorkerRequest): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void
  terminate(): void
}

export interface GtfsWorkerClient {
  /** ZIP を Worker に渡して読み込む。失敗は日本語のメッセージの Error で reject する */
  load(data: Blob | ArrayBuffer): Promise<GtfsFeed>
  /** Worker を止め、待っている読み込みはすべて失敗にする。次に load すると新しい Worker を作る */
  dispose(): void
}

const WORKER_START_FAILED =
  'GTFS を読み込む処理を開始できませんでした。パソコンの Chrome か Edge の最新版で開いてください。'
const WORKER_CRASHED = 'GTFS を読み込む処理が途中で止まりました。ページを読み込み直して、もう一度お試しください。'
const REQUEST_NOT_SENT = '選んだファイルを読み込み処理に渡せませんでした。ファイルを選び直してください。'
const DISPOSED = 'GTFS の読み込みを中止しました。'

interface Pending {
  resolve: (feed: GtfsFeed) => void
  reject: (error: Error) => void
}

/**
 * Worker の作り方を受け取って、窓口を作る。
 * Worker は最初の load で作り、以降は使い回す。異常終了したら捨てて、次の load で作り直す。
 */
export function createGtfsWorkerClient(createWorker: () => GtfsWorkerLike): GtfsWorkerClient {
  let worker: GtfsWorkerLike | null = null
  let nextId = 1
  // 返事を待っている要求。キーは要求の番号(Worker は 1 つだけ持つので、すべて今の Worker 宛て)
  const pending = new Map<number, Pending>()

  function rejectAll(message: string): void {
    const waiting = [...pending.values()]
    pending.clear()
    for (const { reject } of waiting) reject(new Error(message))
  }

  /** 返事を番号で待ち手に渡す。番号が分からない返事と、形の違う返事は捨てる */
  function receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const response = message as Record<string, unknown>
    const id = response.id
    if (typeof id !== 'number') return
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    if (response.ok === true) {
      waiter.resolve(response.feed as GtfsFeed)
    } else {
      waiter.reject(new Error(typeof response.message === 'string' ? response.message : WORKER_CRASHED))
    }
  }

  function ensureWorker(): GtfsWorkerLike {
    if (worker) return worker
    const created = createWorker()
    const fail = (): void => {
      // すでに捨てた Worker から遅れて届いたイベントは無視する
      if (worker !== created) return
      worker = null
      created.terminate()
      rejectAll(WORKER_CRASHED)
    }
    created.addEventListener('message', (event) => receive((event as MessageEvent).data))
    created.addEventListener('error', fail)
    created.addEventListener('messageerror', fail)
    worker = created
    return created
  }

  return {
    load(data) {
      let target: GtfsWorkerLike
      try {
        target = ensureWorker()
      } catch {
        return Promise.reject(new Error(WORKER_START_FAILED))
      }
      const id = nextId++
      return new Promise<GtfsFeed>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          // 渡した ArrayBuffer は複製される(transfer しない)ので、呼び出し側のデータは使えるまま残る
          target.postMessage({ id, data })
        } catch {
          pending.delete(id)
          reject(new Error(REQUEST_NOT_SENT))
        }
      })
    },
    dispose() {
      const current = worker
      worker = null
      current?.terminate()
      rejectAll(DISPOSED)
    },
  }
}

let defaultClient: GtfsWorkerClient | null = null

/**
 * GTFS の ZIP を Web Worker で読み込む。画面を止めない。
 * 結果は loadGtfsZip と同じ GtfsFeed(Map は構造化複製でそのまま渡る)。
 */
export function loadGtfsInWorker(data: Blob | ArrayBuffer): Promise<GtfsFeed> {
  defaultClient ??= createGtfsWorkerClient(() => {
    if (typeof Worker === 'undefined') throw new Error('Web Worker を使えません')
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  })
  return defaultClient.load(data)
}
