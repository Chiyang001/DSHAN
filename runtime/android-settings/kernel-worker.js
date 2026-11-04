import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const require = createRequire(join(workerData.tooling, 'node_modules/npm/package.json'))
const Arborist = require('./node_modules/@npmcli/arborist')
const semver = require('./node_modules/semver')
const registry = 'https://registry.npmmirror.com'
const send = (data) => parentPort.postMessage(data)
let installed = 0
let total = 0
let requests = 0
let phase = 'resolve'
process.on('log', (level, ...args) => {
  if (level === 'http') {
    requests++
    send({ phase, requests, log: args.join(' ') })
  } else if (level === 'warn' || level === 'error') send({ phase, log: args.join(' ') })
})

class ProgressArborist extends Arborist {
  addTracker(section, subsection, key) {
    if (section === 'idealTree' && subsection) send({ phase: 'resolve', package: subsection, log: `解析依赖 ${subsection}` })
    if (section === 'reify' && subsection) send({ phase: 'install', package: subsection, installed, total, log: `下载、校验并解包 ${subsection}` })
    return super.addTracker(section, subsection, key)
  }
  finishTracker(section, subsection, key) {
    if (section === 'reify' && subsection) {
      installed++
      send({ phase: 'install', package: subsection, installed, total, log: `依赖处理完成 ${subsection}` })
    }
    return super.finishTracker(section, subsection, key)
  }
}

try {
  await mkdir(workerData.stage, { recursive: true })
  await writeFile(join(workerData.stage, 'package.json'), JSON.stringify({
    name: 'dsh-android-runtime', version: '0.1.0', private: true, type: 'module',
    dependencies: { '@deepseek-ai/dsh': workerData.version, '@deepseek-ai/dsh-tools': workerData.version, '@img/sharp-wasm32': '^0.35.5', npm: '11.6.2', pnpm: '11.1.2' },
  }, null, 2))
  const arb = new ProgressArborist({
    path: workerData.stage, cache: workerData.cache, registry,
    omit: ['dev'], ignoreScripts: true, audit: false, fund: false,
    os: 'android', cpu: 'arm64', libc: 'bionic',
    engineStrict: true, nodeVersion: workerData.nodeVersion,
    npmVersion: '11.6.2', fetchRetries: 3, timeout: 60000,
    fetchRetryFactor: 2, fetchRetryMintimeout: 1500, fetchRetryMaxtimeout: 10000,
    maxSockets: 4, progress: false, packageLock: true,
  })
  send({ phase: 'resolve', log: `从 npmmirror 解析 DSH ${workerData.version} 和完整依赖树` })
  const tree = await arb.buildIdealTree()
  // An upper bound: npm may skip optional dependencies on Android.
  total = tree.inventory.size - 1
  for (const node of tree.inventory.values()) {
    if (node === tree || node.optional) continue
    const engines = node.package.engines?.node
    if (engines && !semver.satisfies(workerData.nodeVersion, engines)) throw new Error(`${node.name} 要求 Node ${engines}，本机为 ${workerData.nodeVersion}`)
    if (node.resolved && !node.resolved.startsWith('https://registry.npmmirror.com/')) throw new Error(`依赖 ${node.name} 使用了镜像站以外的来源，无法更新`)
  }
  phase = 'install'
  send({ phase, total, installed, log: `开始下载和安装依赖，计划最多 ${total} 个包；npm 将跳过不适用的可选依赖并校验包完整性` })
  await arb.reify()
  phase = 'verify'
  send({ phase, log: '验证 DSH 版本、启动入口、Web 界面和 Android 适配依赖' })
  const core = JSON.parse(await readFile(join(workerData.stage, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  if (core.version !== workerData.version) throw new Error('安装后的 DSH 版本不匹配')
  const sharp = JSON.parse(await readFile(join(workerData.stage, 'node_modules/sharp/package.json'), 'utf8'))
  const wasm = JSON.parse(await readFile(join(workerData.stage, 'node_modules/@img/sharp-wasm32/package.json'), 'utf8'))
  if (sharp.version !== wasm.version) throw new Error(`图片运行库版本不匹配：sharp ${sharp.version} / WASM ${wasm.version}，请升级 APK 后重试`)
  for (const name of ['dsh-host-directory-picker-browse', 'dsh-client-ui-directory-picker-browse', 'cordis', 'dsh-web-app', 'dsh-client-ui-settings-general', 'dsh-client-connection', 'dsh-host-webserver']) {
    await stat(join(workerData.stage, 'node_modules/@deepseek-ai', name, 'package.json'))
  }
  await stat(join(workerData.stage, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  await stat(join(workerData.stage, 'node_modules/npm/node_modules/@npmcli/arborist/lib/index.js'))
  await writeFile(join(workerData.stage, '.kernel-ready.json'), JSON.stringify({ version: core.version, verifiedAt: new Date().toISOString() }))
  send({ phase: 'ready', installed, total, log: '安装和校验完成。点击“重启并启用”切换到新内核；旧内核仍保留。' })
} catch (error) {
  const detail = `${error.message}${error.code ? ` (${error.code})` : ''}`
  send({ phase: 'failed', error: detail, log: `更新失败：${detail}。当前内核未改动，可重试；已下载的包会从缓存复用。` })
}
