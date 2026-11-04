import { useState } from 'react'
import { ArrowRight, Check, CircleAlert, CircleMinus, CirclePause, FileText, Info, Loader2, Sparkles, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { describeRecord } from '@/components/steps/editText'
import { jumpToStep } from '@/components/steps/stepIds'
import { useChatStore, type ChatItem } from '@/store/chat'
import { draftName, useEditStore, type Draft } from '@/store/edit'
import { askRestoreBlockedReason, type ChatStoreHook } from './chatStatus'
import SimpleMarkdown from './simpleMarkdown'
import { stepTitle } from './stepLabel'

const DONE_LABELS: Record<string, string> = {
  apply_policy: '減便の方針の下書きを作りました',
  add_back_trips: '便を平日に戻す下書きを作りました',
  undo_edit: '元に戻す下書きを作りました',
  summarize_impact: '影響を計算しました',
  search_trips: '便を探しました',
  run_validation: '検証しました',
  get_research_targets: '調査の対象を読みました',
  get_research_results: '調査の結果を読みました',
  save_research: '調査の結果を保存しました',
}

function stripEllipsis(label: string): string {
  return label.replace(/…$/, '')
}

/** AI の発言の印(左の丸いアイコン)。飾りなので読み上げない(名前「AI」は文字で出す) */
export function AiAvatar() {
  return (
    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
      <Sparkles className="size-3.5" />
    </span>
  )
}

/**
 * 入力中を示す3つの点。飾りなので読み上げない(読み上げは隣の role="status" の文)。
 * 動きを減らす設定(prefers-reduced-motion)では動かさない
 */
const DOT_DELAYS = ['-0.3s', '-0.15s', '0s'] as const

export function TypingDots({ className = '' }: { className?: string }) {
  // 弾む動き(translateY(-25%))は動かす要素の高さに比例するので、点(6px)より高い箱を動かして、点が 4px ほど上下するようにする。
  // ずらし(animation-delay)は style で渡す(クラスで渡すと、motion-safe の animation の一括指定で 0s に戻るため)
  return (
    <span aria-hidden="true" data-slot="typing-dots" className={`inline-flex items-center gap-1 ${className}`}>
      {DOT_DELAYS.map((delay) => (
        <span key={delay} className="flex h-4 items-center motion-safe:animate-bounce" style={{ animationDelay: delay }}>
          <span className="size-1.5 rounded-full bg-current opacity-70" />
        </span>
      ))}
    </span>
  )
}

/** ツールの動きの1行。状態はアイコンと色と文字で示す(色だけに頼らない) */
function ToolLine({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  if (item.status === 'running') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span className="min-w-0 break-words">{item.label}</span>
      </p>
    )
  }
  if (item.status === 'done') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
        <span className="min-w-0 break-words">{DONE_LABELS[item.name] ?? stripEllipsis(item.label)}</span>
      </p>
    )
  }
  const failed = item.status === 'error'
  const Icon = failed ? CircleAlert : CircleMinus
  return (
    <p className={`flex items-center gap-1.5 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {stripEllipsis(item.label)}({failed ? 'うまくいきませんでした' : '行いませんでした'})
      </span>
    </p>
  )
}

/**
 * 承認待ちの下書きの中身の1行の要約(数はコードが出したもの)。
 * 便数の差(減便前と比べた平日のなくなる便・加わる便)は、減便の方針の下書きにだけ添える
 * (ほかの下書きの diff は、その下書きで変わる分ではなく、承認後の全体の差のため)
 */
function draftSummary(draft: Draft): string {
  if (draft.kind === 'undo') return '編集を取り消す(元に戻す)'
  const op = draft.record.op
  if (op.type === 'addBack') return `便を平日に戻す:${op.items.length} 便`
  if (op.type === 'withdrawAddBack') return `平日に戻す操作を取り消す:${op.tripIds.length} 便`
  const head = describeRecord(draft.record)
  return draft.diff ? `${head}。平日のなくなる便 ${draft.diff.removed.length} 便・加わる便 ${draft.diff.added.length} 便` : head
}

/**
 * 下書きの知らせ。名前(「下書き #1」)、承認待ちならその中身の要約、「編集で確かめる」ボタン。
 * 「編集で確かめる」は左の欄を「編集」のタブにして、下書きを承認する手順を開く(AI が下書きを作っても、タブは勝手に切り替えない)
 */
function DraftCard({ item }: { item: Extract<ChatItem, { kind: 'draft' }> }) {
  const pending = useEditStore((s) => (s.draft !== null && s.draft.id === item.draftId ? s.draft : null))
  return (
    <Card size="sm" className="gap-2 py-3 ring-primary/25">
      <CardHeader className="gap-1">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileText className="size-3.5" />
          </span>
          {/* 名前は下の文(「下書き #1 を作りました…」)にもあるので、読み上げでは二重にしない */}
          <span aria-hidden="true">{draftName(item.draftId)}</span>
          {pending && (
            <Badge variant="secondary" className="text-[10px]">
              承認待ち
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs break-words">{item.text}</CardDescription>
      </CardHeader>
      {pending && (
        <CardContent>
          <p className="rounded-md bg-muted/60 px-2 py-1.5 text-xs break-words">{draftSummary(pending)}</p>
        </CardContent>
      )}
      <CardFooter className="flex-wrap gap-x-3 gap-y-1.5 border-t-0 bg-transparent pt-1">
        <Button type="button" size="sm" aria-describedby={`draft-step-${item.id}`} onClick={() => jumpToStep(item.step)}>
          編集で確かめる
          <ArrowRight data-icon="inline-end" aria-hidden="true" />
        </Button>
        <span id={`draft-step-${item.id}`} className="text-xs text-muted-foreground">
          開く手順:{stepTitle(item.step) ?? '下書きの手順'}
        </span>
      </CardFooter>
    </Card>
  )
}

/**
 * AI がツールを使いすぎてサーバーが止めた知らせ(1回の発言につき1件)と、「続きを頼む」ボタン(指摘15.2)。
 * 押すと「続けてください。」を送る。送れないとき(送っている・ツールを実行している・予算に達したなど)は押せず、理由を出す。
 * 続きを頼んだ後はボタンを出さない
 */
function StoppedCard({ item, store }: { item: Extract<ChatItem, { kind: 'stopped' }>; store: ChatStoreHook }) {
  const reason = store((s) => askRestoreBlockedReason(s))
  const [pending, setPending] = useState(false)
  return (
    <Alert className="border-primary/25 bg-primary/5 px-3 py-2 text-xs">
      <CirclePause aria-hidden="true" />
      <AlertDescription className="flex flex-col items-start gap-1.5 text-xs break-words text-foreground">
        <span>{item.text}</span>
        {item.continued ? (
          <span className="text-muted-foreground">続きを頼みました。</span>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={reason !== null}
              loading={pending}
              loadingLabel="送信中"
              onClick={() => {
                setPending(true)
                void store
                  .getState()
                  .continueStopped()
                  .finally(() => setPending(false))
              }}
            >
              続きを頼む
            </Button>
            {reason !== null && !pending && <span className="text-muted-foreground">{reason}</span>}
          </>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * 発言の並び。利用者の文、AI の返答、ツールの動き、下書きの知らせ(「編集で確かめる」ボタンつき)、知らせ、エラー、
 * 止めた知らせ(「続きを頼む」ボタンつき)。store は「続きを頼む」で送る先(テストでは別の store を渡す)
 */
export default function ChatMessages({ items, store = useChatStore }: { items: readonly ChatItem[]; store?: ChatStoreHook }) {
  // 入力中の点は、最後の発言が流れている返答のときだけ、その吹き出しに出す
  // (返答の途中でツールの行が加わったときは、下の「考えています…」の行にだけ出し、点を二重にしない)
  const lastIndex = items.length - 1
  return (
    <ul className="flex flex-col gap-3" aria-label="会話">
      {items.map((item, index) => {
        switch (item.kind) {
          case 'user':
            return (
              <li key={item.id} data-kind="user" className="flex flex-col items-end gap-0.5 pl-8">
                <span className="px-1 text-[11px] text-muted-foreground">あなた</span>
                <p className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-primary-foreground">
                  {item.text}
                </p>
              </li>
            )
          case 'assistant':
            return (
              <li key={item.id} data-kind="assistant" className="flex items-start gap-2 pr-2">
                <AiAvatar />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">AI</span>
                  {/* 短い返答は短い吹き出しにする(列の幅いっぱいに伸ばさない) */}
                  <div className="w-fit max-w-full min-w-0 rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm">
                    <SimpleMarkdown text={item.text} />
                    {item.streaming && index === lastIndex && <TypingDots className="mt-1 text-muted-foreground" />}
                  </div>
                </div>
              </li>
            )
          case 'tool':
            return (
              <li key={item.id} data-kind="tool" className="pl-9">
                <ToolLine item={item} />
              </li>
            )
          case 'draft':
            return (
              <li key={item.id} data-kind="draft" className="pl-9">
                <DraftCard item={item} />
              </li>
            )
          case 'notice':
            return (
              <li key={item.id} data-kind="notice" className="flex items-start gap-1.5 px-2 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{item.text}</span>
              </li>
            )
          case 'stopped':
            return (
              <li key={item.id} data-kind="stopped">
                <StoppedCard item={item} store={store} />
              </li>
            )
          case 'error':
            return (
              <li key={item.id} data-kind="error">
                <Alert variant="destructive" className="border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription className="text-xs break-words">{item.text}</AlertDescription>
                </Alert>
              </li>
            )
        }
      })}
    </ul>
  )
}
