import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { makeBands } from '@/gtfs/departures'
import { BandPicker, ServiceDayInfo } from './DateBandStep'

function textOf(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/\|+/g, '|')
}

describe('ServiceDayInfo', () => {
  it('平日:日付と曜日、走る service_id、calendar_dates.txt による変更が無いこと', () => {
    const text = textOf(
      renderToString(
        <ServiceDayInfo
          day={{ date: '20261104', weekday: 2, serviceIds: ['01'], calendarServiceIds: ['01'], added: [], removed: [], exceptionApplied: false }}
        />,
      ),
    )
    expect(text).toContain('2026年11月4日(水)')
    expect(text).toContain('走る service_id:|01')
    expect(text).toContain('calendar_dates.txt による変更はありません')
  })

  it('祝日:calendar_dates.txt が効いていることと、追加・運休の service_id', () => {
    const text = textOf(
      renderToString(
        <ServiceDayInfo
          day={{ date: '20261103', weekday: 1, serviceIds: ['06'], calendarServiceIds: ['01'], added: ['06'], removed: ['01'], exceptionApplied: true }}
        />,
      ),
    )
    expect(text).toContain('2026年11月3日(火)')
    expect(text).toContain('calendar_dates.txt が効いています')
    expect(text).toContain('追加:|06|。運休:|01|。')
  })

  it('走る便が無い日', () => {
    const text = textOf(
      renderToString(
        <ServiceDayInfo
          day={{ date: '20261201', weekday: 1, serviceIds: [], calendarServiceIds: [], added: [], removed: [], exceptionApplied: false }}
        />,
      ),
    )
    expect(text).toContain('この日に走る便はありません')
  })
})

describe('BandPicker', () => {
  it('3時間ごとの6つの時間帯を出し、選んだ時刻を含む時間帯を押された状態にする', () => {
    const html = renderToString(<BandPicker bands={makeBands(3)} selectedHour={10} onSelect={() => {}} />)
    for (const label of ['6〜9時', '9〜12時', '12〜15時', '15〜18時', '18〜21時', '21〜24時']) expect(html).toContain(label)
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-checked="true"[^>]*>9〜12時</)
  })

  it('選ばれている時間帯は主色で塗る(うっすらした灰色だけでは、地図に出している時間帯が見分けにくい)', () => {
    const html = renderToString(<BandPicker bands={makeBands(3)} selectedHour={10} onSelect={() => {}} />)
    expect(html).toContain('data-[state=on]:bg-primary')
    expect(html).toContain('data-[state=on]:text-primary-foreground')
  })

  it('1時間ごとは 18 の時間帯', () => {
    const html = renderToString(<BandPicker bands={makeBands(1)} selectedHour={10} onSelect={() => {}} />)
    expect(html.match(/role="radio"/g)).toHaveLength(18)
    expect(html).toMatch(/aria-checked="true"[^>]*>10〜11時</)
  })
})
