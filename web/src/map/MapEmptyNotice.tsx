import { ArrowLeft } from 'lucide-react'
import { useEditStore } from '@/store/edit'

/**
 * GTFS を読み込む前に、地図の中央に出す案内。読み込むと消える。
 * 地図の操作(移動・拡大)の邪魔にならないよう、案内の外はポインターを通す
 */
export default function MapEmptyNotice() {
  const loaded = useEditStore((s) => s.base !== null)
  if (loaded) return null
  return (
    <div className="print-hide pointer-events-none absolute inset-0 flex items-center justify-center p-4">
      <p className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-background/90 px-4 py-3 text-sm font-medium shadow-sm backdrop-blur-sm">
        <ArrowLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        左の欄から GTFS を読み込んでください
      </p>
    </div>
  )
}
