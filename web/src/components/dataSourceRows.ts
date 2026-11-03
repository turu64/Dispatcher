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
 * 前提情報の調査の対象(国土数値情報の P11・P29・P04)の出典。年度は data/raw/README.md の入手した版。
 * 利用条件は配布ページの「オープンデータ(CC_BY_4.0)」
 */
export const FACILITY_SOURCES: readonly DataSourceRow[] = [
  {
    data: 'バス停留所(P11、2022年度)',
    source: '国土数値情報(国土交通省)を加工して作成',
    license: 'CC BY 4.0',
  },
  {
    data: '学校(P29、2023年度)',
    source: '国土数値情報(国土交通省)を加工して作成',
    license: 'CC BY 4.0',
  },
  {
    data: '医療機関(P04、2020年度)',
    source: '国土数値情報(国土交通省)を加工して作成',
    license: 'CC BY 4.0',
  },
]

/** 出典の行を決める、使っているデータの状態 */
export interface DataSourceUsage {
  /** 前提情報の手順で施設の参照データ(P11・P29・P04)を読み込んだ */
  facilities?: boolean
}

/**
 * 画面に出す出典の行。実際に使っているデータだけを出す:
 * - 祝日一覧は、読み込めたとき(ready)だけ「国民の祝日(内閣府)」の行を足す
 * - バス停留所(P11)・学校(P29)・医療機関(P04)は、前提情報の手順で施設を読み込んだときだけ足す(鉄道駅の後ろ)
 * 背景地図の行はいつも最後
 */
export function dataSourceRows(holidays: HolidayState, usage: DataSourceUsage = {}): DataSourceRow[] {
  const rows = DATA_SOURCES.slice(0, -1)
  if (usage.facilities) rows.push(...FACILITY_SOURCES)
  if (holidays.status === 'ready') rows.push({ data: '国民の祝日(内閣府)', source: holidays.list.source, license: HOLIDAY_LICENSE })
  rows.push(DATA_SOURCES[DATA_SOURCES.length - 1])
  return rows
}
