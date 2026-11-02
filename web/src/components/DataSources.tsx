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
    data: '人口メッシュ(令和2年、125m・250m)',
    source: 'e-Stat(政府統計の総合窓口)を加工して作成',
    license: '政府標準利用規約',
  },
  {
    data: 'DID(A16)、鉄道(N02)、学校(P29)、医療機関(P04)、バス停留所(P11)',
    source: '国土数値情報',
    license: 'CC BY 4.0 ほか',
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
