import type { SentLogEntry, SentPart } from '@/store/chat'

function partLabel(p: SentPart): string {
  switch (p.kind) {
    case 'user':
      return '利用者の文'
    case 'screen':
      return '画面の状態・操作の行'
    case 'tool_result':
      return `ツールの結果(${p.toolName ?? '不明'}${p.isError ? '・失敗' : ''})`
    case 'interrupt':
      return '止める'
  }
}

/** 「AI に送る情報」:送るたびに、そのとき送った中身を時刻つきで残したもの(折りたたみ。既定は閉じる) */
export default function SentLog({ entries }: { entries: readonly SentLogEntry[] }) {
  return (
    // 文字の大きさは、入力欄の下の注意(text-[11px])から受け継ぐ
    <details>
      <summary className="cursor-pointer select-none">AI に送る情報({entries.length} 回)</summary>
      {entries.length === 0 ? (
        <p className="mt-1 text-muted-foreground">まだ何も送っていません。</p>
      ) : (
        <ol className="mt-1 flex max-h-40 flex-col gap-2 overflow-y-auto" aria-label="送った情報">
          {entries.map((e) => (
            <li key={e.id} className="rounded-md border px-2 py-1">
              <p className="font-mono text-[10px] text-muted-foreground">{e.at.slice(11, 19)}</p>
              <ul className="flex flex-col gap-1">
                {e.parts.map((p, i) => (
                  <li key={i}>
                    <span className="block text-[10px] font-medium">{partLabel(p)}</span>
                    <pre className="max-h-24 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap">{p.text}</pre>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
