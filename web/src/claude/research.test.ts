import { describe, expect, it, vi } from 'vitest'
import { checkedAtText, createResearchApi, parseResult, RESEARCH_SHAPE, safeUrl } from './research'
import { ClaudeRequestError } from './sse'

/** サーバーの返答の形(snake_case)の対象 */
const TARGET = {
  target_id: 'P29:01234567890A',
  kind: 'school',
  name: 'テスト第一高等学校',
  municipality: '旭川市',
  lat: 43.77,
  lon: 142.36,
  cached: { status: 'found', checked_at: '2026-11-06T10:00:00+09:00', facts: 2 },
}

const RESULT = {
  target_id: 'P29:01234567890A',
  kind: 'school',
  name: 'テスト第一高等学校',
  status: 'found',
  facts: [{ label: '始業', value: '8時40分', source: 1 }],
  sources: [{ url: 'https://example.jp/a', title: '案内' }],
  note: '',
  checked_at: '2026-11-06T10:00:00+09:00',
  origin: 'web',
}

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body, { status }))
}

describe('createResearchApi', () => {
  it('POST は target_ids だけを本文に、合言葉と取っ手をヘッダーに入れ、返答を読む', async () => {
    const fetchImpl = fakeFetch(200, { targets: [TARGET, { target_id: 'x' }], total: 1, max_targets: 30 })
    const api = createResearchApi(fetchImpl as unknown as typeof fetch)
    const view = await api.start('tok', 'handle-1', ['P29:01234567890A'])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/claude/session/research')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Dispatcher-Token': 'tok', 'X-Dispatcher-Session': 'handle-1' })
    expect(JSON.parse(init?.body as string)).toEqual({ target_ids: ['P29:01234567890A'] })
    // 形の合わない対象は読み飛ばす
    expect(view).toEqual({
      targets: [
        {
          targetId: 'P29:01234567890A',
          kind: 'school',
          name: 'テスト第一高等学校',
          municipality: '旭川市',
          lat: 43.77,
          lon: 142.36,
          cached: { status: 'found', checkedAt: '2026-11-06T10:00:00+09:00', facts: 2 },
        },
      ],
      total: 1,
      maxTargets: 30,
    })
  })

  it('GET は取っ手だけを付けて、対象と結果を読む', async () => {
    const fetchImpl = fakeFetch(200, { targets: [{ ...TARGET, cached: null }], results: [RESULT], missing: [], saved: 1, total: 1, max_targets: 30 })
    const api = createResearchApi(fetchImpl as unknown as typeof fetch)
    const overview = await api.overview(null, 'handle-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/claude/session/research')
    expect(init?.method).toBe('GET')
    expect(init?.headers).toEqual({ 'X-Dispatcher-Session': 'handle-1' })
    expect(overview.targets[0].cached).toBeNull()
    expect(overview.results).toEqual([
      {
        targetId: 'P29:01234567890A',
        kind: 'school',
        name: 'テスト第一高等学校',
        status: 'found',
        facts: [{ label: '始業', value: '8時40分', source: 1 }],
        sources: [{ url: 'https://example.jp/a', title: '案内' }],
        note: '',
        checkedAt: '2026-11-06T10:00:00+09:00',
        origin: 'web',
      },
    ])
    expect(overview.saved).toBe(1)
  })

  it('失敗はサーバーの detail を持つ ClaudeRequestError。形が違えば RESEARCH_SHAPE', async () => {
    const api = createResearchApi(fakeFetch(400, { detail: '参照データに無い対象があります:P29:x' }) as unknown as typeof fetch)
    const error = await api.start(null, 'h', ['P29:x']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ClaudeRequestError)
    expect((error as ClaudeRequestError).status).toBe(400)
    expect((error as ClaudeRequestError).message).toBe('参照データに無い対象があります:P29:x')

    const bad = createResearchApi(fakeFetch(200, { nope: 1 }) as unknown as typeof fetch)
    await expect(bad.start(null, 'h', ['P29:x'])).rejects.toThrow(RESEARCH_SHAPE)

    const offline = createResearchApi((async () => {
      throw new TypeError('failed')
    }) as unknown as typeof fetch)
    const e2 = await offline.overview(null, 'h').catch((e: unknown) => e)
    expect((e2 as ClaudeRequestError).status).toBeNull()
  })
})

describe('結果の読み方', () => {
  it('http・https でない出典の URL は空にする(番号はそのまま残す)', () => {
    const r = parseResult({ ...RESULT, sources: [{ url: 'javascript:alert(1)', title: 'x' }, { url: 'https://example.jp/b', title: 'b' }] })
    expect(r?.sources).toEqual([
      { url: '', title: 'x' },
      { url: 'https://example.jp/b', title: 'b' },
    ])
    expect(safeUrl('ftp://example.jp')).toBeNull()
  })

  it('origin・status・種類が知らない値なら読まない', () => {
    expect(parseResult({ ...RESULT, origin: 'other' })).toBeNull()
    expect(parseResult({ ...RESULT, status: 'maybe' })).toBeNull()
    expect(parseResult({ ...RESULT, kind: 'airport' })).toBeNull()
  })

  it('確認日時を「2026年11月6日 10:00」にする', () => {
    expect(checkedAtText('2026-11-06T10:00:00+09:00')).toBe('2026年11月6日 10:00')
    expect(checkedAtText('不明')).toBe('不明')
  })
})
