import { describe, expect, it } from 'vitest'
import type { Form2Report } from '@/gtfs/edit/form2'
import { addBackRejections, diaLabel, groupSentence, serviceIdsText, skippedOfReport } from './editText'

const EMPTY: Form2Report['addBack'] = {
  requested: 0,
  accepted: [],
  ignoredExcludedRoute: [],
  ignoredAlreadyPresent: [],
  notWeekday: [],
  notFound: [],
  duplicate: [],
}

describe('addBackRejections(平日に戻せなかった便の理由)', () => {
  it('pairs があるときの alreadyKept・notActive にも理由を付ける(docs/design-service-groups.md §4.5 の順)', () => {
    const r = addBackRejections(
      { ...EMPTY, notWeekday: ['W'], alreadyKept: ['K'], notActive: ['N'], duplicate: ['D'] },
      'weekdayToSaturday',
    )
    expect(r.map((x) => x.tripId)).toEqual(['D', 'K', 'W', 'N'])
    expect(r.find((x) => x.tripId === 'K')!.reason).toContain('平日のまま残す service の便')
    expect(r.find((x) => x.tripId === 'N')!.reason).toContain('減便の期間に1日も走らない')
  })

  it('pairs が無い(alreadyKept・notActive が無い)ときは今と同じ', () => {
    expect(addBackRejections({ ...EMPTY, notWeekday: ['W'] }, 'weekdayToSaturday')).toEqual([
      { tripId: 'W', reason: '平日ダイヤの便ではありません。' },
    ])
  })
})

describe('グループの語', () => {
  it('serviceIdsText:1つならそのまま、2つ以上なら「先頭 ほか N」、無ければ「なし」', () => {
    expect(serviceIdsText([])).toBe('なし')
    expect(serviceIdsText(['01001'])).toBe('01001')
    expect(serviceIdsText(['01001', '01001_A', 'WB'])).toBe('01001 ほか 2')
    expect(diaLabel('平日', ['01001', '01001_A'])).toBe('平日のダイヤ(01001 ほか 1)')
    expect(diaLabel('土曜', [])).toBe('土曜のダイヤ')
  })

  it('groupSentence:入れ替える組と、なくす・残す service の数', () => {
    expect(
      groupSentence({
        kind: 'weekdayToSaturday',
        weekdayService: '01001',
        replacementService: '03001',
        pairs: [
          { weekday: '01001', replacements: ['03001'] },
          { weekday: 'WB', replacements: ['SB1', 'SB2'] },
          { weekday: '01005_MSN', replacements: [] },
        ],
        keptWeekdayServices: ['01002_RIT'],
      }),
    ).toBe(
      '平日のダイヤ(01001 ほか 1)を土曜のダイヤ(03001 ほか 2)の便に入れ替えます。ほかに、期間の間、便をなくす service 1 つ・平日のまま残す service 1 つがあります。',
    )
    expect(
      groupSentence({
        kind: 'weekdayToSundayHoliday',
        weekdayService: 'S2',
        replacementService: '',
        pairs: [{ weekday: 'S2', replacements: [] }],
        keptWeekdayServices: [],
      }),
    ).toBe('平日のダイヤ(S2)は、入れ替えに使う日祝のダイヤがないため、期間の間なくします。')
  })

  it('groupSentence:版の report で期間に走らないため加えなかった入れ替えに使う service は数えない', () => {
    const settings = {
      kind: 'weekdayToSaturday' as const,
      weekdayService: '01001',
      replacementService: '03001',
      pairs: [
        { weekday: '01001', replacements: ['03001', '03001_K'] },
        { weekday: '01001_C', replacements: ['03001_C'] },
      ],
      keptWeekdayServices: [],
    }
    const rep = (serviceId: string, notActive: boolean) => ({ serviceId, rule: 'append-service' as const, servicePartIndex: null, added: notActive ? 0 : 1, notActive })
    const report = {
      pairs: [
        { weekday: '01001', dropped: false, removed: 2, replacements: [rep('03001', false), rep('03001_K', true)] },
        { weekday: '01001_C', dropped: false, removed: 1, replacements: [rep('03001_C', true)] },
      ],
    }
    expect(groupSentence(settings, report)).toBe(
      '平日のダイヤ(01001)を土曜のダイヤ(03001)の便に入れ替えます。ほかに、期間の間、便をなくす service 1 つがあります。',
    )
    expect(skippedOfReport(report)).toEqual(['03001_K', '03001_C'])
  })
})
