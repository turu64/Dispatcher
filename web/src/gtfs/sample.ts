/** サーバーが配信するサンプル GTFS(道北バス)の情報 */
export interface SampleGtfsInfo {
  available: boolean
  name: string
  source: string
  license: string
}

export async function fetchSampleGtfsInfo(): Promise<SampleGtfsInfo> {
  const res = await fetch('/api/sample-gtfs')
  if (!res.ok) throw new Error(`サンプルの情報を取得できませんでした(${res.status})`)
  return res.json()
}

export async function fetchSampleGtfs(): Promise<Blob> {
  const res = await fetch('/api/sample-gtfs/download')
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail ?? `サンプルを取得できませんでした(${res.status})`)
  }
  return res.blob()
}
