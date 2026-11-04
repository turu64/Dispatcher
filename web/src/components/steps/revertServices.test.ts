import { describe, expect, it } from 'vitest'
import { applyRevert } from '@/gtfs/edit/form2'
import { basePlan, multiFeed, multiPlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { BaseGtfs } from '@/store/edit'
import { revertServices } from './revertServices'

const INPUT = { start: '20261001', end: '20261130' }

function baseOf(feed = multiFeed()): BaseGtfs {
  return { feed, zip: new ArrayBuffer(0), label: 'multi.zip', sample: null }
}

describe('revertServices(元のダイヤに戻す版の検証で見る service)', () => {
  it('組の表のある方針なら pairs を渡す(祝日の確かめをすべての組の平日の service で行う)', () => {
    const plan = multiPlan()
    const services = revertServices(baseOf(), plan, null, INPUT)
    expect(services).toEqual({ kind: 'weekdayToSaturday', weekdayService: '01001', replacementService: '03001', pairs: plan.pairs })
    // applyRevert がその値で通る
    const outcome = applyRevert(multiFeed(), { generatedAt: '202611041200', restoreFrom: '20261110', feedVersion: undefined, services })
    expect(outcome.ok).toBe(true)
  })

  it('組の表の無い方針は今までどおり pairs を入れない。方針が無ければ推定した平日の service', () => {
    expect(revertServices(baseOf(smallFeed()), basePlan(), null, INPUT)).toEqual({ kind: 'weekdayToSaturday', weekdayService: 'WK', replacementService: 'SA' })
    expect(revertServices(baseOf(smallFeed()), null, null, INPUT)).toEqual({ kind: 'weekdayToSaturday', weekdayService: 'WK', replacementService: '' })
  })
})
