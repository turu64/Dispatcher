import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { jumpToStep, type StepKey } from '@/components/steps/stepIds'
import type { ChatItem } from '@/store/chat'
import SimpleMarkdown from './simpleMarkdown'

const DONE_LABELS: Record<string, string> = {
  apply_policy: '方針の下書きを作りました',
  add_back_trips: '足し戻しの下書きを作りました',
  undo_edit: '元に戻す下書きを作りました',
  summarize_impact: '影響を計算しました',
  search_trips: '便を探しました',
  run_validation: '検証しました',
  get_research_targets: '調査の対象を読みました',
  get_research_results: '調査の結果を読みました',
  save_research: '調査の結果を保存しました',
}

const STEP_BUTTONS: Record<StepKey, string> = { policy: '手順2へ移る', restore: '手順5へ移る' }

function stripEllipsis(label: string): string {
  return label.replace(/…$/, '')
}

function ToolLine({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  if (item.status === 'running') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
        {item.label}
      </p>
    )
  }
  if (item.status === 'done') {
    return (
      <p className="text-xs text-muted-foreground">
        <span aria-hidden="true">✓ </span>
        {DONE_LABELS[item.name] ?? stripEllipsis(item.label)}
      </p>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      <span aria-hidden="true">{item.status === 'error' ? '! ' : '− '}</span>
      {stripEllipsis(item.label)}({item.status === 'error' ? 'うまくいきませんでした' : '行いませんでした'})
    </p>
  )
}

/** 発言の並び。利用者の文、AI の返答、ツールの動き、下書きの知らせ(手順へ移るボタンつき)、知らせ、エラー */
export default function ChatMessages({ items }: { items: readonly ChatItem[] }) {
  return (
    <ul className="flex flex-col gap-2" aria-label="会話">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <li key={item.id} data-kind="user" className="ml-6 rounded-md bg-primary/10 px-2 py-1.5 text-sm break-words whitespace-pre-wrap">
                <span className="mb-0.5 block text-[10px] text-muted-foreground">あなた</span>
                {item.text}
              </li>
            )
          case 'assistant':
            return (
              <li key={item.id} data-kind="assistant" className="mr-3 rounded-md border px-2 py-1.5 text-sm">
                <span className="mb-0.5 block text-[10px] text-muted-foreground">AI</span>
                <SimpleMarkdown text={item.text} />
              </li>
            )
          case 'tool':
            return (
              <li key={item.id} data-kind="tool">
                <ToolLine item={item} />
              </li>
            )
          case 'draft':
            return (
              <li key={item.id} data-kind="draft" className="flex flex-col gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs">
                <p className="break-words">{item.text}</p>
                <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => jumpToStep(item.step)}>
                  {STEP_BUTTONS[item.step]}
                </Button>
              </li>
            )
          case 'notice':
            return (
              <li key={item.id} data-kind="notice" className="border-l-2 pl-2 text-xs break-words text-muted-foreground">
                {item.text}
              </li>
            )
          case 'error':
            return (
              <li key={item.id} data-kind="error" role="alert" className="rounded-md border border-destructive/50 bg-destructive/5 px-2 py-1 text-xs break-words text-destructive">
                <span aria-hidden="true">✕ </span>
                {item.text}
              </li>
            )
        }
      })}
    </ul>
  )
}
