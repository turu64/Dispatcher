/**
 * 到達圏の計算を動かす Web Worker。
 * 中ですることは computeReach を呼んで結果を返すことだけ。画面側の窓口は workerClient.ts。
 * メッセージの処理は純粋な関数(handleReachWorkerRequest)に分けてあり、Vitest(node)ではそれをテストする。
 * (web/src/gtfs/worker.ts と同じ作り)
 */
import { computeReach, type ReachInput, type ReachResult } from './reach'

/** 画面から Worker への要求。id は要求ごとの番号で、返事と突き合わせるのに使う */
export interface ReachWorkerRequest {
  id: number
  input: ReachInput
}

/** Worker から画面への返事。失敗はメッセージ(日本語)だけを運ぶ */
export type ReachWorkerResponse =
  | { id: number; ok: true; result: ReachResult }
  | { id: number; ok: false; message: string }

/** Worker の中の globalThis のうち、ここで使う部分(tsconfig の lib に webworker が無いため自分で型を書く) */
export interface ReachWorkerScope {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: ReachWorkerResponse): void
}

const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/
const FAILED = '到達圏を計算できませんでした。ページを読み込み直して、もう一度お試しください。'

/**
 * 失敗を画面に出すメッセージにする。computeReach や mesh.ts が出す日本語のメッセージはそのまま使う。
 * メモリ不足など、ブラウザが出す英語のメッセージは、画面は日本語のみのため使わず、
 * 日本語の固定のメッセージにする(元の Error はコンソールに残す)。
 */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (JAPANESE.test(message)) return message
  console.error('到達圏の計算に失敗しました', error)
  return FAILED
}

/** 要求を1件処理して返事を作る。失敗しても例外にせず、ok: false の返事にする */
export function handleReachWorkerRequest(
  request: ReachWorkerRequest,
  compute: (input: ReachInput) => ReachResult = computeReach,
): ReachWorkerResponse {
  try {
    return { id: request.id, ok: true, result: compute(request.input) }
  } catch (error) {
    return { id: request.id, ok: false, message: messageOf(error) }
  }
}

/** 番号と計算の条件がそろった要求か。受け取る値は外から来るので、外側の形だけを確かめる(中身は computeReach が確かめる) */
function isRequest(value: unknown): value is ReachWorkerRequest {
  if (typeof value !== 'object' || value === null) return false
  const { id, input } = value as Record<string, unknown>
  if (typeof id !== 'number' || typeof input !== 'object' || input === null) return false
  const { stops, params } = input as Record<string, unknown>
  return Array.isArray(stops) && typeof params === 'object' && params !== null
}

function idOf(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null
  const { id } = value as Record<string, unknown>
  return typeof id === 'number' ? id : null
}

/** 返事を送る。結果を複製できずに送れなかったときも、画面側が待ち続けないよう失敗の返事を送る */
function reply(scope: ReachWorkerScope, response: ReachWorkerResponse): void {
  try {
    scope.postMessage(response)
  } catch {
    scope.postMessage({ id: response.id, ok: false, message: '計算した到達圏を画面に渡せませんでした。' })
  }
}

/** scope に受信の処理を登録する */
export function startReachWorker(scope: ReachWorkerScope, compute: (input: ReachInput) => ReachResult = computeReach): void {
  scope.addEventListener('message', (event) => {
    const message = event.data
    if (isRequest(message)) {
      reply(scope, handleReachWorkerRequest(message, compute))
      return
    }
    // 番号が分かる不正な要求には失敗の返事をして、画面側の待ちを終わらせる。番号も無ければ捨てる
    const id = idOf(message)
    if (id !== null) reply(scope, { id, ok: false, message: '到達圏の計算要求の形が正しくありません。' })
  })
}

// Worker の中(画面の document が無く、postMessage がある)で読み込まれたときだけ登録する。
// テストや画面側から import されたときは何もしない
if (typeof self !== 'undefined' && typeof document === 'undefined' && typeof self.postMessage === 'function') {
  startReachWorker(self as unknown as ReachWorkerScope)
}
