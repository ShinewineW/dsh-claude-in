import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const entry = resolve(root, 'src/index.ts')
const outdir = resolve(root, 'lib')

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [entry],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['@deepseek-ai/*', 'cordis', 'yaml'],
  sourcemap: false,
  logLevel: 'info',
})
