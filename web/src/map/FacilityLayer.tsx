import type { MapLayerMouseEvent } from 'maplibre-gl'
import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { OTHER_STOP_RADIUS_M } from '@/ref/busstops'
import { FACILITY_KIND_LABELS, type FacilityKind, type ResearchCandidate } from '@/ref/facilities'
import { useGtfsStore } from '@/store/gtfs'
import { useMapStore } from '@/store/map'
import { useDriversStore } from '@/store/drivers'
import { useResearchView } from '@/store/research'
import { useStepStore } from '@/store/steps'
import {
  addFacilityImages,
  addFacilityLayers,
  distinctOtherStops,
  FACILITIES_LAYER,
  FACILITIES_SOURCE,
  FACILITY_LAYER_IDS,
  facilitiesToGeoJson,
  removeFacilityLayers,
  setFacilityHighlight,
} from './facilityLayers'
import {
  FACILITY_SYMBOL_KINDS,
  FACILITY_SYMBOL_LABELS,
  facilitySymbolKind,
  facilitySymbolParts,
  type FacilitySymbolKind,
} from './facilitySymbols'
import PlacesLayer from './PlacesLayer'
import ReachLayers from './ReachLayers'

/**
 * 前提情報の手順の地図:停留所の外接矩形 +2km にある施設(調査の対象の候補)と、こちらの停留所から 300m 以内にある
 * ほかの事業者の停留所を、種類ごとの記号で出す(レイヤーと記号の画像は facilityLayers.ts)。押すと名前を出す。
 * 一覧で焦点の当たっている対象(store/map.ts の highlightedTargetId)には輪を付けて記号を大きくする。地図は動かさない
 */

/** 凡例の、ほかの事業者の停留所の行の名前と、その後ろに添える条件 */
export const OTHER_STOPS_LEGEND = 'ほかの事業者の停留所'
export const OTHER_STOPS_LEGEND_NOTE = `(こちらの停留所から ${OTHER_STOP_RADIUS_M}m 以内・独自の記号)`


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
export function FacilityLegend({
  candidates,
  selected,
  otherStops = 0,
}: {
  candidates: readonly ResearchCandidate[]
  selected: ReadonlySet<string>
  /** 地図に出す、ほかの事業者の停留所の数 */
  otherStops?: number
}) {
  // 事業者は点にしない(重なる停留所を出す)ので、施設の種類ごとに数え、停留所の行は別に出す
  const counts = new Map<FacilitySymbolKind, number>()
  for (const c of candidates) {
    if (c.facility.kind === 'operator') continue
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
      {otherStops > 0 && (
        <span className="flex items-start gap-1.5" data-testid="legend-other-stops">
          <FacilitySymbol kind="operator" symbol="busstop" className="mt-0.5 size-4 shrink-0" />
          <span>
            {OTHER_STOPS_LEGEND} {otherStops} か所
            <span className="ml-1 text-muted-foreground">{OTHER_STOPS_LEGEND_NOTE}</span>
          </span>
        </span>
      )}
      <span className="text-muted-foreground">濃い記号は選んだ対象({selected.size} 件)</span>
    </div>
  )
}

/**
 * 施設の記号を地図に重ねる。visible が false なら、レイヤーを残したまま隠す(手順を戻ったときに作り直さないため)
 */
export function FacilityLayer({ visible }: { visible: boolean }) {
  const map = useMapStore((s) => s.map)
  const highlighted = useMapStore((s) => s.highlightedTargetId)
  const { candidates, selectedIds, overlaps } = useResearchView()
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const features = useMemo(() => facilitiesToGeoJson(candidates, selected, overlaps?.values() ?? []), [candidates, selected, overlaps])
  const otherStops = useMemo(() => (overlaps ? distinctOtherStops(overlaps.values()) : 0), [overlaps])
  // 押した記号の名前(地図の右上に出す)
  const [picked, setPicked] = useState<{ name: string; detail: string; kind: FacilityKind | null; symbol: FacilitySymbolKind | null } | null>(null)
  // GTFS を削除・読み込み直したら、押した記号の名前を消す(この部品は手順を移っても外れないので、前の GTFS の施設名が残るため)
  const feed = useGtfsStore((s) => s.feed)
  const [pickedFeed, setPickedFeed] = useState(feed)
  if (feed !== pickedFeed) {
    setPickedFeed(feed)
    setPicked(null)
  }
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
      // 営業所などを地図で置いている途中(map/PlacesLayer.tsx)は、施設の名前を出さない(その位置に場所を足すだけにする)
      if (useDriversStore.getState().placing) return
      const props = e.features?.[0]?.properties as { name?: unknown; detail?: unknown; kind?: unknown; symbol?: unknown } | undefined
      if (typeof props?.name !== 'string') return
      const kind = typeof props.kind === 'string' && props.kind in FACILITY_KIND_LABELS ? (props.kind as FacilityKind) : null
      const symbol = typeof props.symbol === 'string' && (FACILITY_SYMBOL_KINDS as readonly string[]).includes(props.symbol) ? (props.symbol as FacilitySymbolKind) : null
      setPicked({ name: props.name, detail: typeof props.detail === 'string' ? props.detail : '', kind, symbol })
    }
    // 置いている途中は十字の印のままにする
    const onEnter = () => {
      if (!useDriversStore.getState().placing) map.getCanvas().style.cursor = 'pointer'
    }
    const onLeave = () => {
      if (!useDriversStore.getState().placing) map.getCanvas().style.cursor = ''
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
    if (!used || !map) return
    for (const id of FACILITY_LAYER_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
  }, [map, used, visible, ready])

  // 一覧で焦点の当たっている対象を強調する(輪と記号の拡大。地図は動かさない)
  useEffect(() => {
    if (!used || !map) return
    setFacilityHighlight(map, highlighted)
  }, [map, used, highlighted, ready])

  if (!visible || candidates.length === 0) return null
  // 凡例と押した記号の名前は、右上の拡大・縮小のボタンの下に縦に積む(互いに重ならず、下の中央の時間帯の切り替えとも重ならない)
  return (
    <div className="pointer-events-none flex flex-col items-end gap-2" data-testid="facility-overlay">
      <FacilityLegend candidates={candidates} selected={selected} otherStops={otherStops} />
      {picked && (
        <div className="pointer-events-auto flex max-w-60 items-start gap-1.5 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10" role="status">
          {picked.kind && <FacilitySymbol kind={picked.kind} symbol={picked.symbol ?? undefined} className="mt-0.5 size-4 shrink-0" />}
          <span className="min-w-0 flex-1">
            {picked.name}
            {picked.symbol === 'busstop' ? (
              <span className="ml-1 text-muted-foreground">ほかの事業者の停留所</span>
            ) : (
              picked.kind && <span className="ml-1 text-muted-foreground">{FACILITY_KIND_LABELS[picked.kind]}</span>
            )}
            {picked.detail && <span className="block text-muted-foreground">{picked.detail}</span>}
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
 * 地図を出す手順に共通の重ね:到達圏(ReachLayers)と、前提情報の手順でだけ見せる施設(FacilityLayer)と、
 * 前提情報・影響・平日便を戻す手順で見せる利用者が置いた場所(PlacesLayer。前提情報の手順の「運行の前提」の欄で置く)。
 * 手順の一覧(registry.ts)で、地図を出す手順すべてにこの同じ部品を渡す。部品が同じなので、手順を移っても
 * 到達圏の重ねを作り直さない(地図の位置合わせをやり直さない)。
 * 施設と場所の凡例は、右上の拡大・縮小のボタンの下に1つの列で縦に積む(前提情報の手順で両方が出ても重ならない)
 */
/** 施設と場所の凡例を積む、地図の右上の列(拡大・縮小のボタンの下) */
export const MAP_OVERLAY_COLUMN_CLASS = 'pointer-events-none absolute top-24 right-3 flex flex-col items-end gap-2'

export default function MapOverlays() {
  const current = useStepStore((s) => s.current)
  return (
    <>
      <ReachLayers />
      <div className={MAP_OVERLAY_COLUMN_CLASS} data-testid="map-overlay-column">
        <FacilityLayer visible={current === 'research'} />
        <PlacesLayer visible={current === 'research' || current === 'reach' || current === 'restore'} placeable={current === 'research'} />
      </div>
    </>
  )
}
