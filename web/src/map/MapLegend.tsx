import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatCount } from '@/reach/summary'
import {
  REACH_COLORS,
  REACH_DIFF_COLORS,
  REACH_DIFF_OPACITY,
  REACH_FILL_OPACITY,
  REACH_FILL_OPACITY_REACHABLE,
  STOP_COLORS,
  ZERO_STOP_COLORS,
} from './colors'
import { MODE_LABELS, type DiffCounts } from './compareData'
import type { CellPaintMode } from './layers'

/** 減便の前後を比べているときの凡例の材料 */
export interface LegendCompare {
  mode: CellPaintMode
  onModeChange: (mode: CellPaintMode) => void
  /** 選んだ時間帯の4つのセルの数(計算が無ければ null) */
  counts: DiffCounts | null
  /** 減便後が下書き(承認前) */
  draft: boolean
  /** 運行がゼロになる停留所の数('feed' は出力のどの日にも便が来ない) */
  zeroStops: { feed: number; day: number }
}

/**
 * 地図の凡例。色だけに頼らないよう、記号の形(塗りつぶし・白抜き・四角・×)と文字、件数を並べる。
 * caption には、地図に出している日付と時間帯を入れる。
 * nonCoverableCells は、ダイヤと関係なく外れるので塗っていないセルの数(docs/interfaces-1103.md の追記2)。
 * 参照データが無い(fallback)ときは null を渡し、その行を出さない(調べるセルがすべて見込みのあるセルになるため)。
 * compare があれば、塗り分け(減便前・減便後・前後の差)の切り替えと、前後の差の4つの件数を出す(docs/interfaces-1104.md §7)。
 */
export default function MapLegend({
  caption,
  computing,
  showStations,
  nonCoverableCells,
  compare,
}: {
  caption: string
  computing: boolean
  showStations: boolean
  nonCoverableCells: number | null
  compare?: LegendCompare
}) {
  const diff = compare?.mode === 'diff'
  const zeroTotal = compare ? compare.zeroStops.feed + compare.zeroStops.day : 0
  return (
    <section
      aria-label="凡例"
      className="pointer-events-none absolute top-3 left-3 flex max-w-72 flex-col gap-1.5 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10"
    >
      <p className="font-medium">
        {caption}
        {compare?.draft && <span className="ml-1 rounded border border-dashed px-1 font-normal">下書き</span>}
      </p>
      {compare && (
        <div className="pointer-events-auto flex flex-col gap-1">
          <span id="legend-mode-label" className="sr-only">
            地図の塗り分け
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-labelledby="legend-mode-label"
            value={compare.mode}
            onValueChange={(v) => {
              if (v === 'before' || v === 'after' || v === 'diff') compare.onModeChange(v)
            }}
          >
            {(['before', 'after', 'diff'] as const).map((m) => (
              <ToggleGroupItem key={m} value={m} className={`h-7 px-2 text-xs ${SELECTED_TOGGLE_CLASS}`}>
                {MODE_LABELS[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}
      {computing && <p className="text-muted-foreground">計算中…</p>}
      <ul className="flex flex-col gap-1">
        {diff ? (
          <>
            <DiffRow kind="lost" label="減便で到達圏から外れた" count={compare?.counts?.lost} />
            <DiffRow kind="bothUnreachable" label="前後とも到達圏外" count={compare?.counts?.bothUnreachable} />
            <DiffRow kind="gained" label="新たに到達" count={compare?.counts?.gained} />
            <DiffRow kind="bothReachable" label="両方で到達" count={compare?.counts?.bothReachable} />
          </>
        ) : (
          <>
            <li className="flex items-center gap-2">
              <Swatch color={REACH_COLORS.reachable} opacity={REACH_FILL_OPACITY_REACHABLE} />
              到達圏内
            </li>
            <li className="flex items-center gap-2">
              <Swatch color={REACH_COLORS.unreachable} opacity={REACH_FILL_OPACITY} />
              到達圏から外れる
            </li>
          </>
        )}
        {nonCoverableCells !== null && (
          <li className="flex items-start gap-2" data-non-coverable="true">
            <EmptySwatch />
            <span>
              塗らない区画:徒歩圏に停留所・駅がない <span className="tabular-nums">{formatCount(nonCoverableCells)}</span>{' '}
              区画(ダイヤにかかわらず到達できない)
            </span>
          </li>
        )}
        <li className="flex items-center gap-2">
          <Dot fill={STOP_COLORS.active} />
          停留所(この時間帯に発車あり)
        </li>
        <li className="flex items-center gap-2">
          <Dot fill={STOP_COLORS.inactive} />
          停留所(発車なし)
        </li>
        {diff && zeroTotal > 0 && (
          <li className="flex items-start gap-2" data-zero-stops="true">
            <ZeroMark />
            <span>
              発車がなくなる停留所 <span className="tabular-nums">{formatCount(zeroTotal)}</span> 件(出力のどの日にも便が来ない{' '}
              <span className="tabular-nums">{formatCount(compare!.zeroStops.feed)}</span> 件)
            </span>
          </li>
        )}
        {showStations && (
          <li className="flex items-center gap-2">
            <StationMark />
            鉄道駅(すべての時間帯で使えるとみなす)
          </li>
        )}
      </ul>
    </section>
  )
}

function DiffRow({ kind, label, count }: { kind: keyof typeof REACH_DIFF_COLORS; label: string; count: number | undefined }) {
  return (
    <li className="flex items-center gap-2" data-diff={kind}>
      <Swatch color={REACH_DIFF_COLORS[kind]} opacity={REACH_DIFF_OPACITY[kind]} />
      <span>
        {label}
        {count !== undefined && (
          <>
            {' '}
            <span className="tabular-nums">{formatCount(count)}</span> 区画
          </>
        )}
      </span>
    </li>
  )
}

function Swatch({ color, opacity }: { color: string; opacity: number }) {
  return (
    <span aria-hidden="true" className="relative inline-block size-3.5 shrink-0 rounded-sm ring-1 ring-foreground/20">
      <span className="absolute inset-0 rounded-sm" style={{ backgroundColor: color, opacity }} />
    </span>
  )
}

/** 塗らないセルの記号(点線の枠だけ) */
function EmptySwatch() {
  return <span aria-hidden="true" className="mt-0.5 inline-block size-3.5 shrink-0 rounded-sm border border-dashed border-foreground/50" />
}

function Dot({ fill }: { fill: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: fill, border: `1px solid ${STOP_COLORS.stroke}` }}
    />
  )
}

/** 運行がゼロになる停留所の印(×) */
function ZeroMark() {
  return (
    <span aria-hidden="true" className="mt-0.5 inline-block size-3.5 shrink-0 text-center leading-3.5 font-bold" style={{ color: ZERO_STOP_COLORS.mark }}>
      ×
    </span>
  )
}

function StationMark() {
  return (
    <span
      aria-hidden="true"
      className="relative inline-block size-3 shrink-0"
      style={{ backgroundColor: STOP_COLORS.halo, border: `2px solid ${STOP_COLORS.stroke}` }}
    >
      <span className="absolute inset-[2px]" style={{ backgroundColor: STOP_COLORS.stroke }} />
    </span>
  )
}
