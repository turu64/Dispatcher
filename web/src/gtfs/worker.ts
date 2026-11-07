/**
 * GTFS の読み込みを動かす Web Worker。
 * 中ですることは loadGtfsZip を呼んで結果を返すことだけ。画面側の窓口は workerClient.ts。
 * メッセージの処理は純粋な関数(handleGtfsWorkerRequest)に分けてあり、Vitest(node)ではそれをテストする。
 */
import { type GtfsFeed, loadGtfsZip } from './load'

/** 画面から Worker への要求。id は要求ごとの番号で、返事と突き合わせるのに使う */
export interface GtfsWorkerRequest {
  id: number
  data: Blob | ArrayBuffer
}

/** Worker から画面への返事。失敗はメッセージ(日本語)だけを運ぶ */
export type GtfsWorkerResponse =
  | { id: number; ok: true; feed: GtfsFeed }
  | { id: number; ok: false; message: string }

/** Worker の中の globalThis のうち、ここで使う部分(tsconfig の lib に webworker が無いため自分で型を書く) */
export interface GtfsWorkerScope {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: GtfsWorkerResponse): void
}

const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/
const UNREADABLE = 'GTFS を読み込めませんでした。ファイルが壊れているか、大きすぎる可能性があります。ファイルを選び直してください。'

/**
 * 失敗を画面に出すメッセージにする。loadGtfsZip が出す日本語のメッセージはそのまま使う。
 * JSZip やブラウザが出す英語のメッセージ(圧縮データの破損、ファイルの読み取り失敗など)は、
 * 画面は日本語のみのため使わず、日本語の固定のメッセージにする(元の Error はコンソールに残す)。
 */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (JAPANESE.test(message)) return message
  console.error('GTFS の読み込みに失敗しました', error)
  return UNREADABLE
}

/** 要求を1件処理して返事を作る。失敗しても例外にせず、ok: false の返事にする */
export async function handleGtfsWorkerRequest(
  request: GtfsWorkerRequest,
  load: (data: Blob | ArrayBuffer) => Promise<GtfsFeed> = loadGtfsZip,
): Promise<GtfsWorkerResponse> {
  try {
    return { id: request.id, ok: true, feed: await load(request.data) }
  } catch (error) {
    return { id: request.id, ok: false, message: messageOf(error) }
  }
}

/** 番号と ZIP の中身がそろった要求か。受け取る値は外から来るので形を確かめる */
function isRequest(value: unknown): value is GtfsWorkerRequest {
  if (typeof value !== 'object' || value === null) return false
  const { id, data } = value as Record<string, unknown>
  return typeof id === 'number' && (data instanceof Blob || data instanceof ArrayBuffer)
}

function idOf(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null
  const { id } = value as Record<string, unknown>
  return typeof id === 'number' ? id : null
}

/** 返事を送る。結果を複製できずに送れなかったときも、画面側が待ち続けないよう失敗の返事を送る */
function reply(scope: GtfsWorkerScope, response: GtfsWorkerResponse): void {
  try {
    scope.postMessage(response)
  } catch {
    scope.postMessage({ id: response.id, ok: false, message: '読み込んだ結果を画面に渡せませんでした。' })
  }
}

/** scope に受信の処理を登録する */
export function startGtfsWorker(scope: GtfsWorkerScope, load = loadGtfsZip): void {
  scope.addEventListener('message', (event) => {
    const message = event.data
    if (isRequest(message)) {
      void handleGtfsWorkerRequest(message, load).then((response) => reply(scope, response))
      return
    }
    // 番号が分かる不正な要求には失敗の返事をして、画面側の待ちを終わらせる。番号も無ければ捨てる
    const id = idOf(message)
    if (id !== null) reply(scope, { id, ok: false, message: 'GTFS の読み込み要求の形が正しくありません。' })
  })
}

// Worker の中(画面の document が無く、postMessage がある)で読み込まれたときだけ登録する。
// テストや画面側から import されたときは何もしない
if (typeof self !== 'undefined' && typeof document === 'undefined' && typeof self.postMessage === 'function') {
  startGtfsWorker(self as unknown as GtfsWorkerScope)
}
