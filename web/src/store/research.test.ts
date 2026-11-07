import { describe, expect, it } from 'vitest'
import { feedOf, rowsOf } from '@/gtfs/edit/form2.fixture'
import type { Facility, ResearchCandidate } from '@/ref/facilities'
import { schoolTerminalTargets, schoolTripTerminals } from './research'

// 学校行きの便(行き先に「高校」)の終点 S(南高校)と、ふつうの便の終点 T。土曜だけの学校行きの便の終点 U
const feed = feedOf({
  routes: rowsOf('route_id,route_short_name,route_long_name\nR1,1,駅前線\nR2,2,農高線'),
  calendar: rowsOf(
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261001,20261130\nSA,0,0,0,0,0,1,0,20261001,20261130',
  ),
  trips: rowsOf('route_id,service_id,trip_id,trip_headsign\nR1,WK,a,南高校\nR1,WK,b,市役所\nR1,SA,c,東高校\nR2,WK,d,永山'),
  stop_times: rowsOf(`trip_id,arrival_time,departure_time,stop_id,stop_sequence
a,07:00:00,07:00:00,A,1
a,07:30:00,07:30:00,S,10
a,07:20:00,07:20:00,M,2
b,08:00:00,08:00:00,A,1
b,08:30:00,08:30:00,T,2
c,08:00:00,08:00:00,A,1
c,08:30:00,08:30:00,U,2
d,09:00:00,09:00:00,A,1
d,09:30:00,09:30:00,N,2`),
})

const STOPS = [
  { id: 'A', lat: 43.76, lon: 142.36 },
  { id: 'S', lat: 43.8, lon: 142.4 },
  { id: 'M', lat: 43.78, lon: 142.38 },
  { id: 'T', lat: 43.7, lon: 142.3 },
  { id: 'U', lat: 43.9, lon: 142.5 },
  { id: 'N', lat: 43.85, lon: 142.45 },
]

function cand(targetId: string, lat: number, lon: number, o: Partial<ResearchCandidate> = {}): ResearchCandidate {
  const facility = { targetId, kind: 'school', name: targetId, lat, lon, schoolType: '高等学校' } as Facility
  return { facility, category: 'high_school', nearestStopM: 100, ownOperator: false, closed: false, ...o }
}

describe('学校行きの便の終点の近くの学校(schoolTerminalTargets)', () => {
  it('行き先か系統名に高校・学校などを含む平日の便の終点(stop_sequence が最大の行)だけを使う', () => {
    // a は行き先が南高校で終点 S。d は系統名「農高線」・行き先「永山」のどちらも語を含まないので入らない。c は土曜だけの便
    expect([...schoolTripTerminals(feed)].sort()).toEqual(['S'])
  })

  it('終点から 600m 以内の学校を返す。600m より遠い学校・種類の無い施設・学校でない施設は返さない', () => {
    const near = cand('P29:南高校', 43.8 + 500 / 111_000, 142.4)
    const far = cand('P29:遠い高校', 43.8 + 700 / 111_000, 142.4)
    const noCategory = cand('P29:不明', 43.8, 142.4, { category: null })
    const hospital = cand('P04:病院', 43.8, 142.4, { category: 'inpatient_hospital', facility: { targetId: 'P04:病院', kind: 'hospital', name: '病院', lat: 43.8, lon: 142.4 } as Facility })
    const atOther = cand('P29:市役所前高校', 43.7, 142.3)
    expect([...schoolTerminalTargets(feed, STOPS, [near, far, noCategory, hospital, atOther])]).toEqual(['P29:南高校'])
  })
})
