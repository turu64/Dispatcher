import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // `@/` は `src/` を指す(shadcn/ui の部品もこの別名で読み込む)
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // 開発中は /api をローカルのサーバー(uv run dispatcher-server)に中継する
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
