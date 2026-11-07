/**
 * 到達圏の計算を Web Worker に頼む、画面側の窓口。
 * 呼び出し側は computeReachInWorker(input) だけを使う。
 * 同時に複数の計算が来ても取り違えないよう、要求ごとに番号を付けて返事と突き合わせる。
 * (web/src/gtfs/workerClient.ts と同じ作り)
 *
 * Worker は要求を届いた順に1件ずつ計算する。日付や時間帯を続けて切り替えたときに古い結果を捨てるのは、呼び出し側の役目。
 */
// 型だけを読み込む(reach.ts の本体と kdbush を画面側の部品に含めないため)
import type { ReachInput, ReachResult } from './reach'
import type { ReachWorkerRequest } from './worker'

/** Worker のうち、ここで使う部分。テストでは偽物に差し替える */
export interface ReachWorkerLike {
  postMessage(message: ReachWorkerRequest): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void
  terminate(): void
}

export interface ReachWorkerClient {
  /** 条件を Worker に渡して到達圏を計算する。失敗は日本語のメッセージの Error で reject する */
  compute(input: ReachInput): Promise<ReachResult>
  /** Worker を止め、待っている計算はすべて失敗にする。次に compute すると新しい Worker を作る */
  dispose(): void
}

const WORKER_START_FAILED =
  '到達圏を計算する処理を開始できませんでした。パソコンの Chrome か Edge の最新版で開いてください。'
const WORKER_CRASHED = '到達圏を計算する処理が途中で止まりました。ページを読み込み直して、もう一度お試しください。'
const REQUEST_NOT_SENT = '到達圏の計算の条件を計算処理に渡せませんでした。ページを読み込み直して、もう一度お試しください。'
const DISPOSED = '到達圏の計算を中止しました。'

interface Pending {
  resolve: (result: ReachResult) => void
  reject: (error: Error) => void
}

/**
 * Worker の作り方を受け取って、窓口を作る。
 * Worker は最初の compute で作り、以降は使い回す。異常終了したら捨てて、次の compute で作り直す。
 */
export function createReachWorkerClient(createWorker: () => ReachWorkerLike): ReachWorkerClient {
  let worker: ReachWorkerLike | null = null
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
      waiter.resolve(response.result as ReachResult)
    } else {
      waiter.reject(new Error(typeof response.message === 'string' ? response.message : WORKER_CRASHED))
    }
  }

  function ensureWorker(): ReachWorkerLike {
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
    compute(input) {
      let target: ReachWorkerLike
      try {
        target = ensureWorker()
      } catch {
        return Promise.reject(new Error(WORKER_START_FAILED))
      }
      const id = nextId++
      return new Promise<ReachResult>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          // 条件(参照データの Map・Set を含む)は構造化複製で渡る。呼び出し側の値はそのまま使える
          target.postMessage({ id, input })
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

let defaultClient: ReachWorkerClient | null = null

/**
 * 到達圏を Web Worker で計算する。画面を止めない。
 * 結果は computeReach と同じ ReachResult。
 */
export function computeReachInWorker(input: ReachInput): Promise<ReachResult> {
  defaultClient ??= createReachWorkerClient(() => {
    if (typeof Worker === 'undefined') throw new Error('Web Worker を使えません')
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  })
  return defaultClient.compute(input)
}
