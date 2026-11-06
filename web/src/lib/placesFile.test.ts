import { describe, expect, it } from 'vitest'
import {
  importResultText,
  MAX_PLACE_NAME,
  MAX_PLACES,
  normalizePlaceName,
  parsePlacesFile,
  placeOf,
  placesFileName,
  PLACES_FILE_FORMAT,
  serializePlaces,
  type PlaceInput,
} from './placesFile'

const PLACES: PlaceInput[] = [
  { type: 'office', name: '営業所A', lat: 43.77, lon: 142.36 },
  { type: 'office', name: '営業所B', lat: 43.8, lon: 142.4 },
  { type: 'office', name: '営業所C', lat: 43.75, lon: 142.3 },
]

function fileOf(places: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: PLACES_FILE_FORMAT, version: 1, places, ...extra })
}

describe('placesFile(営業所の JSON)', () => {
  it('書き出した JSON を読み込むと、同じ一覧に戻る', () => {
    const r = parsePlacesFile(serializePlaces(PLACES))
    expect(r).toEqual({ ok: true, places: PLACES, skipped: 0, overLimit: 0 })
  })

  it('書き出しには種類・名前・緯度経度だけを入れ、ほかの値(id など)は入れない', () => {
    const text = serializePlaces([{ ...PLACES[0], id: 'x', kind: 'depot' } as PlaceInput])
    const body = JSON.parse(text)
    expect(body).toEqual({ format: PLACES_FILE_FORMAT, version: 1, places: [{ type: 'office', name: '営業所A', lat: 43.77, lon: 142.36 }] })
  })

  it('壊れた行は読み飛ばして数える(種類・名前・緯度経度・範囲)', () => {
    const rows = [
      PLACES[0],
      { type: 'depot', name: '種類違い', lat: 43, lon: 142 },
      { type: 'office', name: '', lat: 43, lon: 142 },
      { type: 'office', name: '   ', lat: 43, lon: 142 },
      { type: 'office', name: 'あ'.repeat(MAX_PLACE_NAME + 1), lat: 43, lon: 142 },
      { type: 'office', name: '文字の緯度', lat: '43', lon: 142 },
      { type: 'office', name: '範囲外', lat: 91, lon: 142 },
      { type: 'office', name: '範囲外2', lat: 43, lon: -181 },
      { type: 'office', name: '欠け', lat: 43 },
      { name: '種類なし', lat: 43, lon: 142 },
      null,
      [1, 2],
      'office',
      PLACES[2],
    ]
    const r = parsePlacesFile(fileOf(rows))
    expect(r).toEqual({ ok: true, places: [PLACES[0], PLACES[2]], skipped: 12, overLimit: 0 })
    if (r.ok) expect(importResultText(r)).toBe('2 か所を読み込みました。読めない行 12 行を読み飛ばしました。')
  })

  it('前の版の種類(営業所・車庫・休憩施設の site、車庫の garage、休憩施設の rest)の行も、捨てずに営業所として読み込む', () => {
    const rows = [
      { type: 'site', name: '本社・旭川営業所', lat: 43.78, lon: 142.33 },
      { type: 'garage', name: '永山車庫', lat: 43.82, lon: 142.46 },
      { type: 'rest', name: '駅前の休憩所', lat: 43.76, lon: 142.36 },
      { type: 'office', name: '名寄出張所', lat: 44.34, lon: 142.46 },
    ]
    const r = parsePlacesFile(fileOf(rows))
    expect(r).toEqual({ ok: true, places: rows.map((p) => ({ ...p, type: 'office' })), skipped: 0, overLimit: 0 })
    // 書き出すと、どれも type 'office' になる
    if (r.ok) expect(JSON.parse(serializePlaces(r.places)).places.map((p: { type: string }) => p.type)).toEqual(['office', 'office', 'office', 'office'])
  })

  it('名前の空白を整え、緯度経度を小数 6 桁に丸める', () => {
    expect(placeOf({ type: 'office', name: '  旭川  営業所 ', lat: 43.123456789, lon: 142.987654321 })).toEqual({
      type: 'office',
      name: '旭川 営業所',
      lat: 43.123457,
      lon: 142.987654,
    })
    expect(normalizePlaceName(1)).toBeNull()
  })

  it(`上限の ${MAX_PLACES} か所を超えた行は読み込まず、数を出す`, () => {
    const rows = Array.from({ length: MAX_PLACES + 3 }, (_, i) => ({ type: 'office', name: `営業所${i}`, lat: 43, lon: 142 }))
    const r = parsePlacesFile(fileOf(rows))
    expect(r.ok && r.places.length).toBe(MAX_PLACES)
    expect(r.ok && r.overLimit).toBe(3)
    if (r.ok) expect(importResultText(r)).toContain(`上限の ${MAX_PLACES} か所を超えた 3 行は読み込んでいません。`)
  })

  it('形の合わないファイルは丸ごと断る', () => {
    expect(parsePlacesFile('{')).toMatchObject({ ok: false, message: expect.stringContaining('JSON として読めません') })
    expect(parsePlacesFile('[]')).toMatchObject({ ok: false, message: expect.stringContaining('営業所の JSON ではありません') })
    expect(parsePlacesFile(JSON.stringify({ format: 'other', version: 1, places: [] }))).toMatchObject({ ok: false })
    expect(parsePlacesFile(fileOf([], { version: 2 }))).toMatchObject({ ok: false, message: expect.stringContaining('版(2)') })
    expect(parsePlacesFile(fileOf({}))).toMatchObject({ ok: false, message: expect.stringContaining('places の一覧') })
  })

  it('BOM の付いた JSON も読む', () => {
    expect(parsePlacesFile(`﻿${serializePlaces(PLACES)}`)).toMatchObject({ ok: true, places: PLACES })
  })

  it('ファイル名は日時を入れる', () => {
    expect(placesFileName(new Date(2026, 10, 5, 9, 7))).toBe('dispatcher_places_202611050907.json')
  })
})
