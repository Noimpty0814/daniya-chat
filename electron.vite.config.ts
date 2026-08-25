import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const stripCspInDev = {
  name: 'strip-csp-in-dev',
  apply: 'serve' as const,
  transformIndexHtml(html: string): string {
    return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>\s*/i, '')
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react(), stripCspInDev] }
})
