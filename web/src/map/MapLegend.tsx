import { REACH_COLORS, REACH_FILL_OPACITY, REACH_FILL_OPACITY_REACHABLE, STOP_COLORS } from './colors'

/**
 * 地図の凡例。色だけに頼らないよう、記号の形(塗りつぶし・白抜き・四角)と文字を並べる。
 * caption には、地図に出している日付と時間帯を入れる。
 */
export default function MapLegend({
  caption,
  computing,
  showStations,
}: {
  caption: string
  computing: boolean
  showStations: boolean
}) {
  return (
    <section
      aria-label="凡例"
      className="pointer-events-none absolute top-3 left-3 flex max-w-64 flex-col gap-1.5 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10"
    >
      <p className="font-medium">{caption}</p>
      {computing && <p className="text-muted-foreground">計算中…</p>}
      <ul className="flex flex-col gap-1">
        <li className="flex items-center gap-2">
          <Swatch color={REACH_COLORS.reachable} opacity={REACH_FILL_OPACITY_REACHABLE} />
          徒歩圏内
        </li>
        <li className="flex items-center gap-2">
          <Swatch color={REACH_COLORS.unreachable} opacity={REACH_FILL_OPACITY} />
          徒歩圏から外れる
        </li>
        <li className="flex items-center gap-2">
          <Dot fill={STOP_COLORS.active} />
          停留所(この時間帯に出発あり)
        </li>
        <li className="flex items-center gap-2">
          <Dot fill={STOP_COLORS.inactive} />
          停留所(出発なし)
        </li>
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

function Swatch({ color, opacity }: { color: string; opacity: number }) {
  return (
    <span aria-hidden="true" className="relative inline-block size-3.5 shrink-0 rounded-sm ring-1 ring-foreground/20">
      <span className="absolute inset-0 rounded-sm" style={{ backgroundColor: color, opacity }} />
    </span>
  )
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
