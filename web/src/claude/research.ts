/**
 * 前提情報の調査の API(docs/interfaces-1105.md §3.2・§4.2)と、返答の形の確かめ。
 *
 * - POST /api/claude/session/research:調べる対象(target_ids だけ)を送る。サーバーは参照データで名前・種類・位置を入れ、
 *   [画面の操作] の行を会話に入れる。合言葉と取っ手(セッション)が要る
 * - GET /api/claude/session/research:このセッションの対象と、保存済みの結果
 * - GET /api/research/demo:デモ用の保存済みの結果(origin: demo)。AI を呼ばない。合言葉は要らない
 *
 * 送るのは target_id だけ(GTFS の中身は送らない)。返答はサーバーのデータだが、画面に出す前に形を確かめる
 */
import { authHeaders, ClaudeRequestError, NOT_CONNECTED, requestError } from './sse'

export type ResearchTargetKind = 'operator' | 'school' | 'hospital' | 'clinic'
export type ResearchStatus = 'found' | 'partial' | 'not_found'

/** 調査の対象(サーバーの参照データの名前・種類・位置) */
export interface ResearchTarget {
  targetId: string
  kind: ResearchTargetKind
  name: string
  municipality: string | null
  lat: number
  lon: number
  /** 保存済みなら {status, checkedAt, facts(件数)}。無ければ null */
  cached: { status: ResearchStatus; checkedAt: string; facts: number } | null
}

export interface ResearchFact {
  label: string
  value: string
  /** sources の番号(1 から) */
  source: number
}

export interface ResearchSource {
  url: string
  title: string
}

/** 調査の結果(1つの対象) */
export interface ResearchResult {
  targetId: string
  kind: ResearchTargetKind
  name: string
  status: ResearchStatus
  facts: ResearchFact[]
  sources: ResearchSource[]
  note: string
  /** 確認日時(日本時間の ISO 8601) */
  checkedAt: string
  /** web は調査で保存したもの、demo はデモ用の保存済みの結果 */
  origin: 'web' | 'demo'
}

/** POST の返答 */
export interface ResearchStartView {
  targets: ResearchTarget[]
  total: number
  maxTargets: number
}

/** GET /api/claude/session/research の返答 */
export interface ResearchOverview extends ResearchStartView {
  results: ResearchResult[]
  missing: string[]
  saved: number
}

/** デモ用の保存済みの結果(対象の位置つき) */
export interface DemoResult extends ResearchResult {
  municipality: string | null
  lat: number
  lon: number
}

export interface ResearchApi {
  /** POST /api/claude/session/research。失敗は ClaudeRequestError */
  start: (token: string | null, handle: string, targetIds: readonly string[]) => Promise<ResearchStartView>
  /** GET /api/claude/session/research。失敗は ClaudeRequestError */
  overview: (token: string | null, handle: string) => Promise<ResearchOverview>
}

/** 返答の形が違うときの文 */
export const RESEARCH_SHAPE = '調査の返答の形が違います。'

const KINDS: readonly string[] = ['operator', 'school', 'hospital', 'clinic']
const STATUSES: readonly string[] = ['found', 'partial', 'not_found']

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function parseCached(v: unknown): ResearchTarget['cached'] {
  if (!isObj(v)) return null
  const status = str(v.status)
  const checkedAt = str(v.checked_at)
  if (!status || !STATUSES.includes(status) || !checkedAt) return null
  return { status: status as ResearchStatus, checkedAt, facts: num(v.facts) ?? 0 }
}

/** 対象の1件。形が合わなければ null(画面に出さない) */
export function parseTarget(v: unknown): ResearchTarget | null {
  if (!isObj(v)) return null
  const targetId = str(v.target_id)
  const kind = str(v.kind)
  const name = str(v.name)
  const lat = num(v.lat)
  const lon = num(v.lon)
  if (!targetId || !kind || !KINDS.includes(kind) || !name || lat === null || lon === null) return null
  return { targetId, kind: kind as ResearchTargetKind, name, municipality: str(v.municipality) || null, lat, lon, cached: parseCached(v.cached) }
}

/** http・https の URL だけを通す(画面のリンクにするため) */
export function safeUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** 結果の1件。形が合わなければ null。出典は http・https の URL だけを残す */
export function parseResult(v: unknown): ResearchResult | null {
  if (!isObj(v)) return null
  const targetId = str(v.target_id)
  const kind = str(v.kind)
  const name = str(v.name)
  const status = str(v.status)
  const checkedAt = str(v.checked_at)
  const origin = str(v.origin)
  if (!targetId || !kind || !KINDS.includes(kind) || !name || !status || !STATUSES.includes(status) || !checkedAt) return null
  if (origin !== 'web' && origin !== 'demo') return null
  const facts: ResearchFact[] = []
  for (const f of list(v.facts)) {
    if (!isObj(f)) continue
    const label = str(f.label)
    const value = str(f.value)
    const source = num(f.source)
    if (label === null || value === null || source === null) continue
    facts.push({ label, value, source })
  }
  // 番号(facts の source)を変えないよう、使えない URL の出典も並びには残し、url を空にする
  const sources: ResearchSource[] = list(v.sources).map((s) => {
    if (!isObj(s)) return { url: '', title: '' }
    const url = str(s.url)
    return { url: url ? (safeUrl(url) ?? '') : '', title: str(s.title) ?? '' }
  })
  return {
    targetId,
    kind: kind as ResearchTargetKind,
    name,
    status: status as ResearchStatus,
    facts,
    sources,
    note: str(v.note) ?? '',
    checkedAt,
    origin,
  }
}

function parseStartView(body: unknown): ResearchStartView {
  if (!isObj(body) || !Array.isArray(body.targets)) throw new ClaudeRequestError(null, RESEARCH_SHAPE)
  const targets = body.targets.map(parseTarget).filter((t): t is ResearchTarget => t !== null)
  return { targets, total: num(body.total) ?? targets.length, maxTargets: num(body.max_targets) ?? targets.length }
}

/** GET /api/claude/session/research の返答を読む */
export function parseOverview(body: unknown): ResearchOverview {
  const view = parseStartView(body)
  const b = body as Obj
  const results = list(b.results)
    .map(parseResult)
    .filter((r): r is ResearchResult => r !== null)
  const missing = list(b.missing).filter((m): m is string => typeof m === 'string')
  return { ...view, results, missing, saved: num(b.saved) ?? results.length }
}

/** GET /api/research/demo の返答を読む */
export function parseDemo(body: unknown): DemoResult[] {
  if (!isObj(body) || !Array.isArray(body.results)) throw new Error(RESEARCH_SHAPE)
  const out: DemoResult[] = []
  for (const v of body.results) {
    const r = parseResult(v)
    const t = parseTarget(v)
    if (!r || !t) continue
    out.push({ ...r, municipality: t.municipality, lat: t.lat, lon: t.lon })
  }
  return out
}

/** 確認日時(ISO 8601)を「2026年11月6日 10:00」にする。読めなければそのまま */
export function checkedAtText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}`
}

/** 本物の fetch でつなぐ調査の API。base は '/api/claude' */
export function createResearchApi(fetchImpl?: typeof fetch, base = '/api/claude'): ResearchApi {
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init))
  async function call(url: string, init: RequestInit): Promise<unknown> {
    let res: Response
    try {
      res = await doFetch(url, init)
    } catch {
      throw new ClaudeRequestError(null, NOT_CONNECTED)
    }
    if (!res.ok) throw await requestError(res)
    return res.json().catch(() => {
      throw new ClaudeRequestError(res.status, RESEARCH_SHAPE)
    })
  }
  return {
    async start(token, handle, targetIds) {
      const headers = { 'Content-Type': 'application/json', ...authHeaders(token, handle) }
      const body = await call(`${base}/session/research`, { method: 'POST', headers, body: JSON.stringify({ target_ids: targetIds }) })
      return parseStartView(body)
    },
    async overview(token, handle) {
      const body = await call(`${base}/session/research`, { method: 'GET', headers: authHeaders(token, handle) })
      return parseOverview(body)
    },
  }
}

/** デモ用の保存済みの結果を取る。失敗は日本語の Error */
export async function fetchDemoResults(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<DemoResult[]> {
  let res: Response
  try {
    res = await fetchImpl('/api/research/demo')
  } catch {
    throw new Error('サーバーにつながりません。')
  }
  if (!res.ok) throw new Error(`保存済みの結果を読めませんでした(${res.status})。`)
  const body: unknown = await res.json().catch(() => null)
  return parseDemo(body)
}
