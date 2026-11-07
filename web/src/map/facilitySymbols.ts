/**
 * 平日便を戻す手順の地図に出す施設の記号(国土地理院の地図記号に合わせた形と、種類ごとの色)。
 *
 * 国土地理院の「地図記号一覧」(電子地形図25000。https://www.gsi.go.jp/kohokocho/map-sign-tizukigou-2022-itiran.html)で
 * 2026-11-03 に確かめた結果:
 * - 専用の記号がある:小・中学校(「文」)、高等学校(丸で囲んだ「文」)、病院(下がとがった盾形の枠の中に十字。旧陸軍の衛生隊の印が由来)
 * - 専用の記号が無い:大学、短期大学、高等専門学校、専修学校、各種学校、特別支援学校(盲学校・聾学校・養護学校)、診療所、バス停留所
 *   (幼稚園・認定こども園も無い。国土地理院の一覧は小・中学校と高等学校だけ)
 * - 無い種類の扱い
 *   - 特別支援学校・中等教育学校:高等学校の記号を使う(重要拠点の「高校・特別支援学校」と同じまとまり)
 *   - 大学・短期大学・高専・専修学校・各種学校:「文」を四角で囲んだ Dispatcher 独自の形(「文」の学校の記号に枠を添える)
 *   - 診療所:角を丸めた四角の中に小さな十字を置いた Dispatcher 独自の形。丸の中に十字は国土地理院の保健所の記号と同じ形なので
 *     避けた(地図記号を知っている人に、診療所が保健所に見えないように)。病院の盾形とも形で分かれる
 *   - ほかの事業者の停留所:小さなひし形の Dispatcher 独自の形
 *   - 学校の種別が分からないもの:小・中学校の「文」の記号を使う(近い記号)。
 *     小学校・中学校・義務教育学校と幼稚園・認定こども園は周辺の施設の調査の対象外で読み込まない(2026-11-06 に利用者が決定。ref/facilities.ts の
 *     EXCLUDED_SCHOOL_TYPES)ので、この記号は種別が分からない学校にだけ使う
 *   独自の形は、凡例に「(独自の記号)」と出す
 *
 * 記号の形は、この文書の path で自分で描いた(国土地理院の画像を写していない)。
 * 色は Okabe-Ito の配色を施設の種類ごとに残す(学校は緑、病院は橙、診療所は桃、バス事業者は空色)。
 * 形でも区別するので、色だけに頼らない。同じ path を地図の画像(SVG の文字列 → Image → map.addImage)と
 * 凡例・一覧の記号(React の svg)の両方に使う
 */
import type { FacilityKind } from '@/ref/facilities'

/** 記号の種類(地図記号の1種類につき1つ) */
export type FacilitySymbolKind = 'school-basic' | 'school-high' | 'school-higher' | 'hospital' | 'clinic' | 'busstop'

export const FACILITY_SYMBOL_KINDS: readonly FacilitySymbolKind[] = ['hospital', 'clinic', 'school-basic', 'school-high', 'school-higher', 'busstop']

/** 記号の色(Okabe-Ito の配色。施設の種類ごと) */
export const FACILITY_COLORS: Record<FacilityKind, string> = {
  hospital: '#D55E00',
  clinic: '#CC79A7',
  school: '#009E73',
  operator: '#56B4E9',
}

/** 高等学校の記号を使う学校の種別(ref/facilities.ts の HIGH_SCHOOL_TYPES と同じ。FacilityLayer.test.tsx で食い違いを確かめる) */
const HIGH_TYPES: ReadonlySet<string> = new Set(['高等学校', '特別支援学校', '中等教育学校'])
/** 独自の「四角で囲んだ文」を使う学校の種別(同 HIGHER_EDUCATION_TYPES) */
const HIGHER_TYPES: ReadonlySet<string> = new Set(['大学', '短期大学', '高等専門学校', '専修学校', '各種学校'])

/** 施設の種類と学校の種別から、記号の種類を決める */
export function facilitySymbolKind(kind: FacilityKind, schoolType?: string): FacilitySymbolKind {
  switch (kind) {
    case 'hospital':
      return 'hospital'
    case 'clinic':
      return 'clinic'
    case 'operator':
      return 'busstop'
    case 'school':
      if (schoolType && HIGH_TYPES.has(schoolType)) return 'school-high'
      if (schoolType && HIGHER_TYPES.has(schoolType)) return 'school-higher'
      return 'school-basic'
  }
}

/** 記号の色(施設の種類から) */
export function facilitySymbolColor(symbol: FacilitySymbolKind): string {
  return FACILITY_COLORS[symbolFacilityKind(symbol)]
}

function symbolFacilityKind(symbol: FacilitySymbolKind): FacilityKind {
  switch (symbol) {
    case 'hospital':
      return 'hospital'
    case 'clinic':
      return 'clinic'
    case 'busstop':
      return 'operator'
    default:
      return 'school'
  }
}

/** 凡例に出す名前 */
export const FACILITY_SYMBOL_LABELS: Record<FacilitySymbolKind, string> = {
  'school-basic': '学校(種別が分からないもの)',
  'school-high': '高校・特別支援学校',
  'school-higher': '大学・高専・専修学校(独自の記号)',
  hospital: '病院',
  clinic: '診療所(独自の記号)',
  // 停留所の1つずつの記号は T32 でほかの事業者の停留所に替える。それまでは事業者の重心の位置に使う
  busstop: 'バス事業者(独自の記号)',
}

/** 国土地理院の地図記号に専用の形があるか(false は Dispatcher 独自の形) */
export const FACILITY_SYMBOL_IS_GSI: Record<FacilitySymbolKind, boolean> = {
  'school-basic': true,
  'school-high': true,
  'school-higher': false,
  hospital: true,
  clinic: false,
  busstop: false,
}

/** 地図の画像の id の前に付ける文字(レイヤーの icon-image が、図形の symbol の値とつないで画像を引く) */
export const FACILITY_IMAGE_PREFIX = 'research-facility-'

/** 地図の画像の id */
export function facilitySymbolId(symbol: FacilitySymbolKind): string {
  return `${FACILITY_IMAGE_PREFIX}${symbol}`
}

/** 記号の1つの図形(path)。座標は 24 × 24 の枠の中 */
export interface SymbolPart {
  d: string
  fill: string
  stroke: string
  strokeWidth: number
}

const DARK = '#1a1a1a'
const WHITE = '#ffffff'
const NONE = 'none'

function n(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/**
 * 「文」の字形(点・横画・交差する2本)。(cx, cy) を中心に、高さ 16 × s の大きさで描く。
 * 縁取り(白)の上に色の線を重ねるので、2つの part を返す
 */
function glyph(cx: number, cy: number, s: number, color: string, width: number, halo: number): SymbolPart[] {
  const p = (x: number, y: number) => `${n(cx + x * s)} ${n(cy + y * s)}`
  const d = [
    `M${p(0, -8)}L${p(0, -5.2)}`, // 点
    `M${p(-7, -3)}L${p(7, -3)}`, // 横画
    `M${p(-4.2, -3)}L${p(6.4, 8)}`, // 左上から右下
    `M${p(4.2, -3)}L${p(-6.4, 8)}`, // 右上から左下
  ].join('')
  const parts: SymbolPart[] = []
  if (halo > 0) parts.push({ d, fill: NONE, stroke: WHITE, strokeWidth: halo })
  parts.push({ d, fill: NONE, stroke: color, strokeWidth: width })
  return parts
}

/** 円の path(中心 cx, cy、半径 r) */
function circlePath(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`
}

/** 記号を構成する図形(下から順に重ねる)。形の説明は各 case のコメント */
export function facilitySymbolParts(symbol: FacilitySymbolKind): SymbolPart[] {
  const color = facilitySymbolColor(symbol)
  switch (symbol) {
    case 'school-basic':
      // 国土地理院の小・中学校の記号の「文」(種別が分からない学校に使う)。地図の上でも読めるよう白で縁取る
      return glyph(12, 12, 1.1, color, 3, 6)
    case 'school-high':
      // 高等学校:丸で囲んだ「文」
      return [{ d: circlePath(12, 12, 10.5), fill: WHITE, stroke: color, strokeWidth: 2.2 }, ...glyph(12, 12, 0.68, color, 2.1, 0)]
    case 'school-higher':
      // 独自:四角で囲んだ「文」
      return [{ d: 'M2.5 2.5H21.5V21.5H2.5Z', fill: WHITE, stroke: color, strokeWidth: 2.2 }, ...glyph(12, 12, 0.68, color, 2.1, 0)]
    case 'hospital':
      // 病院:下がとがった盾形の枠(白地に種類の色の縁)の中に十字(種類の色で塗る)
      return [
        { d: 'M3 2.5H21V14L12 22L3 14Z', fill: WHITE, stroke: color, strokeWidth: 2.2 },
        { d: 'M10.25 5.5H13.75V8.75H17V12.25H13.75V15.5H10.25V12.25H7V8.75H10.25Z', fill: color, stroke: NONE, strokeWidth: 0 },
      ]
    case 'clinic':
      // 独自:角を丸めた四角の中に小さな十字(丸に十字は保健所の記号なので使わない)
      return [
        { d: 'M6.5 3H17.5Q21 3 21 6.5V17.5Q21 21 17.5 21H6.5Q3 21 3 17.5V6.5Q3 3 6.5 3Z', fill: color, stroke: DARK, strokeWidth: 1.5 },
        { d: 'M12 7.5V16.5M7.5 12H16.5', fill: NONE, stroke: WHITE, strokeWidth: 2.8 },
      ]
    case 'busstop':
      // 独自:小さなひし形
      return [{ d: 'M12 3L21 12L12 21L3 12Z', fill: color, stroke: DARK, strokeWidth: 1.6 }]
  }
}

function partsMarkup(parts: readonly SymbolPart[]): string {
  return parts
    .map((p) => `<path d="${p.d}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('')
}

/** 記号の SVG の文字列(size は画素の大きさ。地図に足す Image のもと) */
export function facilitySymbolSvg(symbol: FacilitySymbolKind, size = 48): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${partsMarkup(facilitySymbolParts(symbol))}</svg>`
}
