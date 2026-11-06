import type { PlaceInput } from './userPlaces'

/**
 * 道北バスのサンプルの営業所(2026-11-06 に利用者が入力した位置。5か所)と在籍の運転士の数。
 * サンプルの GTFS(道北バス)を読み込んだときだけ、前提情報の手順の「運行の前提」の欄のボタンで入れる。
 * 勤務の推定では、出庫・入庫と点呼の場所で、休憩の場所もその近くに絞る。既定では置かない
 */
const OFFICES: ReadonlyArray<{ name: string; lat: number; lon: number }> = [
  { name: '本社・旭川営業所', lat: 43.78477106845392, lon: 142.32735360246497 },
  { name: '名寄出張所', lat: 44.33619172269047, lon: 142.46078478279628 },
  { name: '上川営業所', lat: 43.84879016860576, lon: 142.7673373828642 },
  { name: '層雲峡出張所', lat: 43.726113151368416, lon: 142.94832669440316 },
  { name: '永山出張所', lat: 43.82411645611905, lon: 142.45655293238067 },
]

/** 営業所の数(画面の文に使う) */
export const DOHOKU_SAMPLE_OFFICE_COUNT = OFFICES.length

/**
 * 在籍の運転士の数(約 150 人。2026-11-06 に利用者が伝えた数。道北バスはこの在籍で欠員 19 人のとき 10/29 版を運行した)。
 * ボタンを押したとき、在籍の運転士の数が空なら入れる
 */
export const DOHOKU_SAMPLE_ROSTER = 150

/** サンプルのボタンの名前 */
export const DOHOKU_SAMPLE_BUTTON = `道北バスのサンプル(営業所${OFFICES.length}か所・在籍 ${DOHOKU_SAMPLE_ROSTER} 人)を入れる`

export const DOHOKU_SAMPLE_PLACES: readonly PlaceInput[] = OFFICES.map((s) => ({ type: 'office', name: s.name, lat: s.lat, lon: s.lon }))
