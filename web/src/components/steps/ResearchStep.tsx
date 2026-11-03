import { ArrowDown, ArrowUp, ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore, type StoreApi, type UseBoundStore } from 'zustand'
import StepSection from '@/components/StepSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { checkedAtText, safeUrl, type ResearchResult, type ResearchStatus } from '@/claude/research'
import { FacilitySymbol } from '@/map/FacilityLayer'
import { OTHER_STOP_RADIUS_M } from '@/ref/busstops'
import {
  DEFAULT_SELECT_WALK_M,
  FACILITY_KIND_LABELS,
  groupCandidates,
  initialShownCount,
  operatorMovementFacts,
  type CandidateGroup,
  type ResearchCandidate,
} from '@/ref/facilities'
import { RESEARCH_KEEP_OPEN, RESEARCH_SEND_NOTE, researchText, useChatStore, type ChatState } from '@/store/chat'
import { useGtfsStore } from '@/store/gtfs'
import { useMapStore } from '@/store/map'
import { DEFAULT_PRIORITY, priorityCategory, usePriorityStore } from '@/store/priority'
import {
  facilitiesInUse,
  usePolicyApproved,
  useReducedStops,
  useResearchStops,
  useResearchStore,
  useResearchView,
  type OverlapMap,
  type ReducedStops,
} from '@/store/research'

type ChatStoreHook = UseBoundStore<StoreApi<ChatState>>

// ---- 文言 ----

export const RESEARCH_START = '前提情報を調べる'
export const RESEARCH_DEMO = '保存済みの結果(デモ)を使う'
/** 処理中のボタンの読み上げ */
export const RESEARCH_STARTING = '調査を始めています'
export const RESEARCH_DEMO_LOADING = '保存済みの結果を読み込んでいます'
export const RESEARCH_DEMO_NOTE = 'AI も Web 検索も使わずに、保存済みの調査の結果(デモ用)を出し、その対象を選びます。'
export const RESEARCH_DEMO_NONE = 'この GTFS の停留所の周りには、保存済みの結果(デモ)がありません。'
export const RESEARCH_SAVED_NOTE = '保存済みの対象は調べ直さず(Web 検索をせず)、その結果を使います。'
export const RESEARCH_RESULT_NOTE = '結果は AI が Web で調べたものです。確認日時の後に変わっていることがあるので、出典を開いて確かめてください。'
export const OWN_OPERATOR = '読み込んだ GTFS の事業者'
export const CLOSED_SCHOOL = '休校中か不明'

// 周辺の事業者の行(減便の動きと、こちらの停留所との重なり)
export const NO_NEARBY_STOPS = '近くに停留所なし'
export const OVERLAP_DISCLAIMER = '国土数値情報の停留所には時刻がないため、本数や時間帯で補えるかは、その事業者の時刻表で確かめてください。'
export const NO_BUSSTOP_DATA = '周辺の事業者の停留所の参照データがないため、こちらの停留所との重なりは数えていません。'
export const MOVEMENT_NOT_RESEARCHED = '減便・ダイヤ改正・運休の動きは、まだ調べていません。'
// 見出し(label)で絞った結果だけを言う。廃止など、絞り込みの語に当たらない事実がありうるため「動きがない」とは書かない
export const MOVEMENT_NONE = '調べた結果に、減便・ダイヤ改正・運休・特別ダイヤの見出しの事実はありません。廃止などのほかの動きは、下の「調査の結果」で、ほかの事実と出典を確かめてください。'
export const REDUCED_AFTER_POLICY = '「減便の方針」を承認すると、減便で発車が減る・なくなる停留所の近くにある数も出します。'
export const REDUCED_NO_DATE = '減便の期間に元の平日ダイヤが走る日がないため、減便で発車が減る・なくなる停留所の近くにある数は数えていません。'

/** 事業者の行の重なりの文 */
function overlapText(ownStops: number, otherStops: number, routes: readonly string[]): string {
  return `こちらの停留所 ${ownStops} か所の ${OTHER_STOP_RADIUS_M}m 以内に、この事業者の停留所 ${otherStops} か所(系統:${routesText(routes)})`
}

function dateJa(date: string): string {
  return `${Number(date.slice(0, 4))}年${Number(date.slice(4, 6))}月${Number(date.slice(6, 8))}日`
}

/** 減便で発車が減る・なくなる停留所のうち、ほかの事業者の停留所が近くにある数の文 */
function reducedSummaryText(reduced: number, near: number, date: string): string {
  return `減便で発車が減る・なくなるこちらの停留所 ${reduced} か所のうち、ほかの事業者の停留所が ${OTHER_STOP_RADIUS_M}m 以内にあるのは ${near} か所です(${dateJa(date)}の発車で比べています)。`
}

/** まとまりの残りを開くボタンの文 */
function showMoreText(rest: number): string {
  return `続きを表示(残り ${rest} 件)`
}

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

/**
 * 一覧の行・調査の結果のカードに、マウスとキーボードの焦点で地図の強調を付ける(store/map.ts の highlightedTargetId)。
 * 外れたときは、自分が強調しているときだけ解く(ほかの行に移った後に消さないため)
 */
function highlightHandlers(targetId: string) {
  const on = () => useMapStore.getState().setHighlighted(targetId)
  const off = () => {
    if (useMapStore.getState().highlightedTargetId === targetId) useMapStore.getState().setHighlighted(null)
  }
  return { onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off }
}

/** 系統名を並べる。多いときは先頭の数件と残りの数 */
const MAX_ROUTE_NAMES = 8
function routesText(routes: readonly string[]): string {
  if (routes.length === 0) return '系統名の記載なし'
  if (routes.length <= MAX_ROUTE_NAMES) return routes.join('、')
  return `${routes.slice(0, MAX_ROUTE_NAMES).join('、')} ほか ${routes.length - MAX_ROUTE_NAMES} 系統`
}

/** 事業者の行の、調べた減便の動き(調べた結果のうち、減便・ダイヤ改正・運休・特別ダイヤの事実) */
function OperatorMovement({ result }: { result: ResearchResult | undefined }) {
  if (!result) return <p className="text-muted-foreground">{MOVEMENT_NOT_RESEARCHED}</p>
  const facts = operatorMovementFacts(result.facts)
  const footer = (
    <span className="text-muted-foreground">
      確認日時 {checkedAtText(result.checkedAt)}・{result.origin === 'demo' ? 'デモ用の保存済みの結果' : 'Web で調べた結果'}
    </span>
  )
  if (facts.length === 0) {
    return (
      <p>
        <span className="text-muted-foreground">{MOVEMENT_NONE}</span> {footer}
      </p>
    )
  }
  const cited = [...new Set(facts.map((f) => f.source).filter((n) => n >= 1 && n <= result.sources.length))].sort((a, b) => a - b)
  return (
    <div className="flex flex-col gap-0.5" aria-label="調べた減便の動き">
      <ul className="flex flex-col gap-0.5">
        {facts.map((f, i) => (
          <li key={i}>
            <span className="text-muted-foreground">{f.label}:</span>
            {f.value}
            {f.source >= 1 && f.source <= result.sources.length && <sup className="ml-0.5 text-muted-foreground">[{f.source}]</sup>}
          </li>
        ))}
      </ul>
      {cited.length > 0 && (
        <ol className="flex flex-col gap-0.5" aria-label="出典">
          {cited.map((n) => {
            const s = result.sources[n - 1]
            const url = safeUrl(s.url)
            return (
              <li key={n} className="flex gap-1">
                <span className="text-muted-foreground">[{n}]</span>
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
      {footer}
    </div>
  )
}

/** 事業者の行の中身:調べた減便の動きと、こちらの停留所との重なり */
function OperatorDetail({ candidate, result, reduced }: { candidate: ResearchCandidate; result: ResearchResult | undefined; reduced: ReducedStops | null }) {
  const overlap = candidate.overlap
  const nearReduced = overlap && reduced ? overlap.ownStopIds.filter((id) => reduced.stopIds.has(id)).length : null
  return (
    <div className="mt-0.5 flex flex-col gap-1 pl-5" data-testid={`operator-detail-${candidate.facility.targetId}`}>
      <OperatorMovement result={result} />
      {overlap && (
        <p>
          {overlapText(overlap.ownStopIds.length, overlap.otherStops.length, overlap.routes)}
          {nearReduced !== null && `。このうち、減便で発車が減る・なくなる停留所 ${nearReduced} か所`}
        </p>
      )}
    </div>
  )
}

/** 1つのまとまりの行(選んだ対象のうち最後のものの後ろ3件まで。残りは「続きを表示」で開く) */
function CandidateGroupItems({
  group,
  selected,
  onToggle,
  results,
  highlighted,
  reduced,
}: {
  group: CandidateGroup
  selected: ReadonlySet<string>
  onToggle: (id: string, checked: boolean) => void
  results: ReadonlyMap<string, ResearchResult>
  highlighted: string | null
  reduced: ReducedStops | null
}) {
  const items = group.items
  const initial = initialShownCount(items, selected)
  // 最初に出す件数は、選び足すと増え、外しても減らさない(押している最中の行が消えないように)。候補が替わったら決め直す
  const [shown, setShown] = useState(initial)
  const [prevItems, setPrevItems] = useState(items)
  if (items !== prevItems) {
    setPrevItems(items)
    setShown(initial)
  } else if (initial > shown) {
    setShown(initial)
  }
  const [expanded, setExpanded] = useState(false)
  const count = expanded ? items.length : Math.min(Math.max(shown, initial), items.length)
  const listRef = useRef<HTMLUListElement>(null)
  // 「続きを表示」を押したら、ボタンが消えるので、開いた最初の行に焦点を移す
  const focusFrom = useRef<number | null>(null)
  useEffect(() => {
    if (!expanded || focusFrom.current === null) return
    listRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[focusFrom.current]?.focus()
    focusFrom.current = null
  }, [expanded])

  return (
    <>
      <ul ref={listRef} className="flex flex-col gap-0.5 px-2 pb-2">
        {items.slice(0, count).map((c) => {
          const id = c.facility.targetId
          const result = results.get(id)
          const detail = detailText(c)
          const isOperator = c.facility.kind === 'operator'
          return (
            <li
              key={id}
              {...highlightHandlers(id)}
              data-highlighted={highlighted === id ? 'true' : undefined}
              className="-mx-1 rounded-sm px-1 py-0.5 hover:bg-muted/60 data-[highlighted=true]:bg-muted"
            >
              <label className="flex items-start gap-1.5">
                <input type="checkbox" className="mt-0.5" checked={selected.has(id)} onChange={(e) => onToggle(id, e.target.checked)} aria-label={c.facility.name} />
                <FacilitySymbol kind={c.facility.kind} schoolType={c.facility.schoolType} className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span>{c.facility.name}</span>
                  {detail && <span className="ml-1.5 text-muted-foreground">{detail}</span>}
                  {c.ownOperator && (
                    <Badge variant="outline" className="ml-1.5">
                      {OWN_OPERATOR}
                    </Badge>
                  )}
                  {isOperator && c.overlap === null && (
                    <Badge variant="outline" className="ml-1.5">
                      {NO_NEARBY_STOPS}
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
              {isOperator && !c.ownOperator && <OperatorDetail candidate={c} result={result} reduced={reduced} />}
            </li>
          )
        })}
      </ul>
      {count < items.length && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mx-2 mb-2"
          onClick={() => {
            focusFrom.current = count
            setExpanded(true)
          }}
        >
          {showMoreText(items.length - count)}
        </Button>
      )}
    </>
  )
}

/** 周辺の事業者のまとまりの先頭に出す断り書きと、減便で発車が減る・なくなる停留所との重なり */
function OperatorGroupNote({ overlaps, reduced }: { overlaps: OverlapMap | null; reduced: ReducedStops | null }) {
  // 承認済みでも、減便の期間に元の平日ダイヤが走る日がなければ reduced は null。そのときは「承認すると」と出さない
  const approved = usePolicyApproved()
  let summary: string | null = null
  if (overlaps && reduced) {
    const near = new Set<string>()
    for (const o of overlaps.values()) for (const id of o.ownStopIds) if (reduced.stopIds.has(id)) near.add(id)
    summary = reducedSummaryText(reduced.stopIds.size, near.size, reduced.date)
  }
  return (
    <div className="flex flex-col gap-1 px-2 pb-1.5 text-muted-foreground">
      {overlaps ? <p>{OVERLAP_DISCLAIMER}</p> : <p>{NO_BUSSTOP_DATA}</p>}
      {summary && (
        <p className="text-foreground" data-testid="reduced-summary">
          {summary}
        </p>
      )}
      {overlaps && !reduced && <p>{approved ? REDUCED_NO_DATE : REDUCED_AFTER_POLICY}</p>}
    </div>
  )
}

/** 候補の一覧(種類ごとに折りたたむ。選んだ対象のあるまとまりは開いておく) */
function CandidateList({
  groups,
  selected,
  onToggle,
  results,
  overlaps,
  reduced,
}: {
  groups: readonly CandidateGroup[]
  selected: ReadonlySet<string>
  onToggle: (id: string, checked: boolean) => void
  results: ReadonlyMap<string, ResearchResult>
  overlaps: OverlapMap | null
  reduced: ReducedStops | null
}) {
  const highlighted = useMapStore((s) => s.highlightedTargetId)
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
            {g.key === 'operator' && <OperatorGroupNote overlaps={overlaps} reduced={reduced} />}
            <CandidateGroupItems group={g} selected={selected} onToggle={onToggle} results={results} highlighted={highlighted} reduced={reduced} />
          </CandidateGroupDetails>
        )
      })}
    </div>
  )
}

/** 調査の結果の1件(事実・出典 URL・確認日時・どこから来た結果か)。マウスと焦点で地図の記号を強調する */
export function ResultCard({ result, highlighted = false }: { result: ResearchResult; highlighted?: boolean }) {
  return (
    <li
      className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[highlighted=true]:bg-muted"
      aria-label={`${result.name}の調査の結果`}
      tabIndex={0}
      data-highlighted={highlighted ? 'true' : undefined}
      {...highlightHandlers(result.targetId)}
    >
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
  const { candidates, selectedIds, isDefault, maxTargets, overlaps } = useResearchView()
  const reduced = useReducedStops()
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const groups = useMemo(() => groupCandidates(candidates, order), [candidates, order])
  const [limitNote, setLimitNote] = useState<string | null>(null)
  const highlighted = useMapStore((s) => s.highlightedTargetId)
  // 「前提情報を調べる」の送信(POST)の間
  const [starting, setStarting] = useState(false)
  // 「読み込み直す」を押した後、読み込み終えるまで、前の理由とボタン(処理中)を残す
  const [retryMessage, setRetryMessage] = useState<string | null>(null)

  // 手順を離れたら、地図の強調を解く
  useEffect(() => () => useMapStore.getState().setHighlighted(null), [])

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
    setStarting(true)
    try {
      const view = await chat.getState().startResearch(selectedIds)
      if (view) useResearchStore.getState().setTargets(view.targets, view.maxTargets)
    } finally {
      setStarting(false)
    }
  }

  const onRetry = async () => {
    setRetryMessage(facilities.status === 'error' ? facilities.message : null)
    try {
      await loadFacilities(stops)
    } finally {
      setRetryMessage(null)
    }
  }
  const retrying = retryMessage !== null && facilities.status === 'loading'

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

      {facilities.status === 'loading' && !retrying && <p className="text-sm text-muted-foreground">周辺の施設を読み込んでいます…</p>}
      {(facilities.status === 'error' || retrying) && (
        <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 px-2 py-1.5 text-sm" role="alert">
          <p>{facilities.status === 'error' ? facilities.message : retryMessage}</p>
          <Button type="button" variant="outline" size="xs" className="self-start" loading={retrying} loadingLabel="読み込み直しています" onClick={() => void onRetry()}>
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
                  GTFS の事業者を除き、こちらの停留所の近くに停留所がある事業者を、その停留所の多い順に)を、{maxTargets} 件まで選んでいます。
                </p>
              )}
              {limitNote && (
                <p className="text-xs text-destructive" role="alert">
                  {limitNote}
                </p>
              )}
              <CandidateList groups={groups} selected={selected} onToggle={onToggle} results={results} overlaps={overlaps} reduced={reduced} />
            </>
          )}

          <div className="flex flex-col gap-1.5 rounded-md border px-2 py-2">
            <p className="text-xs text-muted-foreground">{RESEARCH_SEND_NOTE}。GTFS のファイルは送りません。</p>
            {cachedSelected > 0 && <p className="text-xs text-muted-foreground">{RESEARCH_SAVED_NOTE}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                loading={starting}
                loadingLabel={RESEARCH_STARTING}
                disabled={selectedIds.length === 0 || sending || progress.active}
                onClick={() => void onStart()}
              >
                {RESEARCH_START}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={demo.status === 'loading'}
                loadingLabel={RESEARCH_DEMO_LOADING}
                disabled={candidates.length === 0}
                onClick={onDemo}
              >
                {RESEARCH_DEMO}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{RESEARCH_DEMO_NOTE}</p>
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
                  <ResultCard key={r.targetId} result={r} highlighted={highlighted === r.targetId} />
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
