import type { MapLayerMouseEvent } from 'maplibre-gl'
import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FACILITY_KIND_LABELS, type FacilityKind, type ResearchCandidate } from '@/ref/facilities'
import { useMapStore } from '@/store/map'
import { useResearchView } from '@/store/research'
import { useStepStore } from '@/store/steps'
import {
  addFacilityLayers,
  FACILITIES_LAYER,
  FACILITIES_SOURCE,
  FACILITY_COLORS,
  FACILITY_KINDS,
  FACILITY_SHAPES,
  facilitiesToGeoJson,
  removeFacilityLayers,
} from './facilityLayers'
import ReachLayers from './ReachLayers'

/**
 * 前提情報の手順の地図:停留所の外接矩形 +2km にある施設・事業者(調査の対象の候補)を、種類ごとの記号で出す
 * (レイヤーと記号の画素は facilityLayers.ts)。押すと名前を出す
 */

/** 地図の凡例の記号(SVG。地図の記号と同じ形と色) */
export function FacilitySymbol({ kind, className }: { kind: FacilityKind; className?: string }) {
  const color = FACILITY_COLORS[kind]
  const shape = FACILITY_SHAPES[kind]
  const crossPath = 'M8 4.5v7M4.5 8h7'
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-3.5 shrink-0'} aria-hidden="true">
      {shape === 'square-cross' && <rect x="1.5" y="1.5" width="13" height="13" fill={color} stroke="#1a1a1a" strokeWidth="1.2" />}
      {shape === 'circle-cross' && <circle cx="8" cy="8" r="6.5" fill={color} stroke="#1a1a1a" strokeWidth="1.2" />}
      {shape === 'triangle' && <path d="M8 1.5 14.5 13.5h-13z" fill={color} stroke="#1a1a1a" strokeWidth="1.2" strokeLinejoin="round" />}
      {shape === 'diamond' && <path d="M8 1 15 8 8 15 1 8z" fill={color} stroke="#1a1a1a" strokeWidth="1.2" strokeLinejoin="round" />}
      {(shape === 'square-cross' || shape === 'circle-cross') && <path d={crossPath} stroke="#fff" strokeWidth="2" />}
    </svg>
  )
}

/**
 * 施設の凡例(種類ごとの数と、選んだ対象の数)。置き場所は FacilityLayer の右の列(拡大・縮小のボタンの下)。
 * 下の端には時間帯の切り替え(BandControl。下の中央)があり、地図が狭いと重なるので、下には置かない
 */
export function FacilityLegend({ candidates, selected }: { candidates: readonly ResearchCandidate[]; selected: ReadonlySet<string> }) {
  const counts = new Map<FacilityKind, number>()
  for (const c of candidates) counts.set(c.facility.kind, (counts.get(c.facility.kind) ?? 0) + 1)
  return (
    <div
      className="pointer-events-none flex max-w-60 flex-col gap-1 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10"
      role="group"
      aria-label="施設の凡例"
    >
      <span className="font-medium">調査の対象の候補(停留所の周り 2km)</span>
      {FACILITY_KINDS.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <FacilitySymbol kind={k} />
          {FACILITY_KIND_LABELS[k]} {counts.get(k)} 件
        </span>
      ))}
      <span className="text-muted-foreground">濃い記号は選んだ対象({selected.size} 件)</span>
    </div>
  )
}

/**
 * 施設の記号を地図に重ねる。visible が false なら、レイヤーを残したまま隠す(手順を戻ったときに作り直さないため)
 */
export function FacilityLayer({ visible }: { visible: boolean }) {
  const map = useMapStore((s) => s.map)
  const { candidates, selectedIds } = useResearchView()
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const features = useMemo(() => facilitiesToGeoJson(candidates, selected), [candidates, selected])
  // 押した記号の名前(地図の右上に出す)
  const [picked, setPicked] = useState<{ name: string; kind: FacilityKind | null } | null>(null)
  // レイヤーは、前提情報の手順を初めて開いたときに足す(開かない人の地図に記号の画像を足さない)。足した後は隠すだけ
  const [used, setUsed] = useState(visible)
  if (visible && !used) setUsed(true)

  useEffect(() => {
    if (!map || !used) return
    addFacilityLayers(map)
    // 記号を押したら名前を出す
    const onClick = (e: MapLayerMouseEvent) => {
      const props = e.features?.[0]?.properties as { name?: unknown; kind?: unknown } | undefined
      if (typeof props?.name !== 'string') return
      const kind = typeof props.kind === 'string' && props.kind in FACILITY_KIND_LABELS ? (props.kind as FacilityKind) : null
      setPicked({ name: props.name, kind })
    }
    const onEnter = () => {
      map.getCanvas().style.cursor = 'pointer'
    }
    const onLeave = () => {
      map.getCanvas().style.cursor = ''
    }
    map.on('click', FACILITIES_LAYER, onClick)
    map.on('mouseenter', FACILITIES_LAYER, onEnter)
    map.on('mouseleave', FACILITIES_LAYER, onLeave)
    return () => {
      map.off('click', FACILITIES_LAYER, onClick)
      map.off('mouseenter', FACILITIES_LAYER, onEnter)
      map.off('mouseleave', FACILITIES_LAYER, onLeave)
      removeFacilityLayers(map)
    }
  }, [map, used])

  useEffect(() => {
    if (!map || !used) return
    const source = map.getSource(FACILITIES_SOURCE) as { setData?: (d: unknown) => void } | undefined
    source?.setData?.(features)
  }, [map, used, features])

  useEffect(() => {
    if (used && map?.getLayer(FACILITIES_LAYER)) map.setLayoutProperty(FACILITIES_LAYER, 'visibility', visible ? 'visible' : 'none')
  }, [map, used, visible])

  if (!visible || candidates.length === 0) return null
  // 凡例と押した記号の名前は、右上の拡大・縮小のボタンの下に縦に積む(互いに重ならず、下の中央の時間帯の切り替えとも重ならない)
  return (
    <div className="pointer-events-none absolute top-24 right-3 flex flex-col items-end gap-2" data-testid="facility-overlay">
      <FacilityLegend candidates={candidates} selected={selected} />
      {picked && (
        <div className="pointer-events-auto flex max-w-60 items-start gap-1.5 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10" role="status">
          {picked.kind && <FacilitySymbol kind={picked.kind} className="mt-0.5 size-3.5 shrink-0" />}
          <span className="min-w-0 flex-1">
            {picked.name}
            {picked.kind && <span className="ml-1 text-muted-foreground">{FACILITY_KIND_LABELS[picked.kind]}</span>}
          </span>
          <button type="button" aria-label="閉じる" className="shrink-0 hover:text-foreground/70" onClick={() => setPicked(null)}>
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 地図を出す手順に共通の重ね:到達圏(ReachLayers)と、前提情報の手順でだけ見せる施設(FacilityLayer)。
 * 手順の一覧(registry.ts)で、地図を出す手順すべてにこの同じ部品を渡す。部品が同じなので、手順を移っても
 * 到達圏の重ねを作り直さない(地図の位置合わせをやり直さない)
 */
export default function MapOverlays() {
  const current = useStepStore((s) => s.current)
  return (
    <>
      <ReachLayers />
      <FacilityLayer visible={current === 'research'} />
    </>
  )
}
