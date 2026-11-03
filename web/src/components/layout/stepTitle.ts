import { createContext, useContext } from 'react'

/**
 * 見出しの付け直し。左の欄の手順(layout/StepPanels.tsx)が、手順の一覧(steps/registry.ts)の並びの番号に付け替える。
 * 各手順の部品は「2. 減便の方針」のように番号つきの見出しを持つが、手順の並びが変わっても部品を直さずに済むようにする。
 * 入れ物の外で描くとき(各手順のテスト)は、渡された見出しのまま出す
 */
export const StepTitleContext = createContext<((title: string) => string) | null>(null)

/** 見出しの先頭の番号(「2. 」)を外す */
export function stripStepNumber(title: string): string {
  return title.replace(/^\d+\.\s*/, '')
}

/** 手順の見出し。StepTitleContext があれば付け替える */
export function useStepTitle(title: string): string {
  const retitle = useContext(StepTitleContext)
  return retitle ? retitle(title) : title
}
