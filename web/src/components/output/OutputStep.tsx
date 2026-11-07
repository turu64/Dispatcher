import { useState, type ComponentType } from 'react'
import ExportStep from '@/components/steps/ExportStep'
import { StepTitleContext, stripStepNumber, useStepTitle } from '@/components/layout/stepTitle'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ChangeOrder from './ChangeOrder'
import NoticeDraft from './NoticeDraft'
import StopChangesTable from './StopChangesTable'

/** 出力のタブ。GTFS(ExportStep)・変更指示書・周知文・停留所の一覧 */
const OUTPUT_TABS: readonly { key: string; label: string; component: ComponentType }[] = [
  { key: 'gtfs', label: 'GTFS', component: ExportStep },
  { key: 'changeOrder', label: '変更指示書', component: ChangeOrder },
  { key: 'notice', label: '周知文', component: NoticeDraft },
  { key: 'stops', label: '停留所の一覧', component: StopChangesTable },
]

/**
 * 手順「出力」の入れ物。タブで GTFS・変更指示書・周知文・停留所の一覧を切り替える。
 * タブの中身は消さずに隠す(出力した ZIP の知らせや、書きかけの欄を残すため)。
 * タブの中の見出しは番号を付けない(「GTFS を出力」など)
 */
export default function OutputStep() {
  const title = useStepTitle('7. 出力')
  const [tab, setTab] = useState(OUTPUT_TABS[0].key)
  return (
    <section aria-labelledby="step-output-heading" className="flex flex-col gap-3">
      <h2 id="step-output-heading" className="px-1 text-base font-medium">
        {title}
      </h2>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="出力の種類" className="print-hide">
          {OUTPUT_TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <StepTitleContext.Provider value={stripStepNumber}>
          {OUTPUT_TABS.map((t) => (
            <TabsContent key={t.key} value={t.key} forceMount hidden={t.key !== tab}>
              <t.component />
            </TabsContent>
          ))}
        </StepTitleContext.Provider>
      </Tabs>
    </section>
  )
}
