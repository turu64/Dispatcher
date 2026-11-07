import { describe, expect, it } from 'vitest'
import { stateLines } from './screenLines'
import type { PolicyServices } from './tools'

// [画面の状態] の行に、ダイヤのグループ分けを書く(docs/design-service-groups.md §5.3)

const gtfsLine = (services: PolicyServices) =>
  stateLines({ today: '20261104', gtfs: { label: 'kyoto.zip', validity: { start: '20261001', end: '20261130' }, services }, reach: null }).find(
    (l) => l.key === 'gtfs',
  )!.line

describe('[画面の状態] のグループ分け', () => {
  it('グループ分けが無ければ今の行のまま', () => {
    expect(gtfsLine({ weekday: '01', saturday: '03', sundayHoliday: '06' })).toBe(
      '[画面の状態] 読み込んだ GTFS:kyoto.zip(有効期間 2026年10月1日〜2026年11月30日)。平日の service:01、土曜:03、日祝:06。',
    )
  })

  it('確定していれば、種類ごとの組・なくす・残すを「ほか N」で書く。作れない種類はその理由', () => {
    const line = gtfsLine({
      weekday: '01001',
      saturday: '03001',
      sundayHoliday: null,
      groups: {
        status: 'confirmed',
        byKind: {
          weekdayToSaturday: {
            kind: 'weekdayToSaturday',
            weekdayService: '01001',
            replacementService: '03001',
            pairs: [
              { weekday: '01001', replacements: ['03001'] },
              { weekday: '01001_A', replacements: ['03001_A'] },
              { weekday: '01005_MSN', replacements: [] },
            ],
            keptWeekdayServices: ['01002_RIT', '01003_KSU'],
          },
          weekdayToSundayHoliday: { error: [{ severity: 'error', code: 'unsupportedService', serviceIds: ['MS'], message: '形2で表せない service が 1 つあります(MS)。' }] },
        },
      },
    })
    expect(line).toContain(
      'ダイヤのグループ分け:土曜ダイヤに変えるとき、平日のダイヤ 01001 ほか 1 を土曜のダイヤ 03001 ほか 1 に入れ替える(なくす:01005_MSN、平日のまま残す:01002_RIT ほか 1)。',
    )
    expect(line).toContain('日祝ダイヤに変えるときは作れません(形2で表せない service が 1 つあります(MS)。)')
    expect(line).not.toContain('平日の service:')
  })

  it('Jev の答えを待っている間(unconfirmed)は、今の行に待っていることを足す。確定の操作は言わない', () => {
    const line = gtfsLine({ weekday: '01001', saturday: '03001', sundayHoliday: '02001', groups: { status: 'unconfirmed' } })
    expect(line).toContain('平日の service:01001、土曜:03001、日祝:02001。')
    expect(line).toContain('ダイヤのグループ分けは Jev の答えを待っています(答えが届くと、ダイヤ単位で減便の方針を作れます。それまでは平日の service 01001 だけを入れ替えます)。')
    expect(line).not.toContain('確定')
  })
})
