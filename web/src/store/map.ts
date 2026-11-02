import type { Map as MapLibreMap } from 'maplibre-gl'
import { create } from 'zustand'

interface MapState {
  /**
   * 地図。スタイルの読み込みが終わる(`load`)まで null。
   * null でなければ、`addSource` / `addLayer` を呼んでよい。
   */
  map: MapLibreMap | null
  setMap: (map: MapLibreMap | null) => void
}

/**
 * 背景地図(MapLibre GL JS)のインスタンスを持つ。作るのは `map/BaseMap.tsx` だけ。
 *
 * レイヤーを足す側は、地図が準備できてから足し、外れたら片付ける:
 *
 *   const map = useMapStore((s) => s.map)
 *   useEffect(() => {
 *     if (!map) return
 *     map.addSource(...); map.addLayer(...)
 *     return () => { map.removeLayer(...); map.removeSource(...) }
 *   }, [map])
 */
export const useMapStore = create<MapState>()((set) => ({
  map: null,
  setMap: (map) => set({ map }),
}))
