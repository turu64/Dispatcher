import 'maplibre-gl/dist/maplibre-gl.css'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import { useMapStore } from '@/store/map'

/** 背景地図のスタイル(OpenStreetMap Japan のベクトルタイル) */
const BASE_MAP_STYLE = 'https://tile.openstreetmap.jp/styles/osm-bright-ja/style.json'

/** 初期表示は旭川(道北バスの運行範囲の中心あたり)。経度、緯度の順 */
const INITIAL_CENTER: [number, number] = [142.36, 43.77]
const INITIAL_ZOOM = 10

/** 右下に出す出典。タイルの出典(OpenMapTiles など)はスタイルから自動で加わる */
const ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap Contributors</a>'

/**
 * 背景地図。親の大きさいっぱいに広がる(親は `relative` にしておく)。
 *
 * 地図は読み込みが終わってから `useMapStore` に入る。ほかの部品はそこから取り、
 * `map` が null でなければレイヤーを足してよい。
 *
 * MapLibre はブラウザでしか動かないため、地図は useEffect の中でだけ作る
 * (react-dom/server での描画やテストで落ちないようにする)。
 */
export default function BaseMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // StrictMode(開発時)では、作成→片付け→作成の順に2回走る。
    // 片付けのあとに読み込みが終わった地図を使わないよう、印を付ける
    let cancelled = false
    let map: MapLibreMap | null = null

    // MapLibre の Web Worker は、自分のファイルの隣にある maplibre-gl-worker.mjs を探しにいく。
    // Vite でまとめると隣に無くなるため、ファイルを別に配り、その URL を教える
    void Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url')])
      .then(([maplibregl, worker]) => {
        if (cancelled) return
        maplibregl.setWorkerUrl(worker.default)
        const created = new maplibregl.Map({
          container,
          style: BASE_MAP_STYLE,
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          attributionControl: { customAttribution: ATTRIBUTION },
        })
        map = created
        created.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
        created.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
        created.on('load', () => {
          if (cancelled) return
          setFailed(false)
          useMapStore.getState().setMap(created)
        })
        // スタイルが読めないとき(ネットワークの断絶など)は load が来ない。
        // 読み込みが終わったあとのタイルの失敗では何も出さない
        created.on('error', () => {
          if (!cancelled && useMapStore.getState().map !== created) setFailed(true)
        })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      if (map && useMapStore.getState().map === map) useMapStore.getState().setMap(null)
      map?.remove()
    }
  }, [])

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="size-full" />
      {failed && (
        <p
          role="status"
          className="absolute top-3 left-1/2 -translate-x-1/2 rounded-lg bg-background px-3 py-2 text-sm shadow-md ring-1 ring-foreground/10"
        >
          背景地図を読み込めませんでした。ネットワークにつながっているか確かめてください。
        </p>
      )}
    </div>
  )
}
