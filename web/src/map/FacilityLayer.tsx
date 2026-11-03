import type { MapLayerMouseEvent } from 'maplibre-gl'
import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FACILITY_KIND_LABELS, type FacilityKind, type ResearchCandidate } from '@/ref/facilities'
import { useMapStore } from '@/store/map'
import { useResearchView } from '@/store/research'
import { useStepStore } from '@/store/steps'
import { addFacilityImages, addFacilityLayers, FACILITIES_LAYER, FACILITIES_SOURCE, facilitiesToGeoJson, removeFacilityLayers } from './facilityLayers'
import {
  FACILITY_SYMBOL_KINDS,
  FACILITY_SYMBOL_LABELS,
  facilitySymbolKind,
  facilitySymbolParts,
  type FacilitySymbolKind,
} from './facilitySymbols'
import ReachLayers from './ReachLayers'

/**
 * 前提情報の手順の地図:停留所の外接矩形 +2km にある施設・事業者(調査の対象の候補)を、種類ごとの記号で出す
 * (レイヤーと記号の画素は facilityLayers.ts)。押すと名前を出す
 */

/**
 * 凡例・一覧の記号(SVG。地図の記号と同じ形と色)。
 * 施設の種類(kind)と学校の種別(schoolType)から記号を決める。symbol を渡せば、それを使う
 */
export function FacilitySymbol({
  kind,
  schoolType,
  symbol,
  className,
}: {
  kind: FacilityKind
  schoolType?: string
  symbol?: FacilitySymbolKind
  className?: string
}) {
  const parts = facilitySymbolParts(symbol ?? facilitySymbolKind(kind, schoolType))
  return (
    <svg viewBox="0 0 24 24" className={className ?? 'size-4 shrink-0'} aria-hidden="true">
      {parts.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  )
}

/**
 * 施設の凡例(種類ごとの数と、選んだ対象の数)。置き場所は FacilityLayer の右の列(拡大・縮小のボタンの下)。
 * 下の端には時間帯の切り替え(BandControl。下の中央)があり、地図が狭いと重なるので、下には置かない
 */
export function FacilityLegend({ candidates, selected }: { candidates: readonly ResearchCandidate[]; selected: ReadonlySet<string> }) {
  const counts = new Map<FacilitySymbolKind, number>()
  for (const c of candidates) {
    const symbol = facilitySymbolKind(c.facility.kind, c.facility.schoolType)
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1)
  }
  return (
    <div
      className="pointer-events-none flex max-w-60 flex-col gap-1 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10"
      role="group"
      aria-label="施設の凡例"
    >
      <span className="font-medium">調査の対象の候補(停留所の周り 2km)</span>
      {FACILITY_SYMBOL_KINDS.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <FacilitySymbol kind="school" symbol={k} />
          {FACILITY_SYMBOL_LABELS[k]} {counts.get(k)} 件
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
  const [picked, setPicked] = useState<{ name: string; kind: FacilityKind | null; symbol: FacilitySymbolKind | null } | null>(null)
  // レイヤーは、前提情報の手順を初めて開いたときに足す(開かない人の地図に記号の画像を足さない)。足した後は隠すだけ
  const [used, setUsed] = useState(visible)
  // 記号の画像とレイヤーを足し終えた回数(足し終えたら、点と表示の状態を渡し直す)
  const [ready, setReady] = useState(0)
  if (visible && !used) setUsed(true)

  useEffect(() => {
    if (!map || !used) return
    // 記号の画像は非同期に作る。足し終えてからレイヤーと操作を足す(途中で外れたら足さない)
    const abort = new AbortController()
    // 記号を押したら名前を出す
    const onClick = (e: MapLayerMouseEvent) => {
      const props = e.features?.[0]?.properties as { name?: unknown; kind?: unknown; symbol?: unknown } | undefined
      if (typeof props?.name !== 'string') return
      const kind = typeof props.kind === 'string' && props.kind in FACILITY_KIND_LABELS ? (props.kind as FacilityKind) : null
      const symbol = typeof props.symbol === 'string' && (FACILITY_SYMBOL_KINDS as readonly string[]).includes(props.symbol) ? (props.symbol as FacilitySymbolKind) : null
      setPicked({ name: props.name, kind, symbol })
    }
    const onEnter = () => {
      map.getCanvas().style.cursor = 'pointer'
    }
    const onLeave = () => {
      map.getCanvas().style.cursor = ''
    }
    let registered = false
    addFacilityImages(map, abort.signal)
      .then(() => {
        if (abort.signal.aborted) return
        addFacilityLayers(map)
        map.on('click', FACILITIES_LAYER, onClick)
        map.on('mouseenter', FACILITIES_LAYER, onEnter)
        map.on('mouseleave', FACILITIES_LAYER, onLeave)
        registered = true
        // 足したばかりのレイヤーに、今の点と表示の状態を渡す(待っている間に変わっていたため)
        setReady((n) => n + 1)
      })
      .catch(() => {
        // 画像を作れなかったときは、記号を出さない(画面の他の機能は動かす)
      })
    return () => {
      abort.abort()
      if (registered) {
        map.off('click', FACILITIES_LAYER, onClick)
        map.off('mouseenter', FACILITIES_LAYER, onEnter)
        map.off('mouseleave', FACILITIES_LAYER, onLeave)
      }
      removeFacilityLayers(map)
    }
  }, [map, used])

  useEffect(() => {
    if (!map || !used) return
    const source = map.getSource(FACILITIES_SOURCE) as { setData?: (d: unknown) => void } | undefined
    source?.setData?.(features)
  }, [map, used, features, ready])

  useEffect(() => {
    if (used && map?.getLayer(FACILITIES_LAYER)) map.setLayoutProperty(FACILITIES_LAYER, 'visibility', visible ? 'visible' : 'none')
  }, [map, used, visible, ready])

  if (!visible || candidates.length === 0) return null
  // 凡例と押した記号の名前は、右上の拡大・縮小のボタンの下に縦に積む(互いに重ならず、下の中央の時間帯の切り替えとも重ならない)
  return (
    <div className="pointer-events-none absolute top-24 right-3 flex flex-col items-end gap-2" data-testid="facility-overlay">
      <FacilityLegend candidates={candidates} selected={selected} />
      {picked && (
        <div className="pointer-events-auto flex max-w-60 items-start gap-1.5 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10" role="status">
          {picked.kind && <FacilitySymbol kind={picked.kind} symbol={picked.symbol ?? undefined} className="mt-0.5 size-4 shrink-0" />}
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
