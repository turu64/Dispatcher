import StepSection from '@/components/StepSection'
import { useGtfsStore } from '@/store/gtfs'

/**
 * 手順2:前提情報(仮)。停留所の分布の外周 +2km にある周辺の事業者・学校・病院を洗い出し、Web で調べる手順。
 * 中身は docs/tasks-1103.md の T16 で作る。それまでは、この手順で何をするかだけを出す
 */
export default function ResearchStep() {
  const feed = useGtfsStore((s) => s.feed)
  return (
    <StepSection title="2. 前提情報">
      {!feed ? (
        <p className="text-sm text-muted-foreground">GTFS を読み込むと、周辺の事業者・学校・病院を調べられます。</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          停留所の周りの事業者・学校・病院を調べ、減便で守る需要の手がかりにする手順です(準備中)。この手順を飛ばして、次の「減便の方針」へ進めます。
        </p>
      )}
    </StepSection>
  )
}
