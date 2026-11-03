import type { Map as MapLibreMap } from 'maplibre-gl'
import { create } from 'zustand'

interface MapState {
  /**
   * 地図。スタイルの読み込みが終わる(`load`)まで null。
   * null でなければ、`addSource` / `addLayer` を呼んでよい。
   */
  map: MapLibreMap | null
  setMap: (map: MapLibreMap | null) => void
  /**
   * 強調する施設の target_id(一覧の行や調査の結果のカードに、マウスやキーボードの焦点が当たっているもの)。
   * 一覧(ResearchStep)が setHighlighted で書き、地図の記号(FacilityLayer)が読む。
   * 地図は動かさず、輪と記号の拡大だけで示す。強調するものが無ければ null
   */
  highlightedTargetId: string | null
  setHighlighted: (targetId: string | null) => void
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
  highlightedTargetId: null,
  setHighlighted: (highlightedTargetId) => set({ highlightedTargetId }),
}))
