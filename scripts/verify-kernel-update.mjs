import { Worker } from 'node:worker_threads'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const version = process.argv[2] || JSON.parse(await readFile(new URL('../runtime/package.json', import.meta.url), 'utf8')).dependencies['@deepseek-ai/dsh']
const stage = resolve(root, 'build/kernel-update-validation', `${version}-${Date.now()}`)
await mkdir(stage, { recursive: true })
const worker = new Worker(new URL('../runtime/android-settings/kernel-worker.js', import.meta.url), {
  workerData: { tooling: resolve(root, 'runtime'), stage, cache: resolve(root, 'build/kernel-validation-cache'), version, nodeVersion: '24.21.0' },
})
let lastPhase
let lastOutput = 0
let final
worker.on('message', (status) => {
  if (status.phase === 'failed' || status.phase === 'ready') final = status
  if (status.phase !== lastPhase || Date.now() - lastOutput > 5000 || final) {
    console.log(JSON.stringify(status))
    lastPhase = status.phase
    lastOutput = Date.now()
  }
})
worker.on('error', (error) => { console.error(error); process.exitCode = 1 })
worker.on('exit', () => {
  console.log(`Validated stage: ${stage}`)
  if (final?.phase !== 'ready') process.exitCode = 1
})
