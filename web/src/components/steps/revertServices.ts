import type { RevertOptions } from '@/gtfs/edit/form2'
import type { Form2Plan } from '@/gtfs/edit/ops'
import { describeServices, guessServiceChoice } from '@/gtfs/edit/services'
import type { HolidayList } from '@/gtfs/holidays'
import type { BaseGtfs } from '@/store/edit'

/**
 * 検証で「平日ダイヤ」として見る service:承認した方針があればその service、無ければ推定した平日の service。
 * 祝日・年末年始の確かめに使うだけで、便の中身は変えない
 */
export function revertServices(base: BaseGtfs, plan: Form2Plan | null, holidays: HolidayList | null, input: { start: string; end: string }): RevertOptions['services'] {
  if (plan) {
    // 組の表があれば渡し、祝日の確かめをすべての組の平日の service で行う(docs/design-service-groups.md §4.3)
    return {
      kind: plan.kind,
      weekdayService: plan.weekdayService,
      replacementService: plan.replacementService,
      ...(plan.pairs !== undefined ? { pairs: plan.pairs } : {}),
    }
  }
  const weekday = guessServiceChoice(base.feed, describeServices(base.feed, holidays), input).weekday
  return weekday ? { kind: 'weekdayToSaturday', weekdayService: weekday, replacementService: '' } : undefined
}
