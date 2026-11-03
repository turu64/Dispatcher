import { describe, expect, it } from 'vitest'
import type { GtfsRow } from '../load'
import { signatureDigest, sortByStopSequence, stopTimesByTrip, tripSignature } from './signature'

function row(stop_id: string, stop_sequence: string, time = '07:00:00'): GtfsRow {
  return { trip_id: 'T1', stop_id, stop_sequence, arrival_time: time, departure_time: time }
}

describe('便の署名(§5.1)', () => {
  it('読める stop_sequence は空白を取って 0 以上の10進の整数だけで、-1・+3・2.0・空は読めない値として入力の順で後ろに置く', () => {
    const rows = [
      row('M', '-1'),
      row('B', '2'),
      row('D', ' 10 '),
      row('P', '+3'),
      row('E', '010'),
      row('F', '2.0'),
      row('A', '1'),
      row('G', ''),
    ]
    // 読める値は数値の昇順(' 10 ' と '010' は同じ 10 なので入力の順)。読めない値は入力の順のまま後ろ
    expect(sortByStopSequence(rows).map((r) => r.stop_id)).toEqual(['A', 'B', 'D', 'E', 'M', 'P', 'F', 'G'])
  })

  it('-1 の行は数値の 0 より前ではなく、読めない値として最後に並ぶ(参照実装の int() とは違う)', () => {
    const rows = [row('A', '0', '07:00:00'), row('Z', '-1', '06:50:00'), row('B', '1', '07:10:00')]
    expect(tripSignature('R1', rows)).toBe('R1\tA,07:00:00,07:00:00;B,07:10:00,07:10:00;Z,06:50:00,06:50:00')
  })

  it('桁数の違う値を文字列ではなく数として比べる', () => {
    const rows = [row('C', '10'), row('B', '9'), row('A', '0')]
    expect(sortByStopSequence(rows).map((r) => r.stop_id)).toEqual(['A', 'B', 'C'])
  })

  it('値の前後の空白を取り、乗降の区分などは署名に含めない', () => {
    const plain = [row('A', '1'), row('B', '2', '07:10:00')]
    const spaced: GtfsRow[] = [
      { ...row(' A ', '1'), pickup_type: '0', drop_off_type: '1' },
      { ...row('B', '2', ' 07:10:00 '), pickup_type: '1', stop_headsign: '駅前' },
    ]
    expect(tripSignature(' R1 ', spaced)).toBe(tripSignature('R1', plain))
    // 時刻は文字列のまま比べる
    expect(tripSignature('R1', [row('A', '1', '7:00:00')])).not.toBe(tripSignature('R1', [row('A', '1', '07:00:00')]))
  })

  it('stop_times の行を空白を取った trip_id ごとにまとめ、便の中は入力の順のまま', () => {
    const groups = stopTimesByTrip([
      { trip_id: 'T1', stop_sequence: '2' },
      { trip_id: ' T2 ', stop_sequence: '1' },
      { trip_id: 'T1 ', stop_sequence: '1' },
    ])
    expect([...groups.keys()]).toEqual(['T1', 'T2'])
    expect(groups.get('T1')!.map((r) => r.stop_sequence)).toEqual(['2', '1'])
  })

  it('signatureDigest は署名を並べ替えて "\\n" でつないだ SHA-256(末尾に改行を付けない)', async () => {
    // printf 'a\nb' | shasum -a 256
    expect(await signatureDigest(['b', 'a'])).toBe('7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78')
  })
})
