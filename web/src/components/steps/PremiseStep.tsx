import StepSection from '@/components/StepSection'
import OperationPremise from '@/components/steps/research/OperationPremise'
import { useGtfsStore } from '@/store/gtfs'

/**
 * 運行の前提の手順(2026-11-07 に利用者の指示で、前提情報の手順から分けた)。
 * 「運行の前提(営業所・運転士の数)」の欄(research/OperationPremise.tsx)だけを置く:在籍の運転士の数・週の出勤日数・
 * 道北バスのサンプルのボタン・営業所(この手順の地図で置ける。map/PlacesLayer.tsx)・勤務の数の推定の仮定。
 * 欠員は減便の方針の手順(policy/ShortageSection.tsx)、周辺の施設の調査は平日便を戻す手順で行う
 */
export default function PremiseStep() {
  const feed = useGtfsStore((s) => s.feed)
  return (
    <StepSection title="2. 運行の前提">
      {!feed ? <p className="text-sm text-muted-foreground">GTFS を読み込むと、営業所と運転士の数を設定できます。</p> : <OperationPremise />}
    </StepSection>
  )
}
