import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { GtfsFeed } from '@/gtfs/load'
import {
  ROUND_TRIP_PROBLEM_KINDS,
  ROUND_TRIP_PROBLEM_LABELS,
  roundTripCheck,
  type RoundTripDirection,
  type RoundTripProblem,
  type RoundTripProblemKind,
  type RoundTripWindow,
} from '@/gtfs/edit/roundTrip'
import { formatDateJa } from '@/lib/dates'
import { StatTiles } from './StatTiles'

/** 最初に出す、問題のある方向の行の数(候補の一覧が下に押し出されすぎないように少なくする) */
const FIRST_ROWS = 3

/** 分を「6」「8:30」の形にする(窓の表示用) */
function clockOfMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? String(h) : `${h}:${String(m).padStart(2, '0')}`
}

/** 窓を「6〜9時」の形にする */
function windowText(w: RoundTripWindow): string {
  return `${clockOfMinutes(w.startMin)}〜${clockOfMinutes(w.endMin)}時`
}

/** 方向の行:方向と、その方向の問題(種類の順) */
interface Row {
  key: string
  dir: RoundTripDirection
  problems: RoundTripProblem[]
}

function keyOf(routeId: string, fromName: string, toName: string): string {
  return `${routeId}\u0000${fromName}\u0000${toName}`
}

const KIND_ORDER = new Map(ROUND_TRIP_PROBLEM_KINDS.map((k, i) => [k, i]))

/** 方向の行を作る。問題のある方向を、最も重い問題の種類の順(同じなら roundTripCheck の方向の順)に先に並べる */
function rowsOf(directions: readonly RoundTripDirection[], problems: readonly RoundTripProblem[]): { withProblems: Row[]; others: Row[] } {
  const byKey = new Map<string, RoundTripProblem[]>()
  for (const p of problems) {
    const k = keyOf(p.routeId, p.fromName, p.toName)
    const list = byKey.get(k)
    if (list) list.push(p)
    else byKey.set(k, [p])
  }
  const rows = directions.map((dir, index) => {
    const key = keyOf(dir.routeId, dir.fromName, dir.toName)
    const list = (byKey.get(key) ?? []).slice().sort((a, b) => KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!)
    return { key, dir, problems: list, index }
  })
  const rank = (r: (typeof rows)[number]) => KIND_ORDER.get(r.problems[0].kind)!
  const withProblems = rows.filter((r) => r.problems.length > 0).sort((a, b) => rank(a) - rank(b) || a.index - b.index)
  const others = rows.filter((r) => r.problems.length === 0)
  return { withProblems, others }
}

/** 問題の札の文 */
function problemLabel(p: RoundTripProblem): string {
  if ((p.kind === 'lastEarlier' || p.kind === 'firstLater') && p.shiftMin !== null) {
    return p.kind === 'lastEarlier' ? `終発が ${p.shiftMin} 分早まる` : `始発が ${p.shiftMin} 分遅くなる`
  }
  return ROUND_TRIP_PROBLEM_LABELS[p.kind]
}

const BADGE_VARIANT: Record<RoundTripProblemKind, 'destructive' | 'secondary'> = {
  directionVanishes: 'destructive',
  noReturn: 'destructive',
  lastEarlier: 'secondary',
  firstLater: 'secondary',
}

function arrow(before: string | number | null, after: string | number | null): string {
  return `${before ?? '—'} → ${after ?? '—'}`
}

/**
 * 手順「平日便を戻す」の往復の確認(指摘 18.2、docs/tasks-1105.md の A09)。比較する日付の、減便前(base)と
 * 今の減便後(edited。承認待ちの下書きがあれば下書きの結果)を、系統の方向(始発 → 終着)ごとに比べる。
 * 数は gtfs/edit/roundTrip.ts の roundTripCheck が出す。行は、方向の便がなくなる、帰りの便がない、終発が早まる、
 * 始発が遅くなるの順に並べ、行から、その系統の平日に戻す候補のまとまりを開ける
 */
export function RoundTripPanel({
  base,
  edited,
  weekdayServices,
  date,
  draftLabel,
  openable,
  onOpenRoute,
}: {
  base: GtfsFeed
  edited: GtfsFeed
  /** 減便後の結果の平日の service(form2.ts の activeWeekdayServicesOf) */
  weekdayServices: ReadonlySet<string>
  /** 比較する日付(地図の下の操作盤。到達圏の store の日付)。決まっていなければ null */
  date: string | null
  /** 比べる減便後が承認待ちの下書きのとき、その名前(「下書き #1」)。承認済みの版なら null */
  draftLabel: string | null
  /** 平日に戻す候補がある系統(この系統の行にだけ「候補を開く」を出す) */
  openable: ReadonlySet<string>
  onOpenRoute: (routeId: string) => void
}) {
  const result = useMemo(
    () => (date === null ? null : roundTripCheck(base, edited, date, { weekdayServices })),
    [base, edited, date, weekdayServices],
  )
  const rows = useMemo(() => (result ? rowsOf(result.directions, result.problems) : null), [result])
  const routeNames = useMemo(() => new Map((result?.directions ?? []).map((d) => [d.routeId, d.routeName])), [result])
  const [showAllProblems, setShowAllProblems] = useState(false)
  const [showOthers, setShowOthers] = useState(false)

  let body
  if (date === null || result === null || rows === null) {
    body = <p className="text-muted-foreground">往復は、地図の下の操作盤で比較する日付を選ぶと確かめます。</p>
  } else if (result.emptyReason?.code === 'noWeekdayService') {
    body = (
      <p className="text-muted-foreground">
        比較する日付({formatDateJa(date)})は平日ダイヤの運行日ではないため、往復は確かめていません。比較する日付を、地図の下の操作盤で平日にすると確かめます。
      </p>
    )
  } else if (result.emptyReason) {
    body = <p className="text-muted-foreground">{result.emptyReason.message}</p>
  } else {
    const { morning, evening, shiftMin } = result.windows
    const shown = showAllProblems ? rows.withProblems : rows.withProblems.slice(0, FIRST_ROWS)
    const rest = rows.withProblems.length - shown.length
    body = (
      <>
        <p>
          {formatDateJa(date)}の減便前と減便後{draftLabel ? `(${draftLabel})` : ''}を、系統の方向(始発 → 終着)ごとに比べました。
        </p>
        {/* 数は小さな枠で出し、読み上げは1文にする */}
        <p className="sr-only" aria-label="往復の問題の数">
          {ROUND_TRIP_PROBLEM_KINDS.map((k) => `${ROUND_TRIP_PROBLEM_LABELS[k]} ${result.counts[k]}`).join('・')}
        </p>
        <StatTiles
          hidden
          className="grid-cols-2"
          tiles={ROUND_TRIP_PROBLEM_KINDS.map((k) => ({
            label: ROUND_TRIP_PROBLEM_LABELS[k],
            value: result.counts[k],
            tone: BADGE_VARIANT[k] === 'destructive' && result.counts[k] > 0 ? ('warn' as const) : undefined,
          }))}
        />
        <p className="text-muted-foreground">
          循環・片道のため往復を確かめていない系統:{result.routes.noReverse}
          {result.routes.afterOnly > 0 && `。減便後にだけ便がある系統:${result.routes.afterOnly}`}
        </p>
        {rows.withProblems.length === 0 ? (
          <p className="text-muted-foreground">問題のある方向はありません。</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border" aria-label="問題のある方向">
            {shown.map((row) => (
              <DirectionRow key={row.key} row={row} evening={evening} openable={openable} routeNames={routeNames} onOpenRoute={onOpenRoute} />
            ))}
          </ul>
        )}
        {rest > 0 && (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setShowAllProblems(true)}>
            さらに表示(残り {rest} 件)
          </Button>
        )}
        {rows.others.length > 0 &&
          (showOthers ? (
            <ul className="flex flex-col divide-y rounded-md border" aria-label="問題のない方向">
              {rows.others.map((row) => (
                <DirectionRow key={row.key} row={row} evening={evening} openable={openable} routeNames={routeNames} onOpenRoute={onOpenRoute} />
              ))}
            </ul>
          ) : (
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setShowOthers(true)}>
              問題のない方向も見る({rows.others.length} 方向)
            </Button>
          ))}
        <details>
          <summary className="cursor-pointer text-muted-foreground">判定のしかた</summary>
          <p className="mt-1 text-muted-foreground">
            「帰りの便がない」は、減便後に行きの方向に{windowText(morning)}の便があり、逆向きの{windowText(evening)}の便が 0 便になる方向です(減便前は 1 便以上)。始発・終発は、{shiftMin} 分以上ずれたものを出します。方向は始発と終着の停留所名の組で分け、逆向きは同じ系統、なければほかの系統から探します。
          </p>
        </details>
      </>
    )
  }

  return (
    <section className="flex flex-col gap-1.5 text-xs" aria-label="往復の確認">
      <h3 className="text-sm font-medium">往復の確認</h3>
      {body}
    </section>
  )
}

function DirectionRow({
  row,
  evening,
  openable,
  routeNames,
  onOpenRoute,
}: {
  row: Row
  evening: RoundTripWindow
  openable: ReadonlySet<string>
  routeNames: ReadonlyMap<string, string>
  onOpenRoute: (routeId: string) => void
}) {
  const { dir, problems } = row
  const name = `${dir.fromName} → ${dir.toName}`
  const noReturn = problems.find((p) => p.kind === 'noReturn')
  // 帰りの便がないだけの方向は、戻す便が逆向き(帰り)の系統にあるので、その系統を開く(ほかの系統にだけ逆向きがあるとき)
  const target =
    (noReturn && problems.length === 1 ? noReturn.returnTrips?.routeIds.find((r) => openable.has(r)) : undefined) ??
    (openable.has(dir.routeId) ? dir.routeId : undefined)
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 px-2 py-1">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">{dir.routeName}</span>
          <span>{name}</span>
          {problems.map((p) => (
            <Badge key={p.kind} variant={BADGE_VARIANT[p.kind]} className="px-1 py-0 text-[10px]">
              {problemLabel(p)}
            </Badge>
          ))}
        </span>
        <span className="tabular-nums text-muted-foreground">
          便数 {arrow(dir.before.trips, dir.after.trips)} 便・始発 {arrow(dir.before.first, dir.after.first)}・終発 {arrow(dir.before.last, dir.after.last)}
        </span>
        {noReturn?.returnTrips && (
          <span className="tabular-nums text-muted-foreground">
            帰り({dir.toName} → {dir.fromName})の{windowText(evening)}の便:{arrow(noReturn.returnTrips.eveningBefore, noReturn.returnTrips.eveningAfter)} 便
          </span>
        )}
      </span>
      {target !== undefined && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={() => onOpenRoute(target)}
          aria-label={`系統 ${routeNames.get(target) ?? target} の平日に戻す候補を開く(${name})`}
        >
          候補を開く
        </Button>
      )}
    </li>
  )
}
