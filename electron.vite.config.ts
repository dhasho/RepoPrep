import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { defineConfig } from 'electron-vite'
import type { IndexHtmlTransformContext } from 'vite'
import react from '@vitejs/plugin-react'

function rendererCsp() {
  return {
    name: 'renderer-csp',
    enforce: 'post' as const,
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string, context: IndexHtmlTransformContext) {
        const hashes = process.env.NODE_ENV === 'production'
          ? []
          : [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
              .filter(([, attributes, content]) => !/\bsrc\s*=/.test(attributes) && content.trim())
              .map(([, , content]) => `'sha256-${createHash('sha256').update(content).digest('base64')}'`)

        const connectSources = new Set<string>()
        if (context.server) {
          for (const url of context.server.resolvedUrls?.local ?? []) {
            const parsed = new URL(url)
            connectSources.add(parsed.origin)
            connectSources.add(`ws://${parsed.host}`)
            if (parsed.protocol === 'https:') connectSources.add(`wss://${parsed.host}`)
          }
        }

        const transformedHtml = html
          .replace('__CSP_SCRIPT_HASHES__', hashes.join(' '))
          .replace('__CSP_CONNECT_SOURCES__', [...connectSources].join(' '))

        // @vitejs/plugin-react inserts its refresh preamble immediately after <head>.
        // Keep the CSP ahead of it so the policy applies to the preamble itself.
        const cspTag = transformedHtml.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/i)?.[0]
        if (!cspTag) return transformedHtml
        const withoutCsp = transformedHtml.replace(cspTag, '')
        return withoutCsp.replace(/<head\b[^>]*>/i, (headTag) => `${headTag}\n    ${cspTag}`)
      }
    }
  }
}

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
    server: {
      host: '127.0.0.1',
      port: 5186,
      strictPort: true
    },
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
    plugins: [react(), rendererCsp()]
  }
})
