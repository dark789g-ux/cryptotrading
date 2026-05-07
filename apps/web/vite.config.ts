import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@cryptotrading/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    allowedHosts: ['mytrading.s7.tunnelfrp.com'],
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
