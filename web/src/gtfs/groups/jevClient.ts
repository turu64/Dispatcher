/**
 * サーバーの Jev の中継の呼び出し(docs/design-service-groups.md §3.3・§3.6)。
 *
 * - GET /api/service-groups:Jev を使えるか。404・接続できないときは unavailable(B が無い版でも規則だけで動く)
 * - POST /api/service-groups/judge:判断材料を送り、答えと、サーバーが実際に Jev に送った本文(results[].sent)を受け取る
 * - 送るのは service ごとの集計だけ(buildJevRequest)。認証コードは掛けない(2026-11-03 の決定)
 * - 返答はサーバーのデータだが、案に合わせる前に形を確かめる(合わなければ upstream)
 */
import type {
  JevChoice,
  JevErrorKind,
  JevFailure,
  JevJudgeRequest,
  JevJudgeResponse,
  JevOutcome,
  JevRole,
  JevStatus,
  JevTargetResult,
} from './types'

export const JEV_STATUS_URL = '/api/service-groups'
export const JEV_JUDGE_URL = '/api/service-groups/judge'

/** fetch の代わりに渡せる形(テストで差し替える) */
export type JevFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const defaultFetch: JevFetch = (url, init) => fetch(url, init)

const UNAVAILABLE: JevStatus = { available: false, provider: null, via: null, reason: 'unavailable' }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isAbort(e: unknown): boolean {
  return isRecord(e) && e.name === 'AbortError'
}

const STATUS_REASONS = new Set(['noKey', 'badUrl', 'dailyLimit'])

export async function fetchJevStatus(signal?: AbortSignal, fetchFn: JevFetch = defaultFetch): Promise<JevStatus> {
  let res: Awaited<ReturnType<JevFetch>>
  try {
    res = await fetchFn(JEV_STATUS_URL, { signal })
  } catch (e) {
    if (isAbort(e)) throw e
    return UNAVAILABLE
  }
  if (!res.ok) return UNAVAILABLE
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return UNAVAILABLE
  }
  if (!isRecord(json) || typeof json.available !== 'boolean') return UNAVAILABLE
  const reason = typeof json.reason === 'string' && STATUS_REASONS.has(json.reason) ? (json.reason as JevStatus['reason']) : null
  return {
    available: json.available,
    provider: typeof json.provider === 'string' ? json.provider : null,
    via: typeof json.via === 'string' ? json.via : null,
    reason: json.available ? null : (reason ?? 'unavailable'),
  }
}

const MESSAGES: Record<JevErrorKind, string> = {
  noKey: 'サーバーに Jev のキーが設定されていないため、規則だけで分けました。',
  rateLimited: 'Jev への問い合わせの回数の上限に達したため、規則だけで分けました。',
  tooLarge: 'service が多いため、Jev に問わず規則だけで分けました。',
  invalid: 'Jev に送る判断材料の形が合わないため、規則だけで分けました。',
  upstream: 'Jev から答えを得られなかったため、規則だけで分けました。',
  network: 'サーバーに接続できないため、規則だけで分けました。',
  aborted: 'Jev への問い合わせをやめました。規則だけで分けています。',
  unavailable: 'この環境では Jev を使えないため、規則だけで分けました。',
}

function failure(error: JevErrorKind): JevOutcome {
  return { ok: false, error, message: MESSAGES[error] }
}

const ROLES = new Set<JevRole>(['weekday', 'saturday', 'sundayHoliday'])
const FAILURES = new Set(['timeout', 'rate_limited', 'upstream', 'invalid_answer', 'budget'])

function isProbability(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

function parseChoice(v: unknown): JevChoice | null {
  if (!isRecord(v) || typeof v.choice !== 'string' || !isRecord(v.probabilities)) return null
  const probabilities: Record<string, number> = {}
  for (const [k, p] of Object.entries(v.probabilities)) {
    if (!isProbability(p)) return null
    probabilities[k] = p
  }
  const confidence = v.confidence === null || v.confidence === undefined ? null : v.confidence
  if (confidence !== null && !isProbability(confidence)) return null
  return { choice: v.choice, probabilities, confidence }
}

function parseResult(v: unknown): JevTargetResult | null {
  if (!isRecord(v) || typeof v.serviceId !== 'string' || typeof v.role !== 'string' || !ROLES.has(v.role as JevRole)) return null
  if (!isRecord(v.sent)) return null
  const result: JevTargetResult = {
    serviceId: v.serviceId,
    role: v.role as JevRole,
    provider: typeof v.provider === 'string' ? v.provider : null,
    sent: { state: v.sent.state, questions: v.sent.questions },
  }
  if (v.serviceKind !== undefined && v.serviceKind !== null) {
    const c = parseChoice(v.serviceKind)
    if (c === null) return null
    result.serviceKind = c
  }
  if (v.schoolService !== undefined && v.schoolService !== null) {
    if (!isRecord(v.schoolService) || !isProbability(v.schoolService.probability)) return null
    result.schoolService = { probability: v.schoolService.probability }
  }
  if (v.weekdayCounterpart !== undefined && v.weekdayCounterpart !== null) {
    const c = parseChoice(v.weekdayCounterpart)
    if (c === null) return null
    result.weekdayCounterpart = c
  }
  return result
}

/** 応答の形を確かめる。合わなければ null */
export function parseJevResponse(json: unknown): JevJudgeResponse | null {
  if (!isRecord(json) || typeof json.model !== 'string' || !Array.isArray(json.results) || !Array.isArray(json.failures)) return null
  const results: JevTargetResult[] = []
  for (const r of json.results) {
    const parsed = parseResult(r)
    if (parsed === null) return null
    results.push(parsed)
  }
  const failures: JevJudgeResponse['failures'] = []
  for (const f of json.failures) {
    if (
      !isRecord(f) ||
      typeof f.serviceId !== 'string' ||
      typeof f.role !== 'string' ||
      !ROLES.has(f.role as JevRole) ||
      typeof f.error !== 'string' ||
      !FAILURES.has(f.error) ||
      (f.sent !== undefined && f.sent !== null && !isRecord(f.sent))
    ) {
      return null
    }
    const item: JevFailure = { serviceId: f.serviceId, role: f.role as JevRole, error: f.error as JevFailure['error'] }
    if (isRecord(f.sent)) item.sent = { state: f.sent.state, questions: f.sent.questions }
    failures.push(item)
  }
  const usage = json.usage
  if (!isRecord(usage) || typeof usage.inputTokens !== 'number' || !(usage.costUsd === null || typeof usage.costUsd === 'number')) {
    return null
  }
  return { model: json.model, results, failures, usage: { inputTokens: usage.inputTokens, costUsd: usage.costUsd } }
}

/** 判断材料を送り、Jev の答えを受け取る。失敗は種類に分けて返す(投げない) */
export async function judgeServices(request: JevJudgeRequest, signal?: AbortSignal, fetchFn: JevFetch = defaultFetch): Promise<JevOutcome> {
  let res: Awaited<ReturnType<JevFetch>>
  try {
    res = await fetchFn(JEV_JUDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (e) {
    return failure(isAbort(e) || signal?.aborted ? 'aborted' : 'network')
  }
  if (!res.ok) {
    if (res.status === 404) return failure('unavailable')
    if (res.status === 413) return failure('tooLarge')
    if (res.status === 422 || res.status === 400) return failure('invalid')
    if (res.status === 429) return failure('rateLimited')
    if (res.status === 503) return failure('noKey')
    return failure('upstream')
  }
  let json: unknown
  try {
    json = await res.json()
  } catch (e) {
    return failure(isAbort(e) || signal?.aborted ? 'aborted' : 'upstream')
  }
  if (signal?.aborted) return failure('aborted')
  const response = parseJevResponse(json)
  return response === null ? failure('upstream') : { ok: true, response }
}
