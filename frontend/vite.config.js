import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: the FastAPI backend runs on :8000 (cd backend && uvicorn app.main:app --port 8000); /api is proxied to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': { target: process.env.API_URL || 'http://127.0.0.1:8000', changeOrigin: true } } },
})
