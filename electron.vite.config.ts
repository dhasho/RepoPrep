import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('electron/main.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve('shared') }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('electron/preload.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve('shared') }
    }
  },
  renderer: {
    root: 'src',
    build: {
      rollupOptions: {
        input: { index: resolve('src/index.html') }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('shared'),
        '@': resolve('src')
      }
    },
    plugins: [react()]
  }
})
