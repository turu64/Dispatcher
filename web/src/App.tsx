// 1画面構成:左に手順、右に地図。中身は 11/3 以降に実装する。
export default function App() {
  return (
    <div className="app">
      <aside className="steps">
        <h1>Dispatcher</h1>
        <p>減便ダイヤの判断支援(準備中)</p>
      </aside>
      <main className="map" aria-label="地図" />
    </div>
  )
}
