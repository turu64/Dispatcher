/**
 * 一覧を、1つあたり limit 件以下になるよう、最大 maxParts 個に等分する(limit 件以下なら分けない。
 * maxParts 個で足りなければ、1つあたりが limit を超える)。印刷で横に並べて1枚に収めるため(変更指示書)
 */
export function splitParts<T>(items: readonly T[], limit: number, maxParts: number): T[][] {
  const parts = Math.min(maxParts, Math.max(1, Math.ceil(items.length / limit)))
  const size = Math.ceil(items.length / parts)
  const out: T[][] = []
  for (let i = 0; i < parts; i++) out.push(items.slice(i * size, (i + 1) * size))
  return out
}

/** 印刷で横に並べる列の数ごとの段組み(Tailwind がクラス名を拾えるよう、文字列をそのまま書く) */
export const PRINT_COLS: Readonly<Record<number, string>> = { 1: '', 2: 'print:grid-cols-2', 3: 'print:grid-cols-3' }
