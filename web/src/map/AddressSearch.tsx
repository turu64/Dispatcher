import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { MapPin, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useMapStore } from '@/store/map'
import { GeocodeError, MAX_QUERY_LENGTH, searchAddress, type GeocodeResult } from './geocode'

/** 選んだ場所の印のソースとレイヤーの名前 */
export const SEARCH_SOURCE_ID = 'address-search-result'
const SEARCH_HALO_LAYER_ID = 'address-search-result-halo'
const SEARCH_DOT_LAYER_ID = 'address-search-result-dot'

/** 住所検索の出典(Nominatim は OpenStreetMap のデータ。ODbL) */
export const ADDRESS_SEARCH_ATTRIBUTION = '住所検索:Nominatim(© OpenStreetMap contributors)'

/** 結果を選んだときに寄る縮尺(範囲が分からない結果のとき) */
const POINT_ZOOM = 16

type Status =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'done'; query: string; results: GeocodeResult[] }
  | { kind: 'error'; message: string }

function pointData(r: GeocodeResult | null) {
  return {
    type: 'FeatureCollection' as const,
    features: r
      ? [{ type: 'Feature' as const, properties: { label: r.label }, geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] } }]
      : [],
  }
}

/** 選んだ場所に印を置く(無ければソースとレイヤーを足す)。r が null なら印を消す */
function showPin(map: MapLibreMap, r: GeocodeResult | null): void {
  const source = map.getSource(SEARCH_SOURCE_ID) as GeoJSONSource | undefined
  if (source) {
    source.setData(pointData(r))
    return
  }
  if (!r) return
  map.addSource(SEARCH_SOURCE_ID, { type: 'geojson', data: pointData(r) })
  map.addLayer({
    id: SEARCH_HALO_LAYER_ID,
    type: 'circle',
    source: SEARCH_SOURCE_ID,
    paint: { 'circle-radius': 14, 'circle-color': '#dc2626', 'circle-opacity': 0.2 },
  })
  map.addLayer({
    id: SEARCH_DOT_LAYER_ID,
    type: 'circle',
    source: SEARCH_SOURCE_ID,
    paint: { 'circle-radius': 6, 'circle-color': '#dc2626', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  })
}

function removePin(map: MapLibreMap): void {
  for (const id of [SEARCH_DOT_LAYER_ID, SEARCH_HALO_LAYER_ID]) if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(SEARCH_SOURCE_ID)) map.removeSource(SEARCH_SOURCE_ID)
}

/**
 * 地図の右上(拡大・縮小のボタンの左)に置く、住所・地名の検索欄。
 * 「検索」を押したときだけ Nominatim に問い合わせ(入力の途中では送らない)、結果を選ぶとその場所へ地図を動かして印を置く。
 * 送るのは入れた文字だけ(geocode.ts)。地図が無い(読み込み中・失敗)ときは出さない
 */
export default function AddressSearch({ visible = true }: { visible?: boolean }) {
  const map = useMapStore((s) => s.map)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [picked, setPicked] = useState<GeocodeResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // 選んだ場所の印。地図が作り直されたら付け直し、外れたら片付ける。
  // 一度も選んでいなければ地図に触らない(印のソースは選んだときに初めて足す)
  const pinMapRef = useRef<MapLibreMap | null>(null)
  useEffect(() => {
    if (!map) return
    if (!picked && pinMapRef.current !== map) return
    showPin(map, picked)
    pinMapRef.current = map
  }, [map, picked])
  useEffect(() => {
    if (!map) return
    return () => {
      if (pinMapRef.current !== map) return
      pinMapRef.current = null
      // 地図がもう壊されていれば何もしない
      try {
        removePin(map)
      } catch {
        /* 地図を片付けた後 */
      }
    }
  }, [map])
  useEffect(() => () => abortRef.current?.abort(), [])

  if (!map || !visible) return null

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault()
    const q = query.trim()
    if (q === '' || status.kind === 'searching') return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStatus({ kind: 'searching' })
    searchAddress(q, { signal: ctrl.signal })
      .then((results) => {
        if (ctrl.signal.aborted) return
        setStatus({ kind: 'done', query: q, results })
        // 1 件だけなら、選ぶ手間を省いてそのまま動かす
        if (results.length === 1) pick(results[0])
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
        setStatus({ kind: 'error', message: err instanceof GeocodeError ? err.message : '住所検索に失敗しました。' })
      })
  }

  const pick = (r: GeocodeResult) => {
    setPicked(r)
    if (r.bbox && (r.bbox[2] - r.bbox[0] > 0.0005 || r.bbox[3] - r.bbox[1] > 0.0005)) {
      map.fitBounds(
        [
          [r.bbox[0], r.bbox[1]],
          [r.bbox[2], r.bbox[3]],
        ],
        { padding: 48, maxZoom: 17, duration: 800 },
      )
    } else {
      map.flyTo({ center: [r.lon, r.lat], zoom: POINT_ZOOM, duration: 800 })
    }
  }

  const clear = () => {
    abortRef.current?.abort()
    setQuery('')
    setStatus({ kind: 'idle' })
    setPicked(null)
    inputRef.current?.focus()
  }

  const showPanel = status.kind === 'done' || status.kind === 'error'

  return (
    <div className="print-hide absolute top-2.5 right-12 z-10 flex w-[min(18rem,calc(100%-4rem))] flex-col gap-1">
      <form
        role="search"
        aria-label="住所・地名で地図を動かす"
        onSubmit={onSubmit}
        className="flex items-center gap-0.5 rounded-lg bg-background/95 p-0.5 shadow-md ring-1 ring-foreground/10"
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && (showPanel || query !== '')) {
              e.preventDefault()
              clear()
            }
          }}
          maxLength={MAX_QUERY_LENGTH}
          aria-label="住所・地名"
          aria-controls={showPanel ? listId : undefined}
          placeholder="住所・地名で検索"
          className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        {(query !== '' || picked) && (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="検索を消す" onClick={clear}>
            <X aria-hidden="true" />
          </Button>
        )}
        <Button type="submit" variant="ghost" size="icon-sm" aria-label="検索" disabled={query.trim() === '' || status.kind === 'searching'}>
          {status.kind === 'searching' ? <Spinner aria-hidden="true" /> : <Search aria-hidden="true" />}
        </Button>
      </form>

      {showPanel && (
        <div id={listId} className="rounded-lg bg-background/95 p-1 text-xs shadow-md ring-1 ring-foreground/10">
          {status.kind === 'error' && (
            <p role="alert" className="px-2 py-1.5 text-destructive">
              {status.message}
            </p>
          )}
          {status.kind === 'done' && status.results.length === 0 && (
            <p role="status" className="px-2 py-1.5 text-muted-foreground">
              「{status.query}」は見つかりませんでした。市町村名から書くと見つかりやすくなります。
            </p>
          )}
          {status.kind === 'done' && status.results.length > 0 && (
            <ul aria-label="住所検索の結果" className="flex flex-col">
              {status.results.map((r, i) => {
                const selected = picked !== null && picked.lat === r.lat && picked.lon === r.lon
                return (
                  <li key={`${r.lat},${r.lon},${i}`}>
                    <button
                      type="button"
                      aria-current={selected ? 'location' : undefined}
                      onClick={() => pick(r)}
                      className="flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-[current=location]:bg-muted"
                    >
                      <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 wrap-break-word">{r.label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="px-2 pt-1 text-[10px] text-muted-foreground">{ADDRESS_SEARCH_ATTRIBUTION}</p>
        </div>
      )}
    </div>
  )
}
