import { describe, expect, it } from 'vitest'
import type { ResearchResult } from '@/claude/research'
import { HOSPITAL_TIME_MISSING, SCHOOL_TIME_MISSING, researchSummary, resultHighlights } from './highlights'

function result(kind: ResearchResult['kind'], facts: ResearchResult['facts'], sources = 2): ResearchResult {
  return {
    targetId: `T:${kind}`,
    kind,
    name: 'テスト',
    status: 'found',
    facts,
    sources: Array.from({ length: sources }, (_, i) => ({ url: `https://example.jp/${i + 1}`, title: `出典${i + 1}` })),
    note: '',
    checkedAt: '2026-11-06T10:00:00+09:00',
    origin: 'web',
  }
}

describe('resultHighlights', () => {
  it('病院は、判断材料と同じ読み方で外来の受付の時刻を出し、着く・出るの同じ文は1つにまとめる。出典の番号も持つ', () => {
    const h = resultHighlights(
      result('hospital', [
        { label: '電話', value: '0166-00-0000', source: 1 },
        { label: '外来受付時間', value: '〔午前〕8：00～11：30 〔午後〕13：00～15：15', source: 2 },
        { label: '最寄りバス停', value: '「市立病院前」から徒歩1分', source: 1 },
      ]),
    )
    expect(h.times).toEqual([{ text: '外来の受付 8:00〜11:30・13:00〜15:15', source: 2 }])
    expect(h.timeMissing).toBeNull()
    expect(h.access?.value).toBe('「市立病院前」から徒歩1分')
  })

  it('学校は始業・終業を別々に出す。読めなければ既定の時間帯で数えることを書く', () => {
    const h = resultHighlights(
      result('school', [
        { label: '始業', value: '8時40分', source: 1 },
        { label: '下校', value: '15時30分', source: 1 },
      ]),
    )
    expect(h.times.map((t) => t.text)).toEqual(['始業 8:40', '終業 15:30'])
    const none = resultHighlights(result('school', [{ label: '所在地', value: '旭川市', source: 1 }]))
    expect(none.times).toEqual([])
    expect(none.timeMissing).toBe(SCHOOL_TIME_MISSING)
    expect(SCHOOL_TIME_MISSING).toContain('着く 7〜9時・出る 14〜18時')
    expect(resultHighlights(result('clinic', [])).timeMissing).toBe(HOSPITAL_TIME_MISSING)
  })

  it('バスの案内は最寄りの停留所の事実を先に選び、減便などの動きの事実は選ばない。範囲の外の出典の番号は null', () => {
    const h = resultHighlights(
      result('hospital', [
        { label: '減便・ダイヤ改正等のバス情報', value: '確認できず', source: 1 },
        { label: 'バス系統(地図サイト)', value: '38番', source: 1 },
        { label: '最寄りのバス停留所', value: '「曙1条2丁目」', source: 9 },
      ]),
    )
    expect(h.access?.label).toBe('最寄りのバス停留所')
    const t = resultHighlights(result('hospital', [{ label: '外来の受付', value: '8:30〜11:00', source: 9 }]))
    expect(t.times).toEqual([{ text: '外来の受付 8:30〜11:00', source: null }])
  })

  it('事業者の結果は時刻を読まない', () => {
    expect(resultHighlights(result('operator', [{ label: '外来の受付', value: '8:30〜11:00', source: 1 }]))).toEqual({ times: [], timeMissing: null, access: null })
  })
})

describe('researchSummary', () => {
  it('種類ごとに結果の数と、時刻を読めた(事業者は動きがある)数を数え、結果の無い種類は出さない', () => {
    const rows = researchSummary([
      result('hospital', [{ label: '外来の受付', value: '8:30〜11:00', source: 1 }]),
      result('clinic', [{ label: '電話', value: '0166', source: 1 }]),
      result('operator', [{ label: '直近のダイヤ改正', value: '5/10 に減便', source: 1 }]),
    ])
    expect(rows.map((r) => [r.label, r.total, r.hit])).toEqual([
      ['病院・診療所', 2, 1],
      ['周辺の事業者', 1, 1],
    ])
  })
})
