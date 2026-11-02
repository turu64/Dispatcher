import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

/** CLAUDE.md の「データと出典」と同じ内容。出典は画面と README の両方に表示する */
const DATA_SOURCES = [
  {
    data: 'GTFS(道北バスなど)',
    source: '北海道オープンデータプラットフォーム',
    license: 'CC BY 4.0',
  },
  {
    data: '人口(令和2年国勢調査 地域メッシュ統計、250m)',
    source: 'e-Stat(政府統計の総合窓口)を加工して作成',
    license: '政府標準利用規約',
  },
  {
    data: '人口集中地区(A16、2020年)',
    source: '国土数値情報(国土交通省)を加工して作成',
    license: '国土数値情報利用約款(商用可)',
  },
  {
    data: '鉄道駅(N02、2025年度)',
    source: '国土数値情報(国土交通省)を加工して作成',
    license: 'CC BY 4.0',
  },
  {
    data: '背景地図',
    source: 'OpenStreetMap Japan のベクトルタイル',
    license: '© OpenStreetMap Contributors',
  },
] as const

/** 左パネルの一番下の「データの出典」欄 */
export default function DataSources() {
  return (
    <section className="flex flex-col gap-3 text-sm" aria-labelledby="data-sources-heading">
      <Separator />
      <h2 id="data-sources-heading" className="font-medium">
        データの出典
      </h2>
      <ul className="flex flex-col gap-3">
        {DATA_SOURCES.map((s) => (
          <li key={s.data} className="flex flex-col gap-1">
            <span>{s.data}</span>
            <span className="text-muted-foreground">{s.source}</span>
            <Badge variant="outline">{s.license}</Badge>
          </li>
        ))}
      </ul>
    </section>
  )
}
