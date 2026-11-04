import { useEffect } from 'react'
import { Badge } from '@/components/ui/badge'
import { useHolidayStore, type HolidayState } from '@/store/holidays'
import { facilitiesInUse, useResearchStore } from '@/store/research'
import { useServiceGroupsStore } from '@/store/serviceGroups'
import { JEV_ROUTING_NOTE, JEV_SENT_SCOPE } from '@/components/steps/load/serviceGroupsText'
import { dataSourceRows, type DataSourceUsage } from './dataSourceRows'

/** 出典の一覧の表示(状態は引数で受ける。画面の部品 DataSources が store から渡す) */
export function DataSourcesView({ holidays, usage }: { holidays: HolidayState; usage?: DataSourceUsage }) {
  return (
    <section className="flex flex-col gap-3 text-sm" aria-labelledby="data-sources-heading">
      <h2 id="data-sources-heading" className="font-medium">
        データの出典
      </h2>
      <ul className="flex flex-col gap-3">
        {dataSourceRows(holidays, usage).map((s) => (
          <li key={s.data} className="flex flex-col gap-1">
            <span>{s.data}</span>
            <span className="text-muted-foreground">{s.source}</span>
            <Badge variant="outline">{s.license}</Badge>
          </li>
        ))}
      </ul>
      {usage?.jevSent && <JevDestination />}
    </section>
  )
}

/**
 * 「データの送り先」。ダイヤのグループ分けの確かめで Jev に送ったときだけ出す(docs/design-service-groups.md §5.4)。
 * 送る中身と送らないもの、転送先を TypeSafe AI に限っている点は、読み込みの手順のスイッチの下と同じ文
 */
export function JevDestination() {
  return (
    <section className="flex flex-col gap-1" aria-labelledby="data-destination-heading">
      <h3 id="data-destination-heading" className="font-medium">
        データの送り先
      </h3>
      <p>
        ダイヤのグループ分けの確かめ:TypeSafe AI Jev。Vercel AI Gateway を経由します。AI(Claude)とは別の AI
        で、service の分け方を確かめるだけに使います。
      </p>
      <p className="text-muted-foreground">{JEV_SENT_SCOPE}</p>
      <p className="text-muted-foreground">
        {JEV_ROUTING_NOTE}データの保持は、Vercel と TypeSafe AI の規約によります。
      </p>
    </section>
  )
}

/**
 * 「データの出典」欄。運営情報のページ(pages/AboutPage.tsx、#/about)に出し、画面の上の端のリンクから開く。
 * 地図の OpenStreetMap の表示は、地図の中にも出す(map/BaseMap.tsx)
 */
export default function DataSources() {
  const holidays = useHolidayStore((s) => s.holidays)
  const loadHolidays = useHolidayStore((s) => s.load)
  // 前提情報の手順で施設(P11・P29・P04)を読み込んだときだけ、その出典を出す
  const facilities = useResearchStore(facilitiesInUse)
  // 画面を開いたときに祝日一覧を 1 回だけ読む(読み込み中・読み込み済みなら load は何もしない)。
  // 読めなかった(missing・error)ときの読み込み直しは、祝日を使う手順のボタンから load を呼ぶ
  useEffect(() => {
    if (holidays.status === 'idle') void loadHolidays()
  }, [holidays.status, loadHolidays])

  // ダイヤのグループ分けで判断材料をサーバーに送ったとき(sending まで進んだとき)だけ、送り先を出す。
  // 使えるかを確かめている間に止めた・送らない設定だった・使えなかったときは出さない
  const jevSent = useServiceGroupsStore((s) => s.jev.sent)

  return <DataSourcesView holidays={holidays} usage={{ facilities, jevSent }} />
}
