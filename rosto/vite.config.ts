import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the static build works inside the Tauri shell (file://).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
})
