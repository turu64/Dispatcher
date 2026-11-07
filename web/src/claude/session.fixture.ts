import { vi } from 'vitest'
import type { SessionApi, SessionPostBody } from './session'
import type { SessionStreamEvent } from './sse'

/**
 * セッションのテスト(session.test.ts・store/chat.test.ts)で使う、中継の偽物。テストのファイルではない。
 * 本物の API は呼ばない
 */

/** 外から押し込めるイベントの流れ(中継のストリームの偽物) */
export function channel() {
  const queue: SessionStreamEvent[] = []
  let waiting: ((r: IteratorResult<SessionStreamEvent>) => void) | null = null
  let failWith: ((e: unknown) => void) | null = null
  let done = false
  let error: unknown = null
  const iterable: AsyncIterable<SessionStreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
          if (error) return Promise.reject(error)
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => {
            waiting = resolve
            failWith = reject
          })
        },
        return() {
          done = true
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
  return {
    iterable,
    push(...events: SessionStreamEvent[]) {
      for (const e of events) {
        if (waiting) {
          const w = waiting
          waiting = null
          failWith = null
          w({ value: e, done: false })
        } else queue.push(e)
      }
    },
    end() {
      done = true
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: undefined, done: true })
      }
    },
    fail(e: unknown) {
      error = e
      if (failWith) {
        const f = failWith
        waiting = null
        failWith = null
        f(e)
      }
    },
  }
}

export type Channel = ReturnType<typeof channel>

/** 中継の偽物。openStream ごとに流れを作り、POST と DELETE を記録する */
export function fakeApi() {
  const streams: { lastEventId: string | null; handle: string; ch: Channel; signal: AbortSignal }[] = []
  const posts: { handle: string; body: SessionPostBody; token: string | null }[] = []
  const removed: string[] = []
  const openFailures: unknown[] = []
  const postFailures: unknown[] = []
  let created = 0
  const api: SessionApi = {
    create: vi.fn(async () => {
      created++
      return { handle: `h${created}`, budgetCents: 300 }
    }),
    openStream: vi.fn(async (o) => {
      const failure = openFailures.shift()
      if (failure) throw failure
      const ch = channel()
      o.signal.addEventListener('abort', () => ch.end())
      streams.push({ lastEventId: o.lastEventId, handle: o.handle, ch, signal: o.signal })
      return ch.iterable
    }),
    post: vi.fn(async (token, handle, body) => {
      posts.push({ handle, body: structuredClone(body), token })
      const failure = postFailures.shift()
      if (failure) throw failure
    }),
    remove: vi.fn((_token, handle) => {
      removed.push(handle)
    }),
  }
  return { api, streams, posts, removed, openFailures, postFailures, last: () => streams[streams.length - 1].ch }
}
