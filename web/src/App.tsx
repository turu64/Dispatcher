import { useEffect, useState, useSyncExternalStore } from 'react'
import SidePanel from '@/components/layout/SidePanel'
import SplitPane from '@/components/layout/SplitPane'
import { stepOf, STEPS } from '@/components/steps/registry'
import { TooltipProvider } from '@/components/ui/tooltip'
import BaseMap from '@/map/BaseMap'
import MapEmptyNotice from '@/map/MapEmptyNotice'
import AddressSearch from '@/map/AddressSearch'
import AboutPage, { ABOUT_HASH } from '@/pages/AboutPage'
import { fixedToday, formatDateJa } from '@/lib/dates'
import { useHolidayStore } from '@/store/holidays'
import { useStepStore } from '@/store/steps'

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** 今のハッシュ(#/about など)。react-dom/server での描画では空 */
function useHash(): string {
  return useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => '',
  )
}

// 1画面構成:上の端にアプリ名と運営情報(#/about)へのリンク、左に手順、右に地図。
// 左の欄は、上の端のタブで「編集」(手順の見出し(ステッパー)・開いている手順の中身・下の「戻る」「次へ」)と「AI に相談」を切り替える(layout/SidePanel)。
// 手順の並びと、手順ごとに地図を出すか・地図に何を重ねるかは components/steps/registry.ts の一覧が決める(ここは一覧を描くだけ)。
// 運営情報のページを開いている間も、手順と地図は消さずに隠しておく(入力中の値と地図の表示を残すため)
export default function App() {
  const about = useHash() === ABOUT_HASH
  // デモで「今日」を固定しているとき(URL の ?today=)は、上の端にその旨を出す
  const [demoToday] = useState(() => fixedToday())
  const current = useStepStore((s) => s.current)
  const step = stepOf(current)?.def ?? STEPS[0]
  const showMap = step.showMap

  // 地図を出さない手順の間は、直前に地図を出していた手順の重ねを残す(戻ったときに作り直さないため)
  const [mapStep, setMapStep] = useState(current)
  if (showMap && mapStep !== current) setMapStep(current)
  const Overlay = (stepOf(mapStep)?.def ?? step).mapOverlay

  // 祝日一覧は、画面を開いたときに 1 回だけ読む(方針の期間の祝日や、出力の検証で使う)。
  // 読めなかった(missing・error)ときの読み込み直しは、祝日を使う手順のボタンから load を呼ぶ
  useEffect(() => {
    const { holidays, load } = useHolidayStore.getState()
    if (holidays.status === 'idle') void load()
  }, [])

  return (
    <TooltipProvider>
      <div className="flex size-full flex-col">
        <header className="print-hide flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-lg font-semibold">Dispatcher</h1>
            <p className="truncate text-xs text-muted-foreground">減便ダイヤの判断支援</p>
          </div>
          {demoToday && (
            <p className="min-w-0 truncate rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="note">
              デモ用に、今日を {formatDateJa(demoToday)} として動いています
            </p>
          )}
          <a href={ABOUT_HASH} className="shrink-0 text-xs underline underline-offset-4 hover:text-foreground/80">
            このサイトについて・データの出典
          </a>
        </header>

        <div hidden={about} className="min-h-0 flex-1">
          <SplitPane
            showRight={showMap}
            left={<SidePanel wide={!showMap} />}
            right={
              <main className="relative size-full" aria-label="地図">
                <BaseMap visible={showMap && !about} />
                {/* 手順ごとの重ね(到達圏のセル・停留所・駅と凡例など)。地図の準備ができてから重ねる */}
                {Overlay && <Overlay />}
                {/* GTFS を読み込む前は、地図の中央に読み込みの案内を出す */}
                <MapEmptyNotice />
                {/* 住所・地名で地図を動かす検索欄(右上、拡大・縮小のボタンの左)。入れた文字だけを Nominatim に送る */}
                <AddressSearch visible={showMap && !about} />
              </main>
            }
          />
        </div>

        {about && (
          <div className="min-h-0 flex-1">
            <AboutPage />
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
