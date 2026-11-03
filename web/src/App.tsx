import ChatPanel from '@/components/chat/ChatPanel'
import DataSources from '@/components/DataSources'
import DateBandStep from '@/components/steps/DateBandStep'
import ExportStep from '@/components/steps/ExportStep'
import LoadStep from '@/components/steps/LoadStep'
import PolicyStep from '@/components/steps/PolicyStep'
import ReachStep from '@/components/steps/ReachStep'
import RestoreStep from '@/components/steps/RestoreStep'
import { TooltipProvider } from '@/components/ui/tooltip'
import BaseMap from '@/map/BaseMap'
import ReachLayers from '@/map/ReachLayers'

// 1画面構成:左に手順のパネル、右に地図。
// 手順の中身は components/steps/ の1手順1ファイル。左パネルの一番下はデータの出典。
// 手順の並びは「読み込み → 方針 → 日付と時間帯 → 到達圏(前後) → 足し戻し → 出力」(docs/interfaces-1104.md §7)。
// 日付と到達圏は、方針の結果を見る場所として方針のあとに置く。前提情報(11/6)は 1 と 2 の間に入る。
export default function App() {
  return (
    <TooltipProvider>
      <div className="flex h-full w-full">
        <aside className="flex w-[380px] shrink-0 flex-col border-r bg-muted/30" aria-label="手順">
          {/* 手順が増えて縦にあふれても、カードが縮んで中身が切れないよう、中身は高さを固定しない入れ物に入れる。
              この入れ物だけが縦に流れ、下の「AI に相談」の欄は固定で置く */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex min-h-full flex-col gap-4 p-4">
              <header>
                <h1 className="text-xl font-semibold">Dispatcher</h1>
                <p className="text-sm text-muted-foreground">減便ダイヤの判断支援(準備中)</p>
              </header>

              <LoadStep />
              <PolicyStep />
              <DateBandStep />
              <ReachStep />
              <RestoreStep />
              <ExportStep />

              <div className="mt-auto">
                <DataSources />
              </div>
            </div>
          </div>
          {/* GTFS を読み込むまでは出さない */}
          <ChatPanel />
        </aside>
        <main className="relative min-w-0 flex-1" aria-label="地図">
          <BaseMap />
          {/* 到達圏のセル・停留所・駅のレイヤーと凡例。地図の準備ができてから重ねる */}
          <ReachLayers />
        </main>
      </div>
    </TooltipProvider>
  )
}
