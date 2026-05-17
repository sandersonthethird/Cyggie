import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Relaxes the desktop CSP for `vite dev` only so Vite's inline HMR client
 * scripts aren't blocked by `script-src 'self'`. Prod builds keep the strict
 * policy from src/renderer/index.html untouched.
 *
 *   serve (npm run dev) → script-src 'self' 'unsafe-inline'
 *   build (npm run build / package) → unchanged (strict)
 *
 * Vite HMR uses inline <script> tags but does NOT use eval — leave
 * 'unsafe-eval' off unless a future dev-only tool surfaces a violation.
 */
function devCspRelax() {
  return {
    name: 'dev-csp-relax',
    apply: 'serve' as const,
    transformIndexHtml(html: string): string {
      return html.replace(
        /script-src 'self'/,
        "script-src 'self' 'unsafe-inline'",
      )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [react(), devCspRelax()]
  }
})
