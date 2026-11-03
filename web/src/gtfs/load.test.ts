import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { loadGtfsZip } from './load'

const BOM = String.fromCharCode(0xfeff)

async function makeZip(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('loadGtfsZip', () => {
  it('各ファイルを表として読み、列名を順番どおりに残す', async () => {
    const feed = await loadGtfsZip(
      await makeZip({
        'agency.txt': 'agency_id,agency_name\n1,テストバス\n',
        'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,駅前,43.76,142.36\nB,市役所,43.77,142.37\n',
      }),
    )
    expect(feed.tables.get('agency')).toEqual({
      fileName: 'agency.txt',
      fields: ['agency_id', 'agency_name'],
      rows: [{ agency_id: '1', agency_name: 'テストバス' }],
      format: { path: 'agency.txt', bom: false, newline: '\n', header: 'agency_id,agency_name', finalNewline: true },
    })
    expect(feed.tables.get('stops')?.rows).toHaveLength(2)
    expect(feed.warnings).toEqual([])
  })

  it('先頭の BOM、CRLF と LF の混在、空行を扱う', async () => {
    const feed = await loadGtfsZip(
      await makeZip({ 'routes.txt': `${BOM}route_id,route_short_name\r\n10,旭川線\n11,永山線\r\n\r\n` }),
    )
    expect(feed.tables.get('routes')?.rows).toEqual([
      { route_id: '10', route_short_name: '旭川線' },
      { route_id: '11', route_short_name: '永山線' },
    ])
  })

  it('引用符の中のカンマと改行を値として読む', async () => {
    const feed = await loadGtfsZip(
      await makeZip({ 'stops.txt': 'stop_id,stop_desc\nA,"北口,南口"\nB,"1行目\n2行目"\n' }),
    )
    expect(feed.tables.get('stops')?.rows).toEqual([
      { stop_id: 'A', stop_desc: '北口,南口' },
      { stop_id: 'B', stop_desc: '1行目\n2行目' },
    ])
  })

  it('1列のファイルで値に ; があっても区切りとみなさない', async () => {
    const feed = await loadGtfsZip(await makeZip({ 'stops.txt': 'stop_name\nA;B;C\nD;E\n' }))
    expect(feed.tables.get('stops')?.rows).toEqual([{ stop_name: 'A;B;C' }, { stop_name: 'D;E' }])
    expect(feed.warnings).toEqual([])
  })

  it('見出しの前後の空白は取り、値は元のまま残す', async () => {
    const feed = await loadGtfsZip(await makeZip({ 'stops.txt': ' stop_id , stop_name\n A ,駅前 \n' }))
    expect(feed.tables.get('stops')).toMatchObject({
      fields: ['stop_id', 'stop_name'],
      rows: [{ stop_id: ' A ', stop_name: '駅前 ' }],
    })
  })

  it('空のファイルと見出しだけのファイルは行0件の表にする', async () => {
    const feed = await loadGtfsZip(
      await makeZip({ 'agency.txt': 'agency_id\n1\n', 'shapes.txt': '', 'transfers.txt': 'from_stop_id,to_stop_id\n' }),
    )
    expect(feed.tables.get('shapes')).toMatchObject({ fileName: 'shapes.txt', fields: [], rows: [] })
    expect(feed.tables.get('transfers')).toMatchObject({
      fileName: 'transfers.txt',
      fields: ['from_stop_id', 'to_stop_id'],
      rows: [],
    })
    expect(feed.warnings).toEqual([])
  })

  it('フォルダの中に入った ZIP と大文字の拡張子を読み、__MACOSX は読まない', async () => {
    const feed = await loadGtfsZip(
      await makeZip({
        'feed/agency.txt': 'agency_id\n1\n',
        'feed/Calendar.TXT': 'service_id\n平日\n',
        'feed/readme.md': '説明',
        '__MACOSX/feed/._agency.txt': 'x',
      }),
    )
    expect([...feed.tables.keys()].sort()).toEqual(['agency', 'calendar'])
    expect(feed.tables.get('calendar')?.fileName).toBe('Calendar.TXT')
  })

  it('書き出しのために、エントリ名・BOM・最初の改行・元の見出し・最後の改行を残す', async () => {
    const feed = await loadGtfsZip(
      await makeZip({
        'feed/stops.txt': `${BOM} stop_id ,stop_name\r\nA,駅前\nB,市役所`,
        'feed/routes.txt': 'route_id\n10\r\n',
        'feed/agency.txt': 'agency_id',
      }),
    )
    expect(feed.tables.get('stops')?.format).toEqual({
      path: 'feed/stops.txt',
      bom: true,
      newline: '\r\n',
      header: ' stop_id ,stop_name',
      finalNewline: false,
    })
    // 見出しは空白を取った列名で持ち、元の文字列は format に残す
    expect(feed.tables.get('stops')?.fields).toEqual(['stop_id', 'stop_name'])
    expect(feed.tables.get('routes')?.format).toMatchObject({ bom: false, newline: '\n', header: 'route_id', finalNewline: true })
    // 改行が1つも無ければ CRLF とみなす
    expect(feed.tables.get('agency')?.format).toMatchObject({ newline: '\r\n', header: 'agency_id', finalNewline: false })
  })

  it('Blob からも読める(ファイル選択とサンプルの両方で使う)', async () => {
    const blob = new Blob([await makeZip({ 'agency.txt': 'agency_id\n1\n' })])
    const feed = await loadGtfsZip(blob)
    expect(feed.tables.get('agency')?.rows).toHaveLength(1)
  })

  it('列数が見出しと合わない行は警告に出し、余分な値は表に残さない', async () => {
    const feed = await loadGtfsZip(await makeZip({ 'stops.txt': 'stop_id,stop_name\nA\nB,駅前,余分\n' }))
    expect(feed.warnings).toEqual([
      { file: 'stops.txt', line: 2, message: '列が見出しより少ない行があります' },
      { file: 'stops.txt', line: 3, message: '列が見出しより多い行があります' },
    ])
    expect(feed.tables.get('stops')?.rows).toEqual([{ stop_id: 'A' }, { stop_id: 'B', stop_name: '駅前' }])
  })

  it('同じ列名が複数あれば警告に出す', async () => {
    const feed = await loadGtfsZip(await makeZip({ 'stops.txt': 'stop_id,stop_id\nA,B\n' }))
    expect(feed.warnings.map((w) => w.message)).toEqual([expect.stringContaining('同じ列名が複数あります')])
  })

  it('UTF-8 でない文字は警告に出す', async () => {
    // Shift_JIS の「テスト」
    const sjis = new Uint8Array([...new TextEncoder().encode('stop_name\n'), 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a])
    const feed = await loadGtfsZip(await makeZip({ 'stops.txt': sjis }))
    expect(feed.warnings).toEqual([
      { file: 'stops.txt', message: 'UTF-8 として読めない文字があります(GTFS-JP は UTF-8 が必須です)' },
    ])
  })

  it('閉じていない引用符があれば止める', async () => {
    await expect(
      loadGtfsZip(await makeZip({ 'stops.txt': 'stop_id,stop_name\n1,"x\n2,y\n3,z\n' })),
    ).rejects.toThrow('stops.txt の 2 行目付近に、閉じていない引用符')
  })

  it('同じ名前のファイルが複数のフォルダにあれば止める', async () => {
    await expect(
      loadGtfsZip(await makeZip({ 'a/stops.txt': 'stop_id\nX\n', 'b/stops.txt': 'stop_id\nY\n' })),
    ).rejects.toThrow('同じ名前のファイル(stops.txt)が ZIP の中に複数あります')
  })

  it('ZIP でなければ日本語のエラーにする', async () => {
    await expect(loadGtfsZip(new Blob(['<html>not found</html>']))).rejects.toThrow('ZIP として開けませんでした')
  })

  it('GTFS のファイルが1つも無ければエラーにする', async () => {
    await expect(loadGtfsZip(await makeZip({ 'readme.md': '説明' }))).rejects.toThrow(
      'GTFS のファイル(.txt)が見つかりません',
    )
  })
})

// 道北バスの GTFS(data/raw/gtfs/ に置く。コミットしない)。ファイルがあるときだけ走る
const SAMPLES = [
  { file: 'dohoku_bus_減便前.zip', version: '202609171038' },
  { file: 'dohoku_bus_減便後.zip', version: '202610291429' },
].map((s) => ({ ...s, path: fileURLToPath(new URL(`../../../data/raw/gtfs/${s.file}`, import.meta.url)) }))

for (const sample of SAMPLES) {
  describe.skipIf(!existsSync(sample.path))(`道北バス(${sample.file})`, () => {
    it('必須のファイルを警告なしで読める', async () => {
      const buf = readFileSync(sample.path)
      const feed = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      for (const name of ['agency', 'stops', 'routes', 'trips', 'stop_times', 'calendar', 'feed_info']) {
        expect(feed.tables.get(name)?.rows.length, name).toBeGreaterThan(0)
      }
      expect(feed.tables.get('feed_info')?.rows[0]?.feed_version).toBe(sample.version)
      expect(feed.warnings).toEqual([])
    })
  })
}
