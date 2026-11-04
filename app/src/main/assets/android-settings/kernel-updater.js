import { Worker } from 'node:worker_threads'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

export const REGISTRY = 'https://registry.npmmirror.com'
const phases = new Set(['checking', 'resolve', 'install', 'verify'])
const channels = { latest: '正式版', alpha: 'Alpha 版' }

export class KernelUpdater {
  constructor({ runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..'), home = homedir(), fetcher = fetch, workerFactory = (data) => new Worker(new URL('./kernel-worker.js', import.meta.url), { workerData: data }) } = {}) {
    this.runtime = runtime
    this.home = home
    this.fetcher = fetcher
    this.workerFactory = workerFactory
    this.file = join(home, 'kernel-update.json')
    this.state = { phase: 'idle', channel: 'latest', currentVersion: '', latestVersion: '', available: false, logs: [], installed: 0, total: 0, requests: 0, registry: REGISTRY }
    this.worker = null
    this.queue = Promise.resolve()
    this.initialized = this.init()
  }
  async init() {
    const core = JSON.parse(await readFile(join(this.runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
    try { this.state = { ...this.state, ...JSON.parse(await readFile(this.file, 'utf8')) } } catch (error) { if (error.code !== 'ENOENT') this.state.logs.push({ time: new Date().toISOString(), text: '上次更新记录无法读取，将重新检查。' }) }
    this.state.currentVersion = core.version
    if (typeof this.state.channel !== 'string' || !Object.hasOwn(channels, this.state.channel)) this.state.channel = 'latest'
    const require = createRequire(join(this.runtime, 'node_modules/npm/package.json'))
    this.semver = require('./node_modules/semver')
    if (phases.has(this.state.phase)) this.record({ phase: 'failed', error: '上次更新被应用退出中断，当前内核未改动，可重新检查并重试。' })
    if (this.state.phase === 'ready' && this.state.latestVersion === core.version) this.record({ phase: 'complete', log: `已启用 DSH ${core.version}` })
    if (this.state.phase === 'restarting') {
      if (this.state.latestVersion === core.version) this.record({ phase: 'complete', log: `DSH ${core.version} 已启动` })
      else this.record({ phase: 'failed', error: '新内核启动失败，已回退到原内核。', log: '启动失败，已自动回退。' })
    }
    if (this.state.phase === 'complete' && this.state.latestVersion !== core.version) this.record({ phase: 'failed', error: '新内核启动失败，已回退到原内核。', log: `当前已恢复到 DSH ${core.version}` })
  }
  snapshot() { return { ...this.state, elapsedSeconds: this.state.startedAt ? Math.floor(((this.state.finishedAt || Date.now()) - this.state.startedAt) / 1000) : 0, busy: phases.has(this.state.phase) } }
  record({ log, ...fields }) {
    Object.assign(this.state, fields)
    if (fields.startedAt) this.state.finishedAt = null
    if (['checked', 'ready', 'failed', 'cancelled', 'complete'].includes(fields.phase)) this.state.finishedAt = Date.now()
    if (log) this.state.logs = [...this.state.logs.slice(-299), { time: new Date().toISOString(), text: log }]
    if (!this.persistTimer) this.persistTimer = setTimeout(() => { this.persistTimer = null; this.flush().catch((error) => { this.state.error = `无法保存更新记录：${error.message}` }) }, 250)
  }
  flush() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
    const snapshot = JSON.stringify(this.state)
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.home, { recursive: true })
      await writeFile(`${this.file}.tmp`, snapshot)
      await rename(`${this.file}.tmp`, this.file)
    })
    return this.queue
  }
  async check(channel) {
    await this.initialized
    if (channel === undefined) channel = this.state.channel
    if (typeof channel !== 'string' || !Object.hasOwn(channels, channel)) throw new Error('更新通道无效，请选择正式版或 Alpha 版')
    if (this.snapshot().busy || ['ready', 'restarting'].includes(this.state.phase)) throw new Error('更新操作进行中，请稍候；已安装的更新需先重启启用')
    this.record({ phase: 'checking', channel, latestVersion: '', available: false, compatible: null, engines: '', checkedAt: null, error: '', startedAt: Date.now(), logs: [], package: '', installed: 0, total: 0, requests: 0, log: `正在向 npmmirror 查询 @deepseek-ai/dsh 的${channels[channel]}（${channel}）版本` })
    try {
      const response = await this.fetcher(`${REGISTRY}/@deepseek-ai%2Fdsh/${channel}`, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`镜像站返回 HTTP ${response.status}`)
      const metadata = await response.json()
      if (metadata.name !== '@deepseek-ai/dsh' || !this.semver.valid(metadata.version)) throw new Error('镜像站返回了无效版本信息')
      const available = this.semver.gt(metadata.version, this.state.currentVersion)
      const compatible = !metadata.engines?.node || this.semver.satisfies(process.versions.node, metadata.engines.node)
      this.record({ phase: 'checked', latestVersion: metadata.version, available, compatible, engines: metadata.engines?.node ?? '', checkedAt: new Date().toISOString(), log: available ? `发现新版本 ${metadata.version}；当前 ${this.state.currentVersion}${compatible ? '' : '，Node 版本不兼容，无法安装'}` : `镜像站最新版本 ${metadata.version}；当前版本无需更新` })
    } catch (error) { this.record({ phase: 'failed', error: error.message, log: `检查失败：${error.message}` }) }
    await this.flush()
    return this.snapshot()
  }
  async start() {
    await this.initialized
    if (this.worker || this.snapshot().busy || this.state.phase === 'restarting') throw new Error('已有更新进行中')
    if (!this.state.available || !this.state.compatible || !this.semver.valid(this.state.latestVersion)) throw new Error('请先检查更新，并选择兼容的新版本')
    if (!this.state.checkedAt || Date.now() - Date.parse(this.state.checkedAt) > 3600000) throw new Error('版本检查已过期，请重新检查')
    const stage = join(this.home, 'kernels', `${this.state.latestVersion}-${Date.now()}`)
    this.runningStage = stage
    this.record({ phase: 'resolve', stage, error: '', startedAt: Date.now(), installed: 0, total: 0, requests: 0, logs: [], log: `准备安装 DSH ${this.state.latestVersion}，当前运行的内核保持可用` })
    try {
      const worker = this.workerFactory({ tooling: this.runtime, stage, cache: join(this.home, 'kernel-cache'), version: this.state.latestVersion, nodeVersion: process.versions.node })
      this.worker = worker
      worker.on('message', (data) => { if (this.worker === worker) this.record(data) })
      worker.on('error', (error) => { if (this.worker === worker) this.record({ phase: 'failed', error: error.message, log: `安装器错误：${error.message}` }) })
      worker.on('exit', (code) => {
        if (this.worker !== worker) return
        this.worker = null
        if (phases.has(this.state.phase)) this.record({ phase: 'failed', error: `安装器提前退出（${code}），当前内核未改动` })
        if (this.state.phase === 'failed') this.cleanupStage(stage).catch(() => {})
      })
    } catch (error) { this.worker = null; this.record({ phase: 'failed', error: error.message }) }
    await this.flush()
    return this.snapshot()
  }
  async cancel() {
    await this.initialized
    const worker = this.worker
    if (!worker) throw new Error('没有正在安装的更新')
    this.worker = null
    await worker.terminate()
    await this.cleanupStage(this.runningStage)
    this.record({ phase: 'cancelled', error: '', log: '已取消安装，当前内核未改动。' })
    await this.flush()
    return this.snapshot()
  }
  async cleanupStage(stage) {
    if (!stage || dirname(resolve(stage)) !== resolve(this.home, 'kernels')) throw new Error('临时目录无效')
    await rm(stage, { recursive: true, force: true })
  }
  async restart() {
    await this.initialized
    if (this.state.phase !== 'ready') throw new Error('新内核尚未完成安装和校验')
    this.record({ phase: 'restarting', log: '正在重启应用并启用新内核…' })
    await this.flush()
    try {
      const response = await this.fetcher('http://127.0.0.1:3981/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': process.env.DSH_ANDROID_BRIDGE_TOKEN },
        body: JSON.stringify({ method: 'activateKernel', path: this.state.stage }), signal: AbortSignal.timeout(10000),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? '无法重启应用')
    } catch (error) { this.record({ phase: 'ready', error: error.message, log: `启用失败：${error.message}` }); await this.flush() }
    return this.snapshot()
  }
}
