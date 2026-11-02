import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 開発中は /api をローカルのサーバー(uv run dispatcher-server)に中継する
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
