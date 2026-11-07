/** 表の1行をセルに分ける(前後の「|」を除く。「\|」はセルの中の「|」)。simpleMarkdown.tsx の表で使う */
export function splitTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}
