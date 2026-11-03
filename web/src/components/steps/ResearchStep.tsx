import { ArrowDown, ArrowUp, ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore, type StoreApi, type UseBoundStore } from 'zustand'
import StepSection from '@/components/StepSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { checkedAtText, safeUrl, type ResearchResult, type ResearchStatus } from '@/claude/research'
import { FacilitySymbol } from '@/map/FacilityLayer'
import { DEFAULT_SELECT_WALK_M, FACILITY_KIND_LABELS, groupCandidates, type CandidateGroup, type ResearchCandidate } from '@/ref/facilities'
import { RESEARCH_KEEP_OPEN, RESEARCH_SEND_NOTE, researchText, useChatStore, type ChatState } from '@/store/chat'
import { useGtfsStore } from '@/store/gtfs'
import { DEFAULT_PRIORITY, priorityCategory, usePriorityStore } from '@/store/priority'
import { facilitiesInUse, useResearchStops, useResearchStore, useResearchView } from '@/store/research'

type ChatStoreHook = UseBoundStore<StoreApi<ChatState>>

// ---- 文言 ----

export const RESEARCH_START = '前提情報を調べる'
export const RESEARCH_DEMO = '保存済みの結果(デモ)を使う'
export const RESEARCH_DEMO_NOTE = 'AI も Web 検索も使わずに、保存済みの調査の結果(デモ用)を出し、その対象を選びます。'
export const RESEARCH_DEMO_NONE = 'この GTFS の停留所の周りには、保存済みの結果(デモ)がありません。'
export const RESEARCH_SAVED_NOTE = '保存済みの対象は調べ直さず(Web 検索をせず)、その結果を使います。'
export const RESEARCH_RESULT_NOTE = '結果は AI が Web で調べたものです。確認日時の後に変わっていることがあるので、出典を開いて確かめてください。'
export const OWN_OPERATOR = '読み込んだ GTFS の事業者'
export const CLOSED_SCHOOL = '休校中か不明'

const STATUS_LABELS: Record<ResearchStatus, string> = {
  found: '見つかった',
  partial: '一部だけ見つかった',
  not_found: '見つからなかった',
}

/** 候補の1行に添える詳しいこと(学校の種別、病床、救急、停留所までの距離) */
function detailText(c: ResearchCandidate): string {
  const f = c.facility
  const parts: string[] = []
  if (f.municipality) parts.push(f.municipality)
  if (f.kind === 'school' && f.schoolType) parts.push(f.schoolType)
  if ((f.kind === 'hospital' || f.kind === 'clinic') && f.beds !== undefined) parts.push(`病床 ${f.beds}`)
  if (f.emergency) parts.push('救急告示')
  if (f.kind !== 'operator' && Number.isFinite(c.nearestStopM)) parts.push(`停留所から ${Math.round(c.nearestStopM).toLocaleString('ja-JP')}m`)
  return parts.join('・')
}

// ---- 部品 ----

/** 重要拠点の優先順位(並べ替えられる。データの無い種類は「データ未対応」) */
export function PriorityList() {
  const order = usePriorityStore((s) => s.order)
  const move = usePriorityStore((s) => s.move)
  const reset = usePriorityStore((s) => s.reset)
  const changed = order.some((k, i) => k !== DEFAULT_PRIORITY[i].key)
  return (
    <details className="rounded-md border text-xs">
      <summary className="cursor-pointer px-2 py-1.5 font-medium">重要拠点の優先順位{changed ? '(変更あり)' : ''}</summary>
      <div className="flex flex-col gap-1.5 px-2 pb-2">
        <p className="text-muted-foreground">
          上ほど優先します。調べる対象の既定の選び方と、足し戻しの手がかりの並びに使います。データの無い種類は選べません。
        </p>
        <ol className="flex flex-col gap-1" aria-label="重要拠点の優先順位">
          {order.map((key, i) => {
            const cat = priorityCategory(key)
            return (
              <li key={key} className="flex items-center gap-1.5">
                <span className="w-5 text-right tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className={cat.data === 'none' ? 'text-muted-foreground' : undefined}>{cat.label}</span>
                  {cat.data === 'none' ? (
                    <Badge variant="outline" className="ml-1.5">
                      データ未対応
                    </Badge>
                  ) : (
                    <span className="ml-1.5 text-muted-foreground">{cat.dataNote}</span>
                  )}
                </span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`${cat.label}を上へ`} disabled={i === 0} onClick={() => move(key, -1)}>
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${cat.label}を下へ`}
                  disabled={i === order.length - 1}
                  onClick={() => move(key, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ol>
        {changed && (
          <Button type="button" variant="outline" size="xs" className="self-start" onClick={reset}>
            既定の並びに戻す
          </Button>
        )}
      </div>
    </details>
  )
}

function ResultBadge({ result }: { result: ResearchResult }) {
  return (
    <Badge variant={result.status === 'not_found' ? 'outline' : 'secondary'}>
      {result.origin === 'demo' ? '保存済み(デモ)' : '調査済み'}・{STATUS_LABELS[result.status]}
    </Badge>
  )
}

/**
 * 候補の種類ごとのまとまり(折りたたむ)。開くかどうかは利用者が決め、選んだ数では閉じない
 * (最後の1件を外したときに、押している最中のまとまりが閉じないように)。
 * 最初に選んだ対象があれば開いておき、外から選ばれた(既定の選び方・デモの結果)ときも開く。閉じるのは利用者だけ
 */
function CandidateGroupDetails({ label, picked, children }: { label: string; picked: number; children: ReactNode }) {
  const [open, setOpen] = useState(picked > 0)
  const [prevPicked, setPrevPicked] = useState(picked)
  if (picked !== prevPicked) {
    setPrevPicked(picked)
    if (prevPicked === 0 && picked > 0) setOpen(true)
  }
  return (
    <details className="rounded-md border text-xs" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} aria-label={label}>
      {children}
    </details>
  )
}

/** 候補の一覧(種類ごとに折りたたむ。選んだ対象のあるまとまりは開いておく) */
function CandidateList({
  groups,
  selected,
  onToggle,
  results,
}: {
  groups: readonly CandidateGroup[]
  selected: ReadonlySet<string>
  onToggle: (id: string, checked: boolean) => void
  results: ReadonlyMap<string, ResearchResult>
}) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="調べる対象の候補">
      {groups.map((g) => {
        const picked = g.items.filter((c) => selected.has(c.facility.targetId)).length
        return (
          <CandidateGroupDetails key={g.key} label={g.label} picked={picked}>
            <summary className="cursor-pointer px-2 py-1.5">
              <span className="font-medium">{g.label}</span>
              <span className="ml-2 text-muted-foreground">
                {g.items.length} 件(選んだ {picked} 件)
              </span>
            </summary>
            <ul className="flex flex-col gap-1 px-2 pb-2">
              {g.items.map((c) => {
                const id = c.facility.targetId
                const result = results.get(id)
                const detail = detailText(c)
                return (
                  <li key={id}>
                    <label className="flex items-start gap-1.5">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={selected.has(id)}
                        onChange={(e) => onToggle(id, e.target.checked)}
                        aria-label={c.facility.name}
                      />
                      <FacilitySymbol kind={c.facility.kind} className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span>{c.facility.name}</span>
                        {detail && <span className="ml-1.5 text-muted-foreground">{detail}</span>}
                        {c.ownOperator && (
                          <Badge variant="outline" className="ml-1.5">
                            {OWN_OPERATOR}
                          </Badge>
                        )}
                        {c.closed && (
                          <Badge variant="outline" className="ml-1.5">
                            {CLOSED_SCHOOL}
                          </Badge>
                        )}
                        {result && (
                          <span className="ml-1.5">
                            <ResultBadge result={result} />
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </CandidateGroupDetails>
        )
      })}
    </div>
  )
}

/** 調査の結果の1件(事実・出典 URL・確認日時・どこから来た結果か) */
export function ResultCard({ result }: { result: ResearchResult }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs" aria-label={`${result.name}の調査の結果`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <FacilitySymbol kind={result.kind} />
        <span className="font-medium">{result.name}</span>
        <span className="text-muted-foreground">{FACILITY_KIND_LABELS[result.kind]}</span>
        <ResultBadge result={result} />
      </div>
      {result.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {result.facts.map((f, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd>
                {f.value}
                {f.source >= 1 && f.source <= result.sources.length && <sup className="ml-0.5 text-muted-foreground">[{f.source}]</sup>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {result.note && <p className="text-muted-foreground">{result.note}</p>}
      {result.sources.length > 0 && (
        <ol className="flex flex-col gap-0.5" aria-label="出典">
          {result.sources.map((s, i) => {
            const url = safeUrl(s.url)
            return (
              <li key={i} className="flex gap-1">
                <span className="text-muted-foreground">[{i + 1}]</span>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-0.5 break-all underline underline-offset-2">
                    {s.title || url}
                    <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">{s.title || '(URL を表示できません)'}</span>
                )}
              </li>
            )
          })}
        </ol>
      )}
      <p className="text-muted-foreground">
        確認日時 {checkedAtText(result.checkedAt)}・{result.origin === 'demo' ? 'デモ用の保存済みの結果' : 'Web で調べた結果'}
      </p>
    </li>
  )
}

/**
 * 前提情報の手順。停留所の分布の外接矩形 +2km にある周辺のバス事業者・学校・病院を参照データ(国土数値情報)から洗い出し、
 * 調べる対象を選んで AI に Web で調べてもらう(docs/interfaces-1105.md §3.2・§6.4、docs/tasks-1103.md の T16)。
 * 対象は重要拠点の優先順位の上から既定で選び、上限は 30 件。保存済みの結果(デモ)を使えば、AI を呼ばずに結果を見られる。
 * サーバーに送るのは target_id だけ。GTFS の中身は送らない
 */
export default function ResearchStep({ chat = useChatStore }: { chat?: ChatStoreHook }) {
  const feed = useGtfsStore((s) => s.feed)
  return <StepSection title="2. 前提情報">{!feed ? <p className="text-sm text-muted-foreground">GTFS を読み込むと、周辺の事業者・学校・病院を調べられます。</p> : <ResearchBody chat={chat} />}</StepSection>
}

function ResearchBody({ chat }: { chat: ChatStoreHook }) {
  const stops = useResearchStops()
  const facilities = useResearchStore((s) => s.facilities)
  const loadFacilities = useResearchStore((s) => s.loadFacilities)
  const results = useResearchStore((s) => s.results)
  const targets = useResearchStore((s) => s.targets)
  const demo = useResearchStore((s) => s.demo)
  const inUse = useResearchStore(facilitiesInUse)
  const order = usePriorityStore((s) => s.order)
  const { candidates, selectedIds, isDefault, maxTargets } = useResearchView()
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const groups = useMemo(() => groupCandidates(candidates, order), [candidates, order])
  const [limitNote, setLimitNote] = useState<string | null>(null)

  const sending = useStore(chat, (s) => s.sending)
  const progress = useStore(chat, (s) => s.research)
  const researchError = useStore(chat, (s) => s.researchError)
  const progressText = researchText(progress)

  // GTFS を読み込んだら(停留所が決まったら)、その周りの施設を読む
  useEffect(() => {
    if (stops.length > 0) void useResearchStore.getState().loadFacilities(stops)
  }, [stops])

  // 調べた結果が保存されたら(進み具合の saved が増えた・調べ終えた)、保存済みの結果を読み直す
  const saved = progress.saved
  const outcome = progress.outcome
  useEffect(() => {
    if (targets === null) return
    let cancelled = false
    void chat
      .getState()
      .loadResearch()
      .then((overview) => {
        if (cancelled || !overview) return
        useResearchStore.getState().mergeResults(overview.results)
      })
    return () => {
      cancelled = true
    }
  }, [chat, targets, saved, outcome])

  const onToggle = (id: string, checked: boolean) => {
    const next = selectedIds.filter((x) => x !== id)
    if (checked) {
      if (next.length >= maxTargets) {
        setLimitNote(`調べる対象は ${maxTargets} 件までです。ほかの対象を外してから選んでください。`)
        return
      }
      next.push(id)
    }
    setLimitNote(null)
    useResearchStore.getState().setSelected(next)
  }

  const onStart = async () => {
    const view = await chat.getState().startResearch(selectedIds)
    if (view) useResearchStore.getState().setTargets(view.targets, view.maxTargets)
  }

  const onDemo = () => {
    void useResearchStore.getState().loadDemo(new Set(candidates.map((c) => c.facility.targetId)))
  }

  // 表示する結果:選んでいる対象と、調査を始めた対象のうち、結果のあるもの(選んだ順)
  const shownResults = useMemo(() => {
    const ids = [...selectedIds, ...(targets ?? []).map((t) => t.targetId)]
    const seen = new Set<string>()
    const out: ResearchResult[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const r = results.get(id)
      if (r) out.push(r)
    }
    return out
  }, [selectedIds, targets, results])
  const cachedSelected = selectedIds.filter((id) => results.has(id)).length

  return (
    <>
      <p className="text-sm text-muted-foreground">
        停留所の分布の外周に 2km の余白を足した範囲から、周辺のバス事業者・学校・病院を洗い出します。調べる対象を選び、AI に Web
        で調べてもらうと、通学・通院の時刻などの手がかりが出典つきで集まります。この手順を飛ばして、次の「減便の方針」へ進めます。
      </p>

      <PriorityList />

      {facilities.status === 'loading' && <p className="text-sm text-muted-foreground">周辺の施設を読み込んでいます…</p>}
      {facilities.status === 'error' && (
        <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 px-2 py-1.5 text-sm" role="alert">
          <p>{facilities.message}</p>
          <Button type="button" variant="outline" size="xs" className="self-start" onClick={() => void loadFacilities(stops)}>
            読み込み直す
          </Button>
        </div>
      )}
      {stops.length === 0 && <p className="text-sm text-muted-foreground">乗れる停留所が無いため、施設を探す範囲を決められません。</p>}

      {facilities.status === 'ready' && (
        <>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">停留所の周り 2km に、調査の対象になる施設がありません。</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  選んだ対象 <strong className="tabular-nums">{selectedIds.length}</strong> / {maxTargets} 件
                  <span className="ml-1 text-xs text-muted-foreground">(候補 {candidates.length} 件)</span>
                </span>
                {!isDefault && (
                  <Button type="button" variant="outline" size="xs" onClick={() => useResearchStore.getState().setSelected(null)}>
                    既定の選び方に戻す
                  </Button>
                )}
                {selectedIds.length > 0 && (
                  <Button type="button" variant="ghost" size="xs" onClick={() => useResearchStore.getState().setSelected([])}>
                    すべて外す
                  </Button>
                )}
              </div>
              {isDefault && (
                <p className="text-xs text-muted-foreground">
                  既定では、重要拠点の優先順位の高い種類から1件ずつ順に(停留所から {DEFAULT_SELECT_WALK_M.toLocaleString('ja-JP')}m 以内の施設を、病院は病床の多い順、ほかは停留所に近い順に)、最後に周辺のバス事業者(読み込んだ
                  GTFS の事業者を除く)を、{maxTargets} 件まで選んでいます。
                </p>
              )}
              {limitNote && (
                <p className="text-xs text-destructive" role="alert">
                  {limitNote}
                </p>
              )}
              <CandidateList groups={groups} selected={selected} onToggle={onToggle} results={results} />
            </>
          )}

          <div className="flex flex-col gap-1.5 rounded-md border px-2 py-2">
            <p className="text-xs text-muted-foreground">{RESEARCH_SEND_NOTE}。GTFS のファイルは送りません。</p>
            {cachedSelected > 0 && <p className="text-xs text-muted-foreground">{RESEARCH_SAVED_NOTE}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={selectedIds.length === 0 || sending || progress.active} onClick={() => void onStart()}>
                {RESEARCH_START}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={candidates.length === 0 || demo.status === 'loading'} onClick={onDemo}>
                {RESEARCH_DEMO}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{RESEARCH_DEMO_NOTE}</p>
            {demo.status === 'loading' && <p className="text-xs text-muted-foreground">保存済みの結果を読んでいます…</p>}
            {demo.status === 'ready' && (
              <p className="text-xs" role="status">
                {demo.count > 0 ? `保存済みの結果(デモ)${demo.count} 件を出し、その対象を選びました。` : RESEARCH_DEMO_NONE}
              </p>
            )}
            {demo.status === 'error' && (
              <p className="text-xs text-destructive" role="alert">
                {demo.message}
              </p>
            )}
            {researchError && (
              <p className="text-xs text-destructive" role="alert">
                {researchError}
              </p>
            )}
            {progressText && (
              <p className="text-sm" role="status">
                {progressText}
                {progress.active && <span className="block text-xs text-muted-foreground">{RESEARCH_KEEP_OPEN}</span>}
              </p>
            )}
          </div>

          {shownResults.length > 0 && (
            <section className="flex flex-col gap-1.5" aria-labelledby="research-results-heading">
              <h3 id="research-results-heading" className="text-sm font-medium">
                調査の結果({shownResults.length} 件)
              </h3>
              <p className="text-xs text-muted-foreground">{RESEARCH_RESULT_NOTE}</p>
              <ul className="flex flex-col gap-1.5">
                {shownResults.map((r) => (
                  <ResultCard key={r.targetId} result={r} />
                ))}
              </ul>
            </section>
          )}

          {inUse && <p className="text-xs text-muted-foreground">施設の位置と名前:国土数値情報(バス停留所 P11・学校 P29・医療機関 P04)を加工して作成。</p>}
        </>
      )}
    </>
  )
}
