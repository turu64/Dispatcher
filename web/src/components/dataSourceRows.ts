import type { HolidayState } from '@/store/holidays'

export interface DataSourceRow {
  data: string
  source: string
  license: string
}

/** CLAUDE.md の「データと出典」と同じ内容。出典は画面と README の両方に表示する */
const DATA_SOURCES: readonly DataSourceRow[] = [
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
]

/**
 * 祝日一覧の出典。内閣府のホームページ利用規約(令和7年3月25日現在、https://www.cao.go.jp/notice/rule.html)は、
 * 個別の記載が無いコンテンツに公共データ利用規約(第1.0版)を適用する(政府標準利用規約の後継。CC BY 4.0 互換)。
 * 祝日一覧の CSV の配布ページ(https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html)に個別の記載は無い(2026-11-03 に確認)。
 */
const HOLIDAY_LICENSE = '公共データ利用規約(第1.0版)'

/**
 * 画面に出す出典の行。実際に使っているデータだけを出す:
 * 祝日一覧は、読み込めたとき(ready)だけ「国民の祝日(内閣府)」の行を足す。
 */
export function dataSourceRows(holidays: HolidayState): DataSourceRow[] {
  if (holidays.status !== 'ready') return [...DATA_SOURCES]
  const row: DataSourceRow = { data: '国民の祝日(内閣府)', source: holidays.list.source, license: HOLIDAY_LICENSE }
  // 背景地図の行を最後に残す
  return [...DATA_SOURCES.slice(0, -1), row, DATA_SOURCES[DATA_SOURCES.length - 1]]
}
