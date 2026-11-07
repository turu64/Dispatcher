import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { activeServiceIds } from '@/gtfs/calendar'
import { facilityAccess, type FacilityAccessEntry, type FacilityAccessStopInput, type FacilityAccessWindow } from '@/gtfs/edit/facilityAccess'
import type { HintFacility } from '@/gtfs/edit/restore'
import type { GtfsFeed } from '@/gtfs/load'
import { formatDateJa } from '@/lib/dates'
import { StatTiles } from './StatTiles'

/** 往復と学校・病院の確認で判定しないことの断り書き(画面と README の「できないこと」で同じ趣旨) */
export const CHECK_LIMITS_NOTE =
  '乗車人数・混み具合・鉄道との乗り継ぎの時刻は、データがないため判定していません。時間帯は始業・受付の時刻からの目安です。'

/** 最初に出す施設の数(候補の一覧が下に押し出されすぎないように少なくする) */
const FIRST_ROWS = 3

const SOURCE_LABELS: Record<FacilityAccessWindow['source'], string> = { research: '調べた結果', default: '既定' }

function sourceText(w: FacilityAccessWindow): string {
  return w.source === 'research' && w.basis ? `${SOURCE_LABELS.research}:${w.basis}` : SOURCE_LABELS[w.source]
}

function arrow(before: string | number | null, after: string | number | null): string {
  return `${before ?? '—'} → ${after ?? '—'}`
}

/** 施設の窓1つの行(着く・出る) */
function WindowLine({ w }: { w: FacilityAccessWindow }) {
  const arrive = w.timing === 'arrive'
  return (
    <span className="tabular-nums text-muted-foreground">
      {arrive ? '着く' : '出る'} {w.from}〜{w.to}({sourceText(w)}):{arrow(w.before.trips, w.after.trips)} 便・{arrive ? '最も遅く着く時刻' : '最も早く出る時刻'}{' '}
      {arrow(w.before.time, w.after.time)}
    </span>
  )
}

function FacilityRow({ entry }: { entry: FacilityAccessEntry }) {
  const nearest = entry.stops[0]
  return (
    <li className="flex flex-col gap-0.5 px-2 py-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium">{entry.name}</span>
        <span className="text-muted-foreground">{entry.categoryLabel}</span>
        {entry.problems.includes('arriveLost') && (
          <Badge variant="destructive" className="px-1 py-0 text-[10px]">
            着く便がなくなる
          </Badge>
        )}
        {entry.problems.includes('departLost') && (
          <Badge variant="destructive" className="px-1 py-0 text-[10px]">
            出る便がなくなる
          </Badge>
        )}
      </span>
      <WindowLine w={entry.arrive} />
      <WindowLine w={entry.depart} />
      {nearest && (
        <span className="text-muted-foreground">
          最寄りの停留所:{nearest.stopName}({nearest.distanceM}m)
        </span>
      )}
    </li>
  )
}

/**
 * 手順「平日便を戻す」の学校・病院に着く便の確認(指摘 18.3、docs/tasks-1105.md の A09)。比較する日付の、減便前(base)と
 * 今の減便後(edited。承認待ちの下書きがあれば下書きの結果)で、学校・病院ごとに、始業・受付の窓に着く便と帰りの窓に出る便を数える。
 * 数は gtfs/edit/facilityAccess.ts の facilityAccess が出す。出すのは、着く便か出る便が減便後に 0 便になる施設だけ
 * (重要拠点の優先順位、距離の順)
 */
export function FacilityAccessPanel({
  base,
  edited,
  weekdayServices,
  date,
  draftLabel,
  facilities,
  unavailable,
  stops,
}: {
  base: GtfsFeed
  edited: GtfsFeed
  /** 減便後の結果の平日の service(比較する日付に、このどれかが減便前に走らなければ確かめない) */
  weekdayServices: ReadonlySet<string>
  /** 比較する日付(地図の下の操作盤。到達圏の store の日付)。決まっていなければ null */
  date: string | null
  draftLabel: string | null
  /** 学校・病院(HintFacility)。読めていなければ null で、unavailable に理由 */
  facilities: readonly HintFacility[] | null
  unavailable: string | null
  /** 減便前の stops.txt の停留所(toStops(base).stops) */
  stops: readonly FacilityAccessStopInput[]
}) {
  const weekdayRuns = useMemo(() => {
    if (date === null) return false
    const active = activeServiceIds(base, date)
    return [...weekdayServices].some((s) => active.has(s))
  }, [base, date, weekdayServices])
  const result = useMemo(
    () => (date !== null && weekdayRuns && facilities ? facilityAccess(base, edited, date, facilities, stops) : null),
    [base, edited, date, weekdayRuns, facilities, stops],
  )
  const [showAll, setShowAll] = useState(false)

  let body
  if (date === null) {
    body = <p className="text-muted-foreground">学校・病院に着く便は、地図の下の操作盤で比較する日付を選ぶと確かめます。</p>
  } else if (!weekdayRuns) {
    body = (
      <p className="text-muted-foreground">
        比較する日付({formatDateJa(date)})は平日ダイヤの運行日ではないため、学校・病院に着く便は確かめていません。比較する日付を、地図の下の操作盤で平日にすると確かめます。
      </p>
    )
  } else if (!facilities || !result) {
    body = <p className="text-muted-foreground">{unavailable ?? '学校・病院の参照データを読み込むと確かめます。'}</p>
  } else if (result.reason !== null) {
    body = <p className="text-muted-foreground">{result.reason}</p>
  } else {
    const lost = result.facilities.filter((f) => f.problems.length > 0)
    const shown = showAll ? lost : lost.slice(0, FIRST_ROWS)
    const rest = lost.length - shown.length
    body = (
      <>
        {/* 読み上げは1文のまま、画面には数を小さな枠で出す */}
        <p className="sr-only">
          {formatDateJa(date)}の減便前と減便後{draftLabel ? `(${draftLabel})` : ''}で、徒歩圏に停留所がある学校・病院 {result.facilities.length}{' '}
          施設のうち、着く便がなくなる施設 {result.counts.arriveLost}・出る便がなくなる施設 {result.counts.departLost}。
        </p>
        <p aria-hidden="true">
          {formatDateJa(date)}の減便前と減便後{draftLabel ? `(${draftLabel})` : ''}を比べました。
        </p>
        <StatTiles
          hidden
          tiles={[
            { label: '徒歩圏の学校・病院', value: result.facilities.length },
            { label: '着く便がなくなる', value: result.counts.arriveLost, tone: result.counts.arriveLost > 0 ? 'warn' : undefined },
            { label: '出る便がなくなる', value: result.counts.departLost, tone: result.counts.departLost > 0 ? 'warn' : undefined },
          ]}
        />
        {lost.length === 0 ? (
          <p className="text-muted-foreground">着く便・出る便が 0 便になる学校・病院はありません。</p>
        ) : (
          <ul className="flex flex-col divide-y border-y" aria-label="着く便・出る便がなくなる学校・病院">
            {shown.map((f) => (
              <FacilityRow key={f.targetId} entry={f} />
            ))}
          </ul>
        )}
        {rest > 0 && (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setShowAll(true)}>
            さらに表示(残り {rest} 件)
          </Button>
        )}
        {result.withoutStops.length > 0 && (
          <p className="text-muted-foreground">徒歩圏に、この日に乗り降りする停留所がない学校・病院:{result.withoutStops.length} 施設</p>
        )}
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">数え方</summary>
          <p className="mt-1">{result.note}</p>
          <p className="mt-1">{CHECK_LIMITS_NOTE}</p>
        </details>
      </>
    )
  }

  return (
    <section className="flex flex-col gap-1.5 text-xs" aria-label="学校・病院に着く便の確認">
      <h3 className="text-sm font-medium">学校・病院に着く便の確認</h3>
      {body}
    </section>
  )
}
