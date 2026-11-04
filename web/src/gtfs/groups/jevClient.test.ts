import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { fetchJevStatus, judgeServices, JEV_JUDGE_URL, JEV_STATUS_URL, parseJevResponse, type JevFetch } from './jevClient'
import type { JevJudgeRequest, JevJudgeResponse } from './types'

const REQUEST: JevJudgeRequest = {
  feed: { agency: 'テストバス', period: { start: '20261001', end: '20270331' }, daysInPeriod: { weekday: 122, saturday: 26, sundayHoliday: 34 } },
  services: [],
  targets: [],
}

const RESPONSE: JevJudgeResponse = {
  model: 'typesafe-ai/jev',
  results: [
    {
      serviceId: 'S000027',
      role: 'saturday',
      provider: 'typesafe-ai',
      sent: { state: { target: { service_id: 'S000027' } }, questions: { weekday_counterpart: {} } },
      weekdayCounterpart: { choice: 'S000001', probabilities: { S000001: 0.95, none: 0.05 }, confidence: 0.93 },
    },
    {
      serviceId: 'S000014',
      role: 'weekday',
      provider: 'typesafe-ai',
      sent: { state: {}, questions: {} },
      serviceKind: { choice: 'regular_weekday', probabilities: { regular_weekday: 0.82, limited_weekdays: 0.18 }, confidence: null },
      schoolService: { probability: 0.05 },
    },
  ],
  failures: [
    { serviceId: 'S000002', role: 'saturday', error: 'timeout', sent: { state: { target: { service_id: 'S000002' } }, questions: {} } },
    { serviceId: 'S000003', role: 'weekday', error: 'budget' },
  ],
  usage: { inputTokens: 12130, costUsd: 0.000509 },
}

function reply(status: number, body: unknown): ReturnType<JevFetch> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) })
}

describe('fetchJevStatus', () => {
  it('サーバーの答えをそのまま返す', async () => {
    const fetchFn = vi.fn<JevFetch>(() => reply(200, { available: true, provider: 'TypeSafe AI Jev', via: 'Vercel AI Gateway', reason: null }))
    await expect(fetchJevStatus(undefined, fetchFn)).resolves.toEqual({
      available: true,
      provider: 'TypeSafe AI Jev',
      via: 'Vercel AI Gateway',
      reason: null,
    })
    expect(fetchFn.mock.calls[0][0]).toBe(JEV_STATUS_URL)
  })

  it('使えない理由を返す', async () => {
    const fetchFn: JevFetch = () => reply(200, { available: false, provider: 'TypeSafe AI Jev', via: 'Vercel AI Gateway', reason: 'noKey' })
    await expect(fetchJevStatus(undefined, fetchFn)).resolves.toMatchObject({ available: false, reason: 'noKey' })
  })

  it('404・接続できない・形の違いは unavailable', async () => {
    await expect(fetchJevStatus(undefined, () => reply(404, {}))).resolves.toMatchObject({ available: false, reason: 'unavailable' })
    await expect(fetchJevStatus(undefined, () => Promise.reject(new TypeError('failed')))).resolves.toMatchObject({ reason: 'unavailable' })
    await expect(fetchJevStatus(undefined, () => reply(200, { available: 'yes' }))).resolves.toMatchObject({ reason: 'unavailable' })
  })
})

describe('judgeServices', () => {
  it('判断材料を POST し、形を確かめた答えを返す', async () => {
    const fetchFn = vi.fn<JevFetch>(() => reply(200, RESPONSE))
    const out = await judgeServices(REQUEST, undefined, fetchFn)
    expect(out).toEqual({ ok: true, response: RESPONSE })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(JEV_JUDGE_URL)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init!.body!)).toEqual(REQUEST)
  })

  it.each([
    [404, 'unavailable'],
    [413, 'tooLarge'],
    [422, 'invalid'],
    [429, 'rateLimited'],
    [503, 'noKey'],
    [500, 'upstream'],
    [502, 'upstream'],
  ] as const)('%i は %s', async (status, error) => {
    const out = await judgeServices(REQUEST, undefined, () => reply(status, { detail: '日本語の説明' }))
    expect(out).toMatchObject({ ok: false, error })
    if (!out.ok) expect(out.message).not.toBe('')
  })

  it('429・503 はサーバーの文(いつ使えるようになるか)を出し、Jev には送っていないと書く', async () => {
    const detail = 'Jev に問う回数の上限に達しました(1 時間あたり)。規則だけで分けます。しばらくしてから使えます'
    const out = await judgeServices(REQUEST, undefined, () => reply(429, { detail }))
    expect(out).toEqual({ ok: false, error: 'rateLimited', message: `${detail}。Jev には送っていません。` })
    // 文が無ければ決まった文に、送っていないことを足す
    const plain = await judgeServices(REQUEST, undefined, () => reply(429, {}))
    expect(plain).toMatchObject({ ok: false, error: 'rateLimited' })
    if (!plain.ok) expect(plain.message).toBe('Jev への問い合わせの回数の上限に達したため、規則だけで分けました。Jev には送っていません。')
    const noKey = await judgeServices(REQUEST, undefined, () => reply(503, { detail: 'サーバーに Jev のキーが設定されていません。' }))
    if (!noKey.ok) expect(noKey.message).toBe('サーバーに Jev のキーが設定されていません。Jev には送っていません。')
    // 上流の誤り(送ったかもしれない)には足さない
    const up = await judgeServices(REQUEST, undefined, () => reply(502, { detail: 'x' }))
    if (!up.ok) expect(up.message).not.toContain('送っていません')
  })

  it('接続できなければ network', async () => {
    const out = await judgeServices(REQUEST, undefined, () => Promise.reject(new TypeError('Failed to fetch')))
    expect(out).toMatchObject({ ok: false, error: 'network' })
  })

  it('中断すれば aborted', async () => {
    const controller = new AbortController()
    const fetchFn: JevFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const pending = judgeServices(REQUEST, controller.signal, fetchFn)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'aborted' })
  })

  it('届いたあとに中断されていれば、答えを捨てて aborted', async () => {
    const controller = new AbortController()
    const fetchFn: JevFetch = () => {
      controller.abort()
      return reply(200, RESPONSE)
    }
    await expect(judgeServices(REQUEST, controller.signal, fetchFn)).resolves.toMatchObject({ ok: false, error: 'aborted' })
  })

  it('形の合わない答えは upstream', async () => {
    const bad = { ...RESPONSE, results: [{ ...RESPONSE.results[0], weekdayCounterpart: { choice: 'S1', probabilities: { S1: 1.5 }, confidence: 0.9 } }] }
    await expect(judgeServices(REQUEST, undefined, () => reply(200, bad))).resolves.toMatchObject({ ok: false, error: 'upstream' })
  })
})

describe('parseJevResponse', () => {
  it('上流に送った後の失敗は sent を返し、送る前の失敗には sent が無い', () => {
    const parsed = parseJevResponse(RESPONSE)
    expect(parsed?.failures).toEqual(RESPONSE.failures)
    expect(parsed?.failures[1]).not.toHaveProperty('sent')
  })

  it('知らない項目は読み飛ばし、決めた形だけを返す', () => {
    const parsed = parseJevResponse({ ...RESPONSE, extra: 1, results: [{ ...RESPONSE.results[0], stats: {} }] })
    expect(parsed?.results[0]).toEqual(RESPONSE.results[0])
  })

  it('役割・失敗の種類・usage が合わなければ null', () => {
    expect(parseJevResponse({ ...RESPONSE, results: [{ ...RESPONSE.results[0], role: 'sunday' }] })).toBeNull()
    expect(parseJevResponse({ ...RESPONSE, failures: [{ serviceId: 'x', role: 'weekday', error: 'oops' }] })).toBeNull()
    expect(parseJevResponse({ ...RESPONSE, failures: [{ serviceId: 'x', role: 'weekday', error: 'timeout', sent: 'text' }] })).toBeNull()
    expect(parseJevResponse({ ...RESPONSE, usage: { inputTokens: '1', costUsd: null } })).toBeNull()
    expect(parseJevResponse(null)).toBeNull()
  })
})

// B の固定のデータ(server/tests/fixtures/jev_judge_response.json)を、この確かめが受け付けるか。ファイルが無ければスキップする
const RESPONSE_FIXTURE = fileURLToPath(new URL('../../../../server/tests/fixtures/jev_judge_response.json', import.meta.url))

describe.skipIf(!existsSync(RESPONSE_FIXTURE))('B の固定のデータ(応答)', () => {
  it('parseJevResponse が受け付け、答えの項目を落とさない', () => {
    const json = JSON.parse(readFileSync(RESPONSE_FIXTURE, 'utf8')) as JevJudgeResponse
    const parsed = parseJevResponse(json)
    expect(parsed).not.toBeNull()
    expect(parsed!.results.map((r) => Object.keys(r).sort())).toEqual(json.results.map((r) => Object.keys(r).sort()))
  })
})
