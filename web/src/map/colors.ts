/**
 * 到達圏の色分けに使う色。
 *
 * 色の見分けがつきにくい人(赤と緑の区別がつきにくい P型・D型、青と黄の区別がつきにくい T型)にも
 * 区別できるよう、Okabe-Ito の配色(Okabe & Ito, 2008)から、
 * 色相が大きく離れた「青」と「橙」の組み合わせを選んでいる。
 *
 * - 「徒歩圏から外れる」を赤や橙〜赤系にしない。地図の凡例によくある「緑と赤」「橙と赤」は、
 *   P型・D型では明るさも近く、ほとんど同じ色に見える。
 * - 青(明度 L* 約 46)と橙(L* 約 71)は明るさにも差があるので、白黒で印刷しても区別できる。
 * - 色だけに頼らない。凡例や数字(割合・セルの数)も必ず併記する。
 * - 地図の上に半透明で重ねると見分けにくくなるため、塗りの不透明度は REACH_FILL_OPACITY 以上にする。
 *
 * 色の差は colors.test.ts で、色覚シミュレーション(Machado ら, 2009)をかけたうえで確かめている。
 */

/** 徒歩圏の内外 */
export const REACH_COLORS = {
  /** 徒歩圏内:青 */
  reachable: '#0072B2',
  /** 徒歩圏から外れる:橙 */
  unreachable: '#E69F00',
} as const

/** 到達圏のセルを塗るときの不透明度(背景の地図が透けて見える程度) */
export const REACH_FILL_OPACITY = 0.55

/**
 * 地域の区分(都市部・郊外・中山間・地方)。
 * 順序のある区分なので、色相ではなく明るさで区別する(都市部が最も暗い)。
 * 区分の種類は reach/reach.ts の RegionClass と同じ(依存を避けるため、ここでは書き写している)。
 */
export type RegionKey = 'urban' | 'suburban' | 'rural'

export const REGION_COLORS: Record<RegionKey, string> = {
  urban: '#4D4D4D',
  suburban: '#999999',
  rural: '#E0E0E0',
}

/**
 * 停留所・駅の表示。
 * 「その時間帯に出発がある」かどうかは、色ではなく塗りの有無(塗りつぶし/白抜き)でも区別できるようにする。
 */
export const STOP_COLORS = {
  /** その時間帯に出発がある停留所:黒の塗り */
  active: '#1A1A1A',
  /** 出発がない停留所:白抜き */
  inactive: '#FFFFFF',
  /** 縁取り(地図の上でも見えるように白と黒の両方) */
  stroke: '#1A1A1A',
  halo: '#FFFFFF',
} as const
