// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'vite'
import { describe, expect, it } from 'vitest'

/**
 * 古い語が画面の文に戻っていないかを確かめる(docs/wording.md の「今の語」の表。指摘13)。
 *
 * テスト以外の web/src のファイルから、文字列・テンプレート・JSX の文字だけを取り出して調べる
 * (コメントと識別子は見ない)。例外は下の ALLOWED に書いたものだけ。
 * 画面の文を直したら、ここも同時に通ること。新しい語を決めたときは RULES に足す。
 */

interface Rule {
  /** 今の語(使わない語) */
  old: string
  /** 代わりに使う語 */
  use: string
  pattern: RegExp
  /** 調べる前に文から取り除く、表に書いてある使い方 */
  allow?: RegExp[]
}

const RULES: Rule[] = [
  { old: '足し戻し', use: '平日に戻す・平日に戻した便', pattern: /足し戻/ },
  { old: '消える・入る・残る(便)', use: 'なくなる便・加わる便・同じ便', pattern: /消える|入る便|残る便|(?:入る|残る) ?[0-9{]/ },
  { old: '外れる(到達圏の前置きなし)', use: '到達圏から外れる', pattern: /(?<!到達圏から)外れ/ },
  { old: '写す元・写した便', use: '入れ替えに使うダイヤ・加わる便', pattern: /写す元|写した/ },
  { old: '基準(の GTFS)', use: '減便前(の GTFS)', pattern: /基準/, allow: [/改善基準告示/] },
  { old: '編集後(の GTFS)', use: '減便後(の GTFS)', pattern: /編集後/ },
  { old: '手がかり', use: '判断材料', pattern: /手がかり/ },
  { old: '比べる日', use: '比較する日付', pattern: /比べる(?:日|平日|減便)/ },
  { old: '○○の確かめ(名詞)', use: '対象便の確認・期間の確認・減便内容の確認', pattern: /(?:対象便|期間|方針|減便内容)の確かめ/ },
  { old: '方針(減便の方針でない単独)', use: '減便の方針', pattern: /(?<!減便の)方針/ },
  { old: '方針を適用・適用した方針', use: '減便の方針を承認する・承認した減便の方針', pattern: /適用した方針|方針を適用(?!でき)|方針の適用/ },
  { old: '減便をやめる版', use: '元のダイヤに戻す版', pattern: /減便をやめる/ },
  { old: '合言葉', use: '認証コード', pattern: /合言葉/ },
  { old: 'あなた', use: '利用者(主語を省く)', pattern: /あなた/ },
  { old: 'バス停', use: '停留所', pattern: /バス停(?!留所)/ },
  { old: '出発(停留所の時刻)', use: '発車', pattern: /出発/ },
  { old: '運行がゼロ', use: '発車がなくなる停留所・便がなくなる系統', pattern: /運行がゼロ/ },
  { old: '到達できる見込みのあるセル', use: '徒歩圏に停留所・駅がある区画', pattern: /到達できる見込み/ },
  { old: 'ダイヤと関係なく外れる', use: '徒歩圏に停留所・駅がない区画', pattern: /ダイヤと関係なく/ },
  { old: 'セル', use: '区画(セル)・区画', pattern: /セル/, allow: [/区画[(（]セル[)）]/, /四方のセル/] },
  { old: '徒歩圏内・徒歩圏から外れる', use: '到達圏', pattern: /徒歩圏内|徒歩圏から外れ/ },
  { old: '新しく生じる発車時刻', use: '新しく加わる発車時刻', pattern: /生じる/ },
  { old: '無い・無く・無くなる', use: 'ない・なく・なくなる', pattern: /無い|無く/ },
  { old: '承認前の下書き', use: '承認待ちの下書き', pattern: /承認前の下書き/ },
  { old: '下書き d1(ID の d)', use: '下書き #1', pattern: /下書き\s?d\d|下書き [0-9]/ },
  { old: 'Claude(AI の呼び方)', use: 'AI', pattern: /Claude/, allow: [/AI[(（]Claude[)）]/, /Built with Claude/, /ClaudeRequestError/] },
]

/** 例外。文が完全に一致するものだけ。理由を添える */
const ALLOWED: { file: string; text: string; reason: string }[] = [
  { file: 'components/chat/ChatMessages.tsx', text: 'あなた', reason: '吹き出しの発言者の名前は「あなた」のまま(利用者の決定 11/3)' },
  { file: 'components/output/NoticeDraft.tsx', text: 'この停留所に残る便:', reason: '「残る」は維持される場合だけに使う(表の規則)。停留所の掲示に残る便' },
]

interface Piece {
  text: string
  line: number
}

interface AstNode {
  type?: string
  start?: number
  value?: unknown
  [key: string]: unknown
}

/** ソースから、画面に出る文(文字列・テンプレートの文字・JSX の文字)を取り出す。コメントと識別子は含まれない */
export function sentencesOf(filename: string, source: string): Piece[] {
  const result = parseSync(filename, source, { lang: filename.endsWith('x') ? 'tsx' : 'ts' })
  const pieces: Piece[] = []
  const lineOf = (pos: number) => source.slice(0, pos).split('\n').length
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    const n = node as AstNode
    let text: string | undefined
    if (n.type === 'Literal' && typeof n.value === 'string') text = n.value
    else if (n.type === 'JSXText' && typeof n.value === 'string') text = n.value
    else if (n.type === 'TemplateElement') text = (n.value as { cooked?: string } | undefined)?.cooked
    if (text !== undefined && text.trim() !== '') pieces.push({ text: text.trim().replace(/\s+/g, ' '), line: lineOf(n.start ?? 0) })
    for (const key of Object.keys(n)) if (key !== 'type') visit(n[key])
  }
  visit(result.program)
  return pieces
}

/** 文に残っている古い語(表に書いた使い方は除く) */
export function oldWordsIn(text: string): Rule[] {
  return RULES.filter((rule) => {
    const rest = (rule.allow ?? []).reduce((s, a) => s.replace(new RegExp(a.source, 'g'), ''), text)
    return rule.pattern.test(rest)
  })
}

const SRC = fileURLToPath(new URL('.', import.meta.url))

function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((p) => p.split('\\').join('/'))
    .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p))
    .sort()
}

describe('古い語が画面の文に残っていない(docs/wording.md)', () => {
  it('調べる対象のファイルを読めている(0 件で素通りしない)', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(80)
    expect(files).toContain('components/steps/RestoreStep.tsx')
    expect(files).toContain('claude/tools.ts')
    expect(files.some((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))).toBe(false)
  })

  it('文字列・テンプレート・JSX の文字だけを調べ、コメントと識別子は調べない', () => {
    const source = [
      '// 足し戻しの説明(コメント)',
      '/* 手がかり */',
      'export const addBackLabel = "足し戻す"',
      'export const ok = `選んだ ${n} 便を平日に戻す`',
      'export const el = <p title="手がかり">基準の GTFS {/* 消える */}</p>',
    ].join('\n')
    const pieces = sentencesOf('sample.tsx', source)
    expect(pieces.map((p) => p.text)).toEqual(['足し戻す', '選んだ', '便を平日に戻す', '手がかり', '基準の GTFS'])
    expect(pieces.find((p) => p.text === '手がかり')!.line).toBe(5)
  })

  it('表の「今の語」を見つけ、表に書いた使い方は見つけない', () => {
    const olds = (text: string) => oldWordsIn(text).map((r) => r.old)
    expect(olds('足し戻した便')).toEqual(['足し戻し'])
    expect(olds('消える 3 便・入る 2 便')).toEqual(['消える・入る・残る(便)'])
    expect(olds('減便で外れた区画')).toEqual(['外れる(到達圏の前置きなし)'])
    expect(olds('減便で到達圏から外れた区画')).toEqual([])
    expect(olds('入れ替えに使うダイヤ(土曜)')).toEqual([])
    expect(olds('土曜のダイヤ(写す元)')).toEqual(['写す元・写した便'])
    expect(olds('改善基準告示')).toEqual([])
    expect(olds('基準の GTFS')).toEqual(['基準(の GTFS)'])
    expect(olds('方針の確かめ').sort()).toEqual(['○○の確かめ(名詞)', '方針(減便の方針でない単独)'].sort())
    expect(olds('減便の方針を承認する')).toEqual([])
    expect(olds('減便の方針を適用できませんでした。')).toEqual([])
    expect(olds('減便の方針を適用します')).toEqual(['方針を適用・適用した方針'])
    expect(olds('徒歩圏に停留所・駅がある区画(セル)')).toEqual([])
    expect(olds('調べた区画(125m 四方のセル)')).toEqual([])
    expect(olds('外れたセル')).toEqual(['外れる(到達圏の前置きなし)', 'セル'])
    expect(olds('下書き d1 を承認')).toEqual(['下書き d1(ID の d)'])
    expect(olds('下書き #1 を承認')).toEqual([])
    expect(olds('AI(Claude)の提案')).toEqual([])
    expect(olds('Claude の提案')).toEqual(['Claude(AI の呼び方)'])
    expect(olds('復旧の見込み')).toEqual([])
    expect(olds('バス停留所(P11)')).toEqual([])
    expect(olds('近くのバス停')).toEqual(['バス停'])
  })

  it('テスト以外の web/src のファイルの文に、古い語がない(例外は ALLOWED だけ)', () => {
    const found: string[] = []
    const used = new Set<number>()
    for (const file of sourceFiles()) {
      const pieces = sentencesOf(file, readFileSync(SRC + file, 'utf-8'))
      for (const piece of pieces) {
        const rules = oldWordsIn(piece.text)
        if (rules.length === 0) continue
        const index = ALLOWED.findIndex((a) => a.file === file && a.text === piece.text)
        if (index >= 0) {
          used.add(index)
          continue
        }
        for (const rule of rules) found.push(`${file}:${piece.line} 「${rule.old}」→「${rule.use}」 ${piece.text.slice(0, 60)}`)
      }
    }
    expect(found).toEqual([])
    // 使っていない例外は消す(戻らないようにする確かめが緩まないように)
    expect(ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.text}`)).toEqual([])
  })
})
