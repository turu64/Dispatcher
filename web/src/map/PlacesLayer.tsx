import type { MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl'
import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { PLACE_TYPE_LABELS, PLACE_TYPES, type PlaceType } from '@/lib/userPlaces'
import { defaultPlaceName, useDriversStore, type UserPlace } from '@/store/drivers'
import { useMapStore } from '@/store/map'
import { loadSymbolImage, type LoadSymbolImage } from './facilityLayers'
import {
  addPlaceImages,
  addPlaceLayers,
  PLACE_COLORS,
  PLACE_PATHS,
  PLACES_LAYER,
  PLACES_LEGEND_TITLE,
  PLACES_SOURCE,
  placesToGeoJson,
  removePlaceLayers,
  type PlacesMap,
} from './placesLayers'

/**
 * 利用者が置いた営業所(指摘 24、docs/tasks-1105.md の D05)を地図に出す。
 * 記号は四角(11/6 に種類を営業所1つにまとめた)で、右上に凡例「利用者が置いた場所」(「営業所 N か所」)を出す。
 * 「地図で置く」(store/drivers.ts の placing)の間は、地図を1回押した位置に場所を足す。地図を動かす・拡大する操作は
 * そのまま使える(MapLibre は動かした後には click を出さない)。Esc でやめる。
 * 場所は運行の前提の手順の「運行の前提」の欄(research/OperationPremise.tsx)で置き、運行の前提・影響・平日便を戻す手順の地図に出す。
 * 地図を隠す手順・読み込みの手順(visible が false)では何も出さず、置いている途中ならやめる。
 * レイヤーは、場所を初めて置くか置き始めたときに足す(使わない人の地図に記号の画像を足さない)。足した後は隠すだけ
 */

// 置くために押した地図の操作(同じ押下で記号の名前を出さないため。押した位置に記号があっても場所を足すだけにする)
const placingClicks = new WeakSet<object>()

/** 凡例・一覧の記号(地図の記号と同じ形と色) */
export function PlaceSymbol({ type, className }: { type: PlaceType; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? 'size-4 shrink-0'} aria-hidden="true">
      <path d={PLACE_PATHS[type]} fill={PLACE_COLORS[type]} stroke="#ffffff" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  )
}

/** 凡例(「営業所 N か所」)。置いている途中なら、押して置くことと Esc でやめることを出す */
export function PlacesLegend({ places, placing }: { places: readonly UserPlace[]; placing: PlaceType | null }) {
  const counts = new Map<PlaceType, number>()
  for (const p of places) counts.set(p.type, (counts.get(p.type) ?? 0) + 1)
  return (
    <div
      className="pointer-events-none flex max-w-60 flex-col gap-1 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10"
      role="group"
      aria-label="利用者が置いた場所の凡例"
    >
      <span className="font-medium">{PLACES_LEGEND_TITLE}</span>
      {PLACE_TYPES.filter((t) => (counts.get(t) ?? 0) > 0).map((t) => (
        <span key={t} className="flex items-center gap-1.5">
          <PlaceSymbol type={t} />
          {PLACE_TYPE_LABELS[t]} {counts.get(t)} か所
        </span>
      ))}
      {placing && (
        <span className="flex items-center gap-1.5 font-medium" role="status">
          <PlaceSymbol type={placing} />
          地図を押すと{PLACE_TYPE_LABELS[placing]}を置きます(Esc でやめる)
        </span>
      )}
    </div>
  )
}

/**
 * 利用者が置いた場所の記号と凡例。visible は地図を出していて、場所を見せる手順(運行の前提・影響・平日便を戻す)か。
 * 凡例は、地図の右上の列(FacilityLayer.tsx の MapOverlays)の中に出す。
 * placeable は地図で置けるか(置く操作のある運行の前提の手順だけ)。置けない手順に移ったら、置いている途中ならやめる。
 * loadImage はテストで差し替える
 */
export default function PlacesLayer({
  visible,
  placeable = true,
  loadImage = loadSymbolImage,
}: {
  visible: boolean
  placeable?: boolean
  loadImage?: LoadSymbolImage
}) {
  const map = useMapStore((s) => s.map) as PlacesMap | null
  const places = useDriversStore((s) => s.places)
  const placing = useDriversStore((s) => s.placing)
  const features = useMemo(() => placesToGeoJson(places), [places])
  // 押した記号の名前(凡例の下に出す)
  const [picked, setPicked] = useState<{ id: string; name: string; type: PlaceType } | null>(null)
  // 消した場所の名前は出さない
  const shownPick = picked && places.some((p) => p.id === picked.id) ? picked : null
  // レイヤーは、場所を初めて置くか置き始めたときに足す。足した後は隠すだけ
  const [used, setUsed] = useState(false)
  const [ready, setReady] = useState(0)
  if (!used && (places.length > 0 || placing !== null)) setUsed(true)

  useEffect(() => {
    if (!map || !used) return
    const abort = new AbortController()
    const onClick = (e: MapLayerMouseEvent) => {
      // 置いている途中は、記号を押しても名前を出さない(その位置に場所を足す)
      if (useDriversStore.getState().placing || placingClicks.has(e.originalEvent)) return
      const props = e.features?.[0]?.properties as { id?: unknown; name?: unknown; type?: unknown } | undefined
      if (typeof props?.id !== 'string' || typeof props.name !== 'string') return
      if (!(PLACE_TYPES as readonly unknown[]).includes(props.type)) return
      setPicked({ id: props.id, name: props.name, type: props.type as PlaceType })
    }
    let registered = false
    addPlaceImages(map, abort.signal, loadImage)
      .then(() => {
        if (abort.signal.aborted) return
        addPlaceLayers(map)
        map.on('click', PLACES_LAYER, onClick)
        registered = true
        setReady((n) => n + 1)
      })
      .catch(() => {
        // 画像を作れなかったときは記号を出さない(一覧と推定は動く)
      })
    return () => {
      abort.abort()
      if (registered) map.off('click', PLACES_LAYER, onClick)
      removePlaceLayers(map)
    }
  }, [map, used, loadImage])

  useEffect(() => {
    if (!map || !used) return
    const source = map.getSource(PLACES_SOURCE) as { setData?: (d: unknown) => void } | undefined
    source?.setData?.(features)
  }, [map, used, features, ready])

  useEffect(() => {
    if (!map || !used) return
    if (map.getLayer(PLACES_LAYER)) map.setLayoutProperty(PLACES_LAYER, 'visibility', visible ? 'visible' : 'none')
  }, [map, used, visible, ready])

  // 場所を見せない手順・置く操作のない手順に移ったら、置くのをやめる
  const canPlace = visible && placeable
  useEffect(() => {
    if (!canPlace && placing !== null) useDriversStore.getState().cancelPlacing()
  }, [canPlace, placing])

  // 置いている途中:地図を1回押した位置に足す。Esc でやめる。地図を動かす操作は止めない
  useEffect(() => {
    if (!map || !canPlace || placing === null) return
    const canvas = map.getCanvas()
    canvas.style.cursor = 'crosshair'
    const onClick = (e: MapMouseEvent) => {
      const s = useDriversStore.getState()
      const type = s.placing
      if (!type) return
      placingClicks.add(e.originalEvent)
      s.addPlace({ type, name: defaultPlaceName(PLACE_TYPE_LABELS[type], s.places), lat: e.lngLat.lat, lon: e.lngLat.lng })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useDriversStore.getState().cancelPlacing()
    }
    map.on('click', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      window.removeEventListener('keydown', onKey)
      canvas.style.cursor = ''
    }
  }, [map, canPlace, placing])

  if (!visible || (places.length === 0 && placing === null)) return null
  return (
    <div className="pointer-events-none flex flex-col items-end gap-2" data-testid="places-overlay">
      <PlacesLegend places={places} placing={placing} />
      {shownPick && (
        <div className="pointer-events-auto flex max-w-60 items-start gap-1.5 rounded-lg bg-background/95 px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10" role="status">
          <PlaceSymbol type={shownPick.type} className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {shownPick.name}
            <span className="ml-1 text-muted-foreground">{PLACE_TYPE_LABELS[shownPick.type]}</span>
          </span>
          <button type="button" aria-label="閉じる" className="shrink-0 hover:text-foreground/70" onClick={() => setPicked(null)}>
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
