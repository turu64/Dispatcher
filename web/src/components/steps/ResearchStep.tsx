import {
  ArrowDown,
  ArrowUp,
  BusFront,
  Clock,
  ExternalLink,
  GripVertical,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, type StoreApi, type UseBoundStore } from "zustand";
import StepSection from "@/components/StepSection";
import {
  researchSummary,
  resultHighlights,
} from "@/components/steps/research/highlights";
import OperationPremise from "@/components/steps/research/OperationPremise";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  checkedAtText,
  safeUrl,
  type ResearchResult,
  type ResearchStatus,
} from "@/claude/research";
import { FacilitySymbol } from "@/map/FacilityLayer";
import { OTHER_STOP_RADIUS_M } from "@/ref/busstops";
import {
  countsTowardLimit,
  DEFAULT_SELECT_WALK_M,
  groupCandidates,
  initialShownCount,
  operatorMovementFacts,
  operatorShownCount,
  type CandidateGroup,
  type ResearchCandidate,
} from "@/ref/facilities";
import {
  RESEARCH_KEEP_OPEN,
  RESEARCH_SEND_NOTE,
  researchText,
  useChatStore,
  type ChatState,
} from "@/store/chat";
import { useGtfsStore } from "@/store/gtfs";
import { useMapStore } from "@/store/map";
import {
  DEFAULT_PRIORITY,
  priorityCategory,
  usePriorityStore,
  type PriorityKey,
} from "@/store/priority";
import {
  facilitiesInUse,
  usePolicyApproved,
  useReducedStops,
  useResearchStops,
  useResearchStore,
  useResearchView,
  type OverlapMap,
  type ReducedStops,
} from "@/store/research";

type ChatStoreHook = UseBoundStore<StoreApi<ChatState>>;

// ---- 文言 ----

export const RESEARCH_START = "前提情報を調べる";
export const RESEARCH_DEMO = "保存済みの結果(デモ)を使う";
/** 処理中のボタンの読み上げ */
export const RESEARCH_STARTING = "調査を始めています";
export const RESEARCH_DEMO_LOADING = "保存済みの結果を読み込んでいます";
export const RESEARCH_DEMO_NOTE =
  "AI も Web 検索も使わずに、保存済みの調査の結果(デモ用)を出し、その対象を選びます。";
export const RESEARCH_DEMO_NONE =
  "この GTFS の停留所の周りには、保存済みの結果(デモ)がありません。";
export const RESEARCH_SAVED_NOTE =
  "保存済みの対象は調べ直さず(Web 検索をせず)、その結果を使います。";
export const RESEARCH_RESULT_NOTE =
  "結果は AI が Web で調べたものです。確認日時のあとに変わっていることがあります。出典を開いて確かめてください。";
export const OWN_OPERATOR = "読み込んだ GTFS の事業者";
/** 読み込んだ GTFS の事業者のチェックボックスの説明(変更できない・調べる対象にしない) */
export const OWN_OPERATOR_FIXED =
  "読み込んだ GTFS の事業者は、調べる対象にしません(変更できません)。";
/**
 * 行の下に出す、調べた結果の全部の開閉の見出し(最初は閉じておく)。行には要点(学校・病院は判断に使う時刻とバスの案内、
 * 事業者は減便の動き)だけを出す(2026-11-07 に利用者の指示で、事実をすべて開いて並べる形をやめた)
 */
export const RESULT_ALL_LABEL = "調べた結果のすべて";
/** 欄の先頭のまとめの見出し */
export const RESEARCH_SUMMARY_TITLE = "調べた結果のまとめ";
export const RESEARCH_SUMMARY_NOTE =
  "読めた時刻は、「平日便を戻す」の判断材料(学校・病院に着く便・出る便)の時間帯に使います。各行には要点だけを出し、事実と出典のすべては「調べた結果のすべて」を開くと見られます。";
/** 重要拠点の優先順位の Dialog を開くボタンの文と、Dialog の見出し */
export const PRIORITY_TITLE = "重要拠点の優先順位";
export const CLOSED_SCHOOL = "休校中か不明";

// 周辺の事業者の行(減便の動きと、こちらの停留所との重なり)
export const NO_NEARBY_STOPS = "近くに停留所なし";
export const OVERLAP_DISCLAIMER =
  "国土数値情報の停留所には時刻がないため、本数や時間帯で補えるかは、その事業者の時刻表で確かめてください。";
export const NO_BUSSTOP_DATA =
  "周辺の事業者の停留所の参照データがないため、こちらの停留所との重なりは数えていません。";
/** まだ調べていない周辺の事業者の行に付けるバッジと、その説明(title) */
export const NOT_RESEARCHED_BADGE = "未調査";
export const NOT_RESEARCHED_TITLE =
  "減便・ダイヤ改正・運休の動きは、まだ調べていません。";
// 見出し(label)で絞った結果だけを言う。廃止など、絞り込みの語に当たらない事実がありうるため「動きがない」とは書かない
export const MOVEMENT_NONE =
  "調べた結果に、減便・ダイヤ改正・運休・特別ダイヤの見出しの事実はありません。廃止などのほかの動きは、下の「調べた結果のすべて」を開いて、ほかの事実と出典を確かめてください。";
export const REDUCED_AFTER_POLICY =
  "「減便の方針」を承認すると、発車が減る・なくなる停留所のうち、ほかの事業者の停留所が近くにある数も表示します。";
export const REDUCED_NO_DATE =
  "減便の期間に元の平日ダイヤが走る日がないため、発車が減る・なくなる停留所のうち、ほかの事業者の停留所が近くにある数は数えていません。";

/** 事業者の行の重なりの文 */
function overlapText(
  ownStops: number,
  otherStops: number,
  routes: readonly string[],
): string {
  return `こちらの停留所 ${ownStops} か所の ${OTHER_STOP_RADIUS_M}m 以内に、この事業者の停留所 ${otherStops} か所(系統:${routesText(routes)})`;
}

function dateJa(date: string): string {
  return `${Number(date.slice(0, 4))}年${Number(date.slice(4, 6))}月${Number(date.slice(6, 8))}日`;
}

/** 減便で発車が減る・なくなる停留所のうち、ほかの事業者の停留所が近くにある数の文 */
function reducedSummaryText(
  reduced: number,
  near: number,
  date: string,
): string {
  return `減便で発車が減る・なくなるこちらの停留所 ${reduced} か所のうち、ほかの事業者の停留所が ${OTHER_STOP_RADIUS_M}m 以内にあるのは ${near} か所です(${dateJa(date)}の発車で比べています)。`;
}

/** まとまりの残りを開くボタンの文 */
function showMoreText(rest: number): string {
  return `続きを表示(残り ${rest} 件)`;
}

const STATUS_LABELS: Record<ResearchStatus, string> = {
  found: "見つかった",
  partial: "一部だけ見つかった",
  not_found: "見つからなかった",
};

/** 候補の1行に添える詳しいこと(学校の種別、病床、救急、停留所までの距離) */
function detailText(c: ResearchCandidate): string {
  const f = c.facility;
  const parts: string[] = [];
  if (f.municipality) parts.push(f.municipality);
  if (f.kind === "school" && f.schoolType) parts.push(f.schoolType);
  if ((f.kind === "hospital" || f.kind === "clinic") && f.beds !== undefined)
    parts.push(`病床 ${f.beds}`);
  if (f.emergency) parts.push("救急告示");
  if (f.kind !== "operator" && Number.isFinite(c.nearestStopM))
    parts.push(
      `停留所から ${Math.round(c.nearestStopM).toLocaleString("ja-JP")}m`,
    );
  return parts.join("・");
}

// ---- 部品 ----

/** 欄に出す、今の優先順位の要約に入れる種類の数 */
const PRIORITY_SUMMARY_COUNT = 3;

/** 今の優先順位の要約(上から3つと残りの数) */
function prioritySummary(order: readonly PriorityKey[]): string {
  const head = order
    .slice(0, PRIORITY_SUMMARY_COUNT)
    .map((key, i) => `${i + 1} ${priorityCategory(key).label}`);
  const rest = order.length - head.length;
  return `優先する順:${head.join("、")}${rest > 0 ? ` ほか ${rest} 種類` : ""}`;
}

/**
 * 重要拠点の優先順位。欄には今の順の要約と「重要拠点の優先順位」のボタンを出し、Dialog の中で並べ替える
 * (11/6 の利用者の指示。前は開閉(details)の中にあった)。データの無い種類は「データ未対応」。
 * 行をドラッグして並べ替える(11/6 の利用者の指示)。ドラッグしている行が別の行の上に来たら、その位置へすぐ動かす。
 * キーボードでも並べ替えられるよう、行の「上へ」「下へ」のボタンも残す。並べ替えるとすぐに store が変わる(保存のボタンは無い)
 */
export function PriorityList() {
  const order = usePriorityStore((s) => s.order);
  const move = usePriorityStore((s) => s.move);
  const moveTo = usePriorityStore((s) => s.moveTo);
  const reset = usePriorityStore((s) => s.reset);
  // ドラッグしている種類(ドラッグしていなければ null)
  const [dragging, setDragging] = useState<PriorityKey | null>(null);
  const changed = order.some((k, i) => k !== DEFAULT_PRIORITY[i].key);
  const listRef = useRef<HTMLOListElement>(null);
  // 動かした後も、動かした種類のボタンに焦点を残す(端に着いて押せなくなったら、逆向きのボタンへ)
  const focusAfterMove = useRef<{ key: PriorityKey; dir: -1 | 1 } | null>(null);
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target) return;
    focusAfterMove.current = null;
    const button = (dir: -1 | 1) =>
      listRef.current?.querySelector<HTMLButtonElement>(
        `button[data-move="${dir}"][data-key="${target.key}"]`,
      );
    const same = button(target.dir);
    const next =
      same && !same.disabled ? same : button(target.dir === -1 ? 1 : -1);
    next?.focus();
  }, [order]);
  const onMove = (key: PriorityKey, dir: -1 | 1) => {
    focusAfterMove.current = { key, dir };
    move(key, dir);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        className="min-w-0 text-muted-foreground"
        data-testid="priority-summary"
      >
        {prioritySummary(order)}
        {changed ? "(変更あり)" : ""}
      </span>
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="xs">
            {PRIORITY_TITLE}
          </Button>
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>{PRIORITY_TITLE}</DialogTitle>
            <DialogDescription>
              上ほど優先します。行をドラッグして並べ替えます(キーボードでは「上へ」「下へ」のボタン)。調べる対象の既定の選び方と、便を平日に戻す判断材料の並びに使います。データのない種類は選べません。
            </DialogDescription>
          </DialogHeader>
          <ol
            ref={listRef}
            className="flex flex-col gap-1 text-xs"
            aria-label={PRIORITY_TITLE}
          >
            {order.map((key, i) => {
              const cat = priorityCategory(key);
              return (
                <li
                  key={key}
                  draggable
                  data-testid={`priority-row-${key}`}
                  aria-grabbed={dragging === key ? true : undefined}
                  onDragStart={(e) => {
                    setDragging(key);
                    e.dataTransfer.effectAllowed = "move";
                    // 一部のブラウザは何か入れないとドラッグを始めない
                    e.dataTransfer.setData("text/plain", key);
                  }}
                  onDragOver={(e) => {
                    if (dragging === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragging !== key) moveTo(dragging, i);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(null);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={cn(
                    "flex cursor-grab items-center gap-1.5 rounded-md border border-transparent bg-background px-1 py-1 active:cursor-grabbing",
                    "hover:border-border",
                    dragging === key &&
                      "border-dashed border-primary bg-muted opacity-70",
                  )}
                >
                  <GripVertical
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="w-5 text-right tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        cat.data === "none"
                          ? "text-muted-foreground"
                          : undefined
                      }
                    >
                      {cat.label}
                    </span>
                    {cat.data === "none" ? (
                      <Badge variant="outline" className="ml-1.5">
                        データ未対応
                      </Badge>
                    ) : (
                      <span className="ml-1.5 text-muted-foreground">
                        {cat.dataNote}
                      </span>
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${cat.label}を上へ`}
                    data-key={key}
                    data-move="-1"
                    disabled={i === 0}
                    onClick={() => onMove(key, -1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${cat.label}を下へ`}
                    data-key={key}
                    data-move="1"
                    disabled={i === order.length - 1}
                    onClick={() => onMove(key, 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ol>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!changed}
              onClick={reset}
            >
              既定の並びに戻す
            </Button>
            <DialogClose asChild>
              <Button type="button" size="sm">
                閉じる
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResultBadge({ result }: { result: ResearchResult }) {
  return (
    <Badge variant={result.status === "not_found" ? "outline" : "secondary"}>
      {result.origin === "demo" ? "保存済み(デモ)" : "調査済み"}・
      {STATUS_LABELS[result.status]}
    </Badge>
  );
}

/**
 * 候補の種類ごとのまとまり(折りたたむ)。開くかどうかは利用者が決め、選んだ数では閉じない
 * (最後の1件を外したときに、押している最中のまとまりが閉じないように)。
 * 最初に選んだ対象があれば開いておき、外から選ばれた(既定の選び方・デモの結果)ときも開く。閉じるのは利用者だけ
 */
function CandidateGroupDetails({
  label,
  picked,
  children,
}: {
  label: string;
  picked: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(picked > 0);
  const [prevPicked, setPrevPicked] = useState(picked);
  if (picked !== prevPicked) {
    setPrevPicked(picked);
    if (prevPicked === 0 && picked > 0) setOpen(true);
  }
  return (
    <details
      className="rounded-md border text-xs"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      aria-label={label}
    >
      {children}
    </details>
  );
}

/**
 * 一覧の行(行の下の調べた結果を含む)に、マウスとキーボードの焦点で地図の強調を付ける(store/map.ts の highlightedTargetId)。
 * 外れたときは、自分が強調しているときだけ解く(ほかの行に移った後に消さないため)
 */
function highlightHandlers(targetId: string) {
  const on = () => useMapStore.getState().setHighlighted(targetId);
  const off = () => {
    if (useMapStore.getState().highlightedTargetId === targetId)
      useMapStore.getState().setHighlighted(null);
  };
  return { onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off };
}

/** 系統名を並べる。多いときは先頭の数件と残りの数 */
const MAX_ROUTE_NAMES = 8;
function routesText(routes: readonly string[]): string {
  if (routes.length === 0) return "系統名の記載なし";
  if (routes.length <= MAX_ROUTE_NAMES) return routes.join("、");
  return `${routes.slice(0, MAX_ROUTE_NAMES).join("、")} ほか ${routes.length - MAX_ROUTE_NAMES} 系統`;
}

/**
 * 事業者の行の、調べた減便の動き(調べた結果のうち、減便・ダイヤ改正・運休・特別ダイヤの事実)。
 * 1件を2行までに切り、出典は番号のリンクだけを添える(確認日時と出典の一覧は「調べた結果のすべて」に出す)
 */
function OperatorMovement({ result }: { result: ResearchResult | undefined }) {
  // 調べていなければ、行の名前の横の「未調査」のバッジで示す
  if (!result) return null;
  const facts = operatorMovementFacts(result.facts);
  if (facts.length === 0)
    return <p className="text-muted-foreground">{MOVEMENT_NONE}</p>;
  return (
    <ul className="flex flex-col gap-0.5" aria-label="調べた減便の動き">
      {facts.map((f, i) => (
        <li key={i} className="line-clamp-2">
          <TriangleAlert
            className="mr-1 inline size-3 align-[-1px] text-amber-600"
            aria-hidden="true"
          />
          <span className="text-muted-foreground">{f.label}:</span>
          {f.value}
          <SourceRef result={result} source={f.source} />
        </li>
      ))}
    </ul>
  );
}

/** 事業者の行の中身:調べた減便の動きと、こちらの停留所との重なり */
function OperatorDetail({
  candidate,
  result,
  reduced,
}: {
  candidate: ResearchCandidate;
  result: ResearchResult | undefined;
  reduced: ReducedStops | null;
}) {
  const overlap = candidate.overlap;
  const nearReduced =
    overlap && reduced
      ? overlap.ownStopIds.filter((id) => reduced.stopIds.has(id)).length
      : null;
  return (
    <div
      className="mt-0.5 flex flex-col gap-1 pl-5"
      data-testid={`operator-detail-${candidate.facility.targetId}`}
    >
      <OperatorMovement result={result} />
      {overlap && (
        <p className="line-clamp-2 text-muted-foreground">
          {overlapText(
            overlap.ownStopIds.length,
            overlap.otherStops.length,
            overlap.routes,
          )}
          {nearReduced !== null &&
            `。このうち、減便で発車が減る・なくなる停留所 ${nearReduced} か所`}
        </p>
      )}
      {result && <RowResult result={result} />}
    </div>
  );
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
  group: CandidateGroup;
  selected: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  results: ReadonlyMap<string, ResearchResult>;
  highlighted: string | null;
  reduced: ReducedStops | null;
}) {
  const items = group.items;
  // 選んだ対象と、調べた結果のある対象は、「続きを表示」の後ろに隠さない(結果を行の下に出すため)
  const kept = useMemo(() => {
    const ids = new Set(selected);
    for (const c of items)
      if (results.has(c.facility.targetId)) ids.add(c.facility.targetId);
    return ids;
  }, [items, selected, results]);
  const initial =
    group.key === "operator"
      ? operatorShownCount(items, kept)
      : initialShownCount(items, kept);
  // 最初に出す件数は、選び足すと増え、外しても減らさない(押している最中の行が消えないように)。候補が替わったら決め直す
  const [shown, setShown] = useState(initial);
  const [prevItems, setPrevItems] = useState(items);
  if (items !== prevItems) {
    setPrevItems(items);
    setShown(initial);
  } else if (initial > shown) {
    setShown(initial);
  }
  const [expanded, setExpanded] = useState(false);
  const count = expanded
    ? items.length
    : Math.min(Math.max(shown, initial), items.length);
  const listRef = useRef<HTMLUListElement>(null);
  // 「続きを表示」を押したら、ボタンが消えるので、開いた最初の行に焦点を移す
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    if (!expanded || focusFrom.current === null) return;
    listRef.current
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      [focusFrom.current]?.focus();
    focusFrom.current = null;
  }, [expanded]);

  return (
    <>
      <ul ref={listRef} className="flex flex-col gap-0.5 px-2 pb-2">
        {items.slice(0, count).map((c) => {
          const id = c.facility.targetId;
          const result = results.get(id);
          const detail = detailText(c);
          const isOperator = c.facility.kind === "operator";
          return (
            <li
              key={id}
              {...highlightHandlers(id)}
              data-highlighted={highlighted === id ? "true" : undefined}
              className="-mx-1 rounded-sm px-1 py-0.5 hover:bg-muted/60 data-[highlighted=true]:bg-muted"
            >
              <label className="flex items-start gap-1.5">
                {c.ownOperator ? (
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={false}
                    disabled
                    readOnly
                    ref={(el) => {
                      if (el) el.indeterminate = true;
                    }}
                    title={OWN_OPERATOR_FIXED}
                    aria-label={c.facility.name}
                    aria-description={OWN_OPERATOR_FIXED}
                  />
                ) : (
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.has(id)}
                    onChange={(e) => onToggle(id, e.target.checked)}
                    aria-label={c.facility.name}
                  />
                )}
                <FacilitySymbol
                  kind={c.facility.kind}
                  schoolType={c.facility.schoolType}
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span>{c.facility.name}</span>
                  {detail && (
                    <span className="ml-1.5 text-muted-foreground">
                      {detail}
                    </span>
                  )}
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
                  {isOperator && !c.ownOperator && !result && (
                    <Badge
                      variant="outline"
                      className="ml-1.5"
                      title={NOT_RESEARCHED_TITLE}
                    >
                      {NOT_RESEARCHED_BADGE}
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
              {isOperator && !c.ownOperator ? (
                <OperatorDetail
                  candidate={c}
                  result={result}
                  reduced={reduced}
                />
              ) : (
                result && <FacilityHighlights result={result} />
              )}
            </li>
          );
        })}
      </ul>
      {count < items.length && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mx-2 mb-2"
          onClick={() => {
            focusFrom.current = count;
            setExpanded(true);
          }}
        >
          {showMoreText(items.length - count)}
        </Button>
      )}
    </>
  );
}

/** 周辺の事業者のまとまりの先頭に出す断り書きと、減便で発車が減る・なくなる停留所との重なり */
function OperatorGroupNote({
  overlaps,
  reduced,
}: {
  overlaps: OverlapMap | null;
  reduced: ReducedStops | null;
}) {
  // 承認済みでも、減便の期間に元の平日ダイヤが走る日がなければ reduced は null。そのときは「承認すると」と出さない
  const approved = usePolicyApproved();
  let summary: string | null = null;
  if (overlaps && reduced) {
    const near = new Set<string>();
    for (const o of overlaps.values())
      for (const id of o.ownStopIds) if (reduced.stopIds.has(id)) near.add(id);
    summary = reducedSummaryText(reduced.stopIds.size, near.size, reduced.date);
  }
  return (
    <div className="flex flex-col gap-1 px-2 pb-1.5 text-muted-foreground">
      {overlaps ? <p>{OVERLAP_DISCLAIMER}</p> : <p>{NO_BUSSTOP_DATA}</p>}
      {summary && (
        <p className="text-foreground" data-testid="reduced-summary">
          {summary}
        </p>
      )}
      {overlaps && !reduced && (
        <p>{approved ? REDUCED_NO_DATE : REDUCED_AFTER_POLICY}</p>
      )}
    </div>
  );
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
  groups: readonly CandidateGroup[];
  selected: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  results: ReadonlyMap<string, ResearchResult>;
  overlaps: OverlapMap | null;
  reduced: ReducedStops | null;
}) {
  const highlighted = useMapStore((s) => s.highlightedTargetId);
  return (
    <div
      className="flex flex-col gap-1.5"
      role="group"
      aria-label="調べる対象の候補"
    >
      {groups.map((g) => {
        const picked = g.items.filter((c) =>
          selected.has(c.facility.targetId),
        ).length;
        const withResult = g.items.filter((c) =>
          results.has(c.facility.targetId),
        ).length;
        return (
          <CandidateGroupDetails key={g.key} label={g.label} picked={picked}>
            <summary className="cursor-pointer px-2 py-1.5">
              <span className="font-medium">{g.label}</span>
              <span className="ml-2 text-muted-foreground">
                {g.items.length} 件(選んだ {picked} 件
                {withResult > 0 ? `・調べた結果 ${withResult} 件` : ""})
              </span>
            </summary>
            {g.key === "operator" && (
              <OperatorGroupNote overlaps={overlaps} reduced={reduced} />
            )}
            <CandidateGroupItems
              group={g}
              selected={selected}
              onToggle={onToggle}
              results={results}
              highlighted={highlighted}
              reduced={reduced}
            />
          </CandidateGroupDetails>
        );
      })}
    </div>
  );
}

/** 調べた結果の中身(事実・注記・出典 URL・確認日時・どこから来た結果か) */
function ResultBody({ result }: { result: ResearchResult }) {
  return (
    <div className="flex flex-col gap-1">
      {result.facts.length > 0 && (
        <dl className="flex flex-col gap-1">
          {result.facts.map((f, i) => (
            <div key={i} className="min-w-0">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="break-words">
                {f.value}
                {f.source >= 1 && f.source <= result.sources.length && (
                  <sup className="ml-0.5 text-muted-foreground">
                    [{f.source}]
                  </sup>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {result.note && <p className="text-muted-foreground">{result.note}</p>}
      {result.sources.length > 0 && (
        <ol className="flex flex-col gap-0.5" aria-label="出典">
          {result.sources.map((s, i) => {
            const url = safeUrl(s.url);
            return (
              <li key={i} className="flex gap-1">
                <span className="text-muted-foreground">[{i + 1}]</span>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-0.5 break-all underline underline-offset-2"
                  >
                    {s.title || url}
                    <ExternalLink
                      className="size-3 shrink-0"
                      aria-hidden="true"
                    />
                  </a>
                ) : (
                  <span className="text-muted-foreground">
                    {s.title || "(URL を表示できません)"}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="text-muted-foreground">
        確認日時 {checkedAtText(result.checkedAt)}・
        {result.origin === "demo"
          ? "デモ用の保存済みの結果"
          : "Web で調べた結果"}
      </p>
    </div>
  );
}

/** 出典の番号のリンク([1])。番号が範囲の外か URL が使えなければ番号だけ */
function SourceRef({
  result,
  source,
}: {
  result: ResearchResult;
  source: number | null;
}) {
  if (source === null || source < 1 || source > result.sources.length)
    return null;
  const s = result.sources[source - 1];
  const url = safeUrl(s.url);
  const label = `[${source}]`;
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={s.title || url}
      aria-label={`出典 ${source}:${s.title || url}`}
      className="ml-0.5 align-super text-[10px] text-muted-foreground underline underline-offset-2"
    >
      {label}
    </a>
  ) : (
    <sup className="ml-0.5 text-muted-foreground">{label}</sup>
  );
}

/** 学校・病院・診療所の行の要点(判断に使う時刻・バスの案内)と、閉じた「調べた結果のすべて」 */
function FacilityHighlights({ result }: { result: ResearchResult }) {
  const h = resultHighlights(result);
  return (
    <div
      className="mt-0.5 flex flex-col gap-0.5 pl-5"
      data-testid={`result-highlights-${result.targetId}`}
    >
      {h.times.length > 0 ? (
        <p className="font-medium">
          <Clock
            className="mr-1 inline size-3 align-[-1px] text-primary"
            aria-hidden="true"
          />
          {h.times.map((t, i) => (
            <span key={t.text}>
              {i > 0 && "・"}
              {t.text}
              <SourceRef result={result} source={t.source} />
            </span>
          ))}
        </p>
      ) : (
        h.timeMissing && (
          <p className="text-muted-foreground">
            <Clock
              className="mr-1 inline size-3 align-[-1px]"
              aria-hidden="true"
            />
            {h.timeMissing}
          </p>
        )
      )}
      {h.access && (
        <p className="line-clamp-2">
          <BusFront
            className="mr-1 inline size-3 align-[-1px] text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-muted-foreground">{h.access.label}:</span>
          {h.access.value}
          <SourceRef result={result} source={h.access.source} />
        </p>
      )}
      <RowResult result={result} />
    </div>
  );
}

/** 欄の先頭に出す、調べた結果のまとめ(種類ごとの件数と、時刻を読めた数) */
function ResearchSummary({ results }: { results: readonly ResearchResult[] }) {
  const rows = researchSummary(results);
  return (
    <section
      className="flex flex-col gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-sm"
      aria-label={RESEARCH_SUMMARY_TITLE}
      data-testid="research-summary"
    >
      <h4 className="font-medium">
        {RESEARCH_SUMMARY_TITLE}
        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
          ({results.length} 件)
        </span>
      </h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map((r) => (
          <div key={r.key} className="contents">
            <dt className="text-muted-foreground">
              {r.label} <span className="tabular-nums">{r.total}</span> 件
            </dt>
            <dd>
              {r.hitLabel} <strong className="tabular-nums">{r.hit}</strong> 件
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{RESEARCH_SUMMARY_NOTE}</p>
      <p
        className="text-xs text-muted-foreground"
        data-testid="research-result-note"
      >
        {RESEARCH_RESULT_NOTE}
      </p>
    </section>
  );
}

/**
 * 候補の行の下に出す、調べた結果(11/6 の利用者の指示で、別の「調査の結果」のまとまりから行の下に移した)。
 * 行ごとに開閉でき、開くかどうかは利用者が決める。地図の強調は行(li)のマウスと焦点で付く(中の見出しやリンクの焦点も含む)
 */
function RowResult({ result }: { result: ResearchResult }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-md border bg-background px-2 py-1"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      aria-label={`${result.name}の調査の結果`}
    >
      <summary className="cursor-pointer text-muted-foreground">
        {RESULT_ALL_LABEL}(事実 {result.facts.length} 件・出典{" "}
        {result.sources.length} 件)
      </summary>
      <div className="mt-1">
        <ResultBody result={result} />
      </div>
    </details>
  );
}

/**
 * 前提情報の手順。停留所の分布の外接矩形 +2km にある周辺のバス事業者・学校・病院を参照データ(国土数値情報)から洗い出し、
 * 調べる対象を選んで AI に Web で調べてもらう(docs/interfaces-1105.md §3.2・§6.4、docs/tasks-1103.md の T16)。
 * 対象は重要拠点の優先順位の上から既定で選び、上限は 30 件。保存済みの結果(デモ)を使えば、AI を呼ばずに結果を見られる。
 * サーバーに送るのは target_id だけ。GTFS の中身は送らない。
 * 調査の欄の上に、運行の前提(営業所・運転士の数。research/OperationPremise.tsx)の欄を置く
 */
export default function ResearchStep({
  chat = useChatStore,
}: {
  chat?: ChatStoreHook;
}) {
  const feed = useGtfsStore((s) => s.feed);
  return (
    <StepSection title="2. 前提情報">
      {!feed ? (
        <p className="text-sm text-muted-foreground">
          GTFS
          を読み込むと、運行の前提(営業所・運転士の数)を設定し、周辺の事業者・学校・病院を調べられます。
        </p>
      ) : (
        <ResearchBody chat={chat} />
      )}
    </StepSection>
  );
}

function ResearchBody({ chat }: { chat: ChatStoreHook }) {
  const stops = useResearchStops();
  const facilities = useResearchStore((s) => s.facilities);
  const loadFacilities = useResearchStore((s) => s.loadFacilities);
  const results = useResearchStore((s) => s.results);
  const targets = useResearchStore((s) => s.targets);
  const demo = useResearchStore((s) => s.demo);
  const inUse = useResearchStore(facilitiesInUse);
  const order = usePriorityStore((s) => s.order);
  const { candidates, selectedIds, isDefault, maxTargets, overlaps } =
    useResearchView();
  const reduced = useReducedStops();
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const byId = useMemo(
    () => new Map(candidates.map((c) => [c.facility.targetId, c])),
    [candidates],
  );
  // 選んだ対象のうち、上限に数えるもの(周辺のバス事業者以外)と、事業者
  const pickedOperators = selectedIds.filter(
    (id) => byId.get(id)?.facility.kind === "operator",
  ).length;
  const pickedOthers = selectedIds.length - pickedOperators;
  const groups = useMemo(
    () => groupCandidates(candidates, order),
    [candidates, order],
  );
  const [limitNote, setLimitNote] = useState<string | null>(null);
  // 「前提情報を調べる」の送信(POST)の間
  const [starting, setStarting] = useState(false);
  // 「読み込み直す」を押した後、読み込み終えるまで、前の理由とボタン(処理中)を残す
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  // 手順を離れたら、地図の強調を解く
  useEffect(() => () => useMapStore.getState().setHighlighted(null), []);

  const sending = useStore(chat, (s) => s.sending);
  const progress = useStore(chat, (s) => s.research);
  const researchError = useStore(chat, (s) => s.researchError);
  const progressText = researchText(progress);

  // GTFS を読み込んだら(停留所が決まったら)、その周りの施設を読む
  useEffect(() => {
    if (stops.length > 0)
      void useResearchStore.getState().loadFacilities(stops);
  }, [stops]);

  // 調べた結果が保存されたら(進み具合の saved が増えた・調べ終えた)、保存済みの結果を読み直す
  const saved = progress.saved;
  const outcome = progress.outcome;
  useEffect(() => {
    if (targets === null) return;
    let cancelled = false;
    void chat
      .getState()
      .loadResearch()
      .then((overview) => {
        if (cancelled || !overview) return;
        useResearchStore.getState().mergeResults(overview.results);
      });
    return () => {
      cancelled = true;
    };
  }, [chat, targets, saved, outcome]);

  const onToggle = (id: string, checked: boolean) => {
    const next = selectedIds.filter((x) => x !== id);
    if (checked) {
      // 上限は周辺のバス事業者を除いて数える(事業者は上限なしに選べる)
      const target = byId.get(id);
      if (
        target &&
        countsTowardLimit(target) &&
        next.filter((x) => {
          const c = byId.get(x);
          return !c || countsTowardLimit(c);
        }).length >= maxTargets
      ) {
        setLimitNote(
          `調べる対象(周辺のバス事業者を除く)は ${maxTargets} 件までです。ほかの対象を外してから選んでください。`,
        );
        return;
      }
      next.push(id);
    }
    setLimitNote(null);
    useResearchStore.getState().setSelected(next);
  };

  const onStart = async () => {
    setStarting(true);
    try {
      const view = await chat.getState().startResearch(selectedIds);
      if (view)
        useResearchStore.getState().setTargets(view.targets, view.maxTargets);
    } finally {
      setStarting(false);
    }
  };

  const onRetry = async () => {
    setRetryMessage(facilities.status === "error" ? facilities.message : null);
    try {
      await loadFacilities(stops);
    } finally {
      setRetryMessage(null);
    }
  };
  const retrying = retryMessage !== null && facilities.status === "loading";

  const onDemo = () => {
    void useResearchStore
      .getState()
      .loadDemo(new Set(candidates.map((c) => c.facility.targetId)));
  };

  // 候補のうち、調べた結果のあるもの(要点は候補の行の下に、まとめは欄の先頭に出す)
  const shownResults = useMemo(
    () => candidates.flatMap((c) => results.get(c.facility.targetId) ?? []),
    [candidates, results],
  );
  const cachedSelected = selectedIds.filter((id) => results.has(id)).length;

  return (
    <>
      <OperationPremise />

      <h3 className="text-sm font-medium">周辺の事業者・施設の調査</h3>
      <p className="text-sm text-muted-foreground">
        停留所の分布の外周に 2km
        の余白を足した範囲から、周辺のバス事業者・学校・病院を洗い出します。調べる対象を選び、AI
        に Web
        で調べてもらうと、通学・通院の時刻などの判断材料が出典つきで集まります。調査は飛ばして、次の「減便の方針」へ進めます。
      </p>

      <PriorityList />

      {facilities.status === "loading" && !retrying && (
        <p className="text-sm text-muted-foreground">
          周辺の施設を読み込んでいます…
        </p>
      )}
      {(facilities.status === "error" || retrying) && (
        <div
          className="flex flex-col gap-1.5 rounded-md border border-destructive/40 px-2 py-1.5 text-sm"
          role="alert"
        >
          <p>
            {facilities.status === "error" ? facilities.message : retryMessage}
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="self-start"
            loading={retrying}
            loadingLabel="読み込み直しています"
            onClick={() => void onRetry()}
          >
            読み込み直す
          </Button>
        </div>
      )}
      {stops.length === 0 && (
        <p className="text-sm text-muted-foreground">
          乗れる停留所がないため、施設を探す範囲を決められません。
        </p>
      )}

      {facilities.status === "ready" && (
        <>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              停留所の周り 2km に、調査の対象になる施設がありません。
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  選んだ対象{" "}
                  <strong className="tabular-nums">{selectedIds.length}</strong>{" "}
                  件
                  <span className="ml-1 text-xs text-muted-foreground">
                    (学校・病院など {pickedOthers} / {maxTargets}{" "}
                    件・周辺のバス事業者 {pickedOperators} 件。候補{" "}
                    {candidates.length} 件)
                  </span>
                </span>
                {!isDefault && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      useResearchStore.getState().setSelected(null)
                    }
                  >
                    既定の選び方に戻す
                  </Button>
                )}
                {selectedIds.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => useResearchStore.getState().setSelected([])}
                  >
                    すべて外す
                  </Button>
                )}
              </div>
              {isDefault && (
                <p className="text-xs text-muted-foreground">
                  既定では、重要拠点の優先順位の高い種類から1件ずつ順に、停留所から{" "}
                  {DEFAULT_SELECT_WALK_M.toLocaleString("ja-JP")}m
                  以内の施設を選んでいます(病院は病床の多い順、ほかは停留所に近い順)。ここまでで{" "}
                  {maxTargets}{" "}
                  件までです。周辺のバス事業者は件数に数えず、こちらの停留所の近くに停留所がある事業者をすべて選んでいます(読み込んだ
                  GTFS
                  の事業者を除く)。「近くに停留所なし」の事業者は「続きを表示」の後ろにまとめています。
                </p>
              )}
              {limitNote && (
                <p className="text-xs text-destructive" role="alert">
                  {limitNote}
                </p>
              )}
              {shownResults.length > 0 && (
                <ResearchSummary results={shownResults} />
              )}
              <CandidateList
                groups={groups}
                selected={selected}
                onToggle={onToggle}
                results={results}
                overlaps={overlaps}
                reduced={reduced}
              />
            </>
          )}

          <div className="flex flex-col gap-1.5 rounded-md border px-2 py-2">
            <p className="text-xs text-muted-foreground">
              {RESEARCH_SEND_NOTE}GTFS のファイルは送りません。
            </p>
            {cachedSelected > 0 && (
              <p className="text-xs text-muted-foreground">
                {RESEARCH_SAVED_NOTE}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                loading={starting}
                loadingLabel={RESEARCH_STARTING}
                disabled={
                  selectedIds.length === 0 || sending || progress.active
                }
                onClick={() => void onStart()}
              >
                {RESEARCH_START}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={demo.status === "loading"}
                loadingLabel={RESEARCH_DEMO_LOADING}
                disabled={candidates.length === 0}
                onClick={onDemo}
              >
                {RESEARCH_DEMO}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {RESEARCH_DEMO_NOTE}
            </p>
            {demo.status === "ready" && (
              <p className="text-xs" role="status">
                {demo.count > 0
                  ? `保存済みの結果(デモ)${demo.count} 件を出し、その対象を選びました。`
                  : RESEARCH_DEMO_NONE}
              </p>
            )}
            {demo.status === "error" && (
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
                {progress.active && (
                  <span className="block text-xs text-muted-foreground">
                    {RESEARCH_KEEP_OPEN}
                  </span>
                )}
              </p>
            )}
          </div>

          {inUse && (
            <p className="text-xs text-muted-foreground">
              施設の位置と名前:国土数値情報(バス停留所 P11・学校 P29・医療機関
              P04)を加工して作成。
            </p>
          )}
        </>
      )}
    </>
  );
}
