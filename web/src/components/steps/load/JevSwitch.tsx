import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useServiceGroupsStore } from '@/store/serviceGroups'
import { JEV_DESTINATION, JEV_ROUTING_NOTE, JEV_SENT_SCOPE } from './serviceGroupsText'

/**
 * Jev に送るかのスイッチ(docs/design-service-groups.md §3.6)。読み込みの手順の、ファイルを選ぶ欄の上に置く。
 * 読み込んだ後に自動で送るので、送る前に効く所に置く。値は store に持ち、ブラウザには保存しない
 */
export default function JevSwitch({ disabled = false }: { disabled?: boolean }) {
  const jevEnabled = useServiceGroupsStore((s) => s.jevEnabled)
  const setJevEnabled = useServiceGroupsStore((s) => s.setJevEnabled)
  return (
    <div className="flex items-start gap-2">
      <Switch
        id="jev-switch"
        className="mt-0.5"
        checked={jevEnabled}
        disabled={disabled}
        onCheckedChange={setJevEnabled}
        aria-describedby="jev-switch-note"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor="jev-switch" className="leading-snug font-normal">
          service_id の分け方が単純でない GTFS では、service ごとの集計を {JEV_DESTINATION}に送って、ダイヤの分け方を確かめる
        </Label>
        <p id="jev-switch-note" className="text-xs text-muted-foreground">
          分け方が単純な GTFS(道北バスなど)では送りません。
          {JEV_SENT_SCOPE}
          {JEV_ROUTING_NOTE}
        </p>
      </div>
    </div>
  )
}
