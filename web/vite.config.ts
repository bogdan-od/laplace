import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import type { ViteUserConfig } from 'vitest/config'

const repoRoot = path.resolve(import.meta.dirname, '..')
const backend = process.env.LAPLACE_BACKEND ?? 'http://127.0.0.1:8086'
const proxy = {
  '/api': backend,
  '/files': backend,
  '/ws': { target: backend, ws: true },
}

// v86det/src/cpu.js requires two debug-only libraries that are not in the tree
// (guarded by `if(!DEBUG) return`, and the Worker sets DEBUG = false). Stub them for the bundler.
const STUB_ID = '\0v86-debug-stub'
const v86DebugStubs: Plugin = {
  name: 'v86-debug-stubs',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer?.includes('/v86det/') && /(capstone-x86\.min\.js|libwabt\.cjs)$/.test(source)) return STUB_ID
    return null
  },
  load(id) {
    return id === STUB_ID ? 'export default undefined' : null
  },
}

// Tests run without a DOM; two workers at most, because every test machine takes a lot of memory.
const test: NonNullable<ViteUserConfig['test']> = {
  environment: 'node',
  include: ['src/**/*.test.{ts,tsx}'],
  pool: 'threads',
  maxWorkers: 2,
}

export default defineConfig({
  test,
  plugins: [v86DebugStubs, react(), tailwindcss()],
  worker: { format: 'es', plugins: () => [v86DebugStubs] },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@shared': path.resolve(repoRoot, 'shared/src'),
      '@core': path.resolve(repoRoot, 'app'),
      // The package's "module" field points to a file that is not in the tarball; its ES build is lib-headless/*.mjs.
      '@xterm/headless': path.resolve(import.meta.dirname, 'node_modules/@xterm/headless/lib-headless/xterm-headless.mjs'),
    },
  },
  // The core lives outside web/ (app/, v86det/).
  server: { fs: { allow: [repoRoot] }, proxy },
  preview: { proxy },
})
