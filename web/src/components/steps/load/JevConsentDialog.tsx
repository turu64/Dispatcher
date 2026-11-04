import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useServiceGroupsStore } from '@/store/serviceGroups'
import {
  JEV_CONSENT_ACCEPT,
  JEV_CONSENT_DECLINE,
  JEV_CONSENT_TITLE,
  JEV_ROUTING_NOTE,
  JEV_SENT_SCOPE,
  jevConsentLead,
  jevOmittedText,
} from './serviceGroupsText'

/**
 * 規則で決まらない service があるとき、Jev に送るかを読み込みのたびに聞く(指摘14。docs/tasks-1105.md の U02)。
 * 答えるまで送らない。最初の焦点は「送らずに規則だけで進める」(取り消し)に来て、Escape も送らない側に倒す。
 * 「今後は聞かない」は付けない(ブラウザに保存しない決定のため、読み込みのたびに聞く)。
 * 閉じたら、焦点を Jev の欄の知らせ(focusId)に移す(答えの結果がそこに出る)
 */
export default function JevConsentDialog({ focusId }: { focusId: string }) {
  const state = useServiceGroupsStore((s) => s.jev.state)
  const asking = useServiceGroupsStore((s) => s.jev.asking)
  const omitted = useServiceGroupsStore((s) => s.jev.omitted.length)
  const acceptJev = useServiceGroupsStore((s) => s.acceptJev)
  const declineJev = useServiceGroupsStore((s) => s.declineJev)
  const omittedText = jevOmittedText(omitted)
  return (
    <AlertDialog
      open={state === 'awaitingConsent'}
      onOpenChange={(open) => {
        // Escape・「送らずに…」で閉じたら送らない。「Jev に送る」で閉じたときは acceptJev が先に状態を進めているので、declineJev は何もしない
        if (!open) declineJev()
      }}
    >
      <AlertDialogContent
        className="data-[size=default]:sm:max-w-lg"
        onCloseAutoFocus={(e) => {
          const target = document.getElementById(focusId)
          if (target) {
            e.preventDefault()
            target.focus()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{JEV_CONSENT_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{jevConsentLead(asking)}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 text-xs text-muted-foreground" data-testid="jev-consent-details">
          <p>{JEV_SENT_SCOPE}</p>
          <p>{JEV_ROUTING_NOTE}</p>
          {omittedText && <p>{omittedText}</p>}
          <p>送らない場合も、規則だけで分けて進められます。あとから「Jev に問い合わせる」で送ることもできます。</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{JEV_CONSENT_DECLINE}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void acceptJev()}>{JEV_CONSENT_ACCEPT}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
