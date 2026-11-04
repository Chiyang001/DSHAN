// Android has neither git nor a native build toolchain. Keep pnpm's own
// resolver, semver, tarball integrity and lockfile handling, but read public
// Git refs over HTTPS instead of spawning git ls-remote.
const { dirname, join } = require('node:path')
const { pathToFileURL } = require('node:url')

function packageManager(runtime = __dirname, env = process.env) {
  if (!env.DSH_ANDROID_NODE) throw new Error('Android Node 启动器缺失，请更新 APK 后重试')
  const childEnv = { LD_LIBRARY_PATH: dirname(env.DSH_ANDROID_NODE) }
  // The upstream service scrubs DSH_* variables. The DNS bridge in this child
  // needs only this token; do not forward model keys or the whole parent env.
  for (const key of ['HOME', 'TMPDIR', 'DSH_ANDROID_BRIDGE_TOKEN']) {
    if (env[key]) childEnv[key] = env[key]
  }
  return { command: env.DSH_ANDROID_NODE, args: [join(runtime, 'android-package-manager.cjs')], env: childEnv }
}

function parseRefs(buffer) {
  const refs = Object.create(null)
  let offset = 0
  while (offset < buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii')
    if (!/^[0-9a-f]{4}$/i.test(header)) throw new Error('Git 引用响应格式无效')
    const length = parseInt(header, 16)
    offset += 4
    if (length === 0) continue
    if (length < 4 || offset + length - 4 > buffer.length) throw new Error('Git 引用响应不完整')
    const line = buffer.subarray(offset, offset + length - 4).toString('utf8').split('\0')[0].trimEnd()
    offset += length - 4
    if (line.startsWith('ERR ')) throw new Error(line.slice(4))
    const match = /^([0-9a-f]{40}) (HEAD|refs\/[^\s]+)$/.exec(line)
    if (match) refs[match[2]] = match[1]
  }
  if (!Object.keys(refs).length) throw new Error('仓库没有可用的 Git 引用，请检查仓库地址和访问权限')
  return refs
}

async function readGitRefs(repo, fetcher = fetch, {
  attempts = 3, timeout = 20000,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry = attempt => console.warn(`[DSHAN] 读取仓库引用失败，正在重试 (${attempt}/${attempts})…`),
} = {}) {
  const url = new URL(repo)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Android 插件安装支持公开仓库的 HTTPS 地址；私有仓库或其他 Git 来源请使用已构建的 npm 包或 HTTPS .tgz 安装包')
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/info/refs'
  url.search = '?service=git-upload-pack'
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(url.href, {
        headers: { accept: 'application/x-git-upload-pack-advertisement', 'user-agent': 'DSHAN-Android' },
        signal: AbortSignal.timeout(timeout), redirect: 'follow',
      })
      if (!response.ok) {
        await response.body?.cancel()
        const error = new Error(`仓库引用请求失败 (HTTP ${response.status})；请检查网络、仓库地址和公开访问权限`)
        error.permanent = response.status < 500 && ![408, 429].includes(response.status)
        throw error
      }
      if (!response.headers.get('content-type')?.includes('application/x-git-upload-pack-advertisement')) {
        await response.body?.cancel()
        throw Object.assign(new Error('仓库未返回 Git 引用；请使用公开的 GitHub/GitLab/Bitbucket 仓库或 HTTPS .tgz 安装包'), { permanent: true })
      }
      // Stream with a limit: large repositories must not exhaust phone memory.
      const chunks = []
      let size = 0
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 16 * 1024 * 1024) throw Object.assign(new Error('仓库引用超过 16 MiB，请指定完整的 40 位 commit 或使用 HTTPS .tgz 安装包'), { permanent: true })
          chunks.push(Buffer.from(value))
        }
      } finally { await reader.cancel() }
      return parseRefs(Buffer.concat(chunks, size))
    } catch (error) {
      lastError = error
      if (error.permanent || attempt === attempts - 1) break
      onRetry(attempt + 2)
      await delay(1000 * 2 ** attempt)
    }
  }
  throw new Error(`Android 无 Git 安装：${lastError?.message || '无法读取仓库引用'}`, { cause: lastError })
}

function patchPnpmSource(source, adapter = __filename) {
  const edits = [
    ['async function fromHostedGit(hosted, dispatcherOptions) {', `
      // Use the host's public HTTPS archive, including for github: and SSH
      // shorthand. Private SSH authentication is unavailable on Android.
      const androidHttps = hosted.https({ noCommittish: true, noGitPlus: true });
      if (!androidHttps || hosted.auth || !hosted.tarball?.())
        throw new Error("Android 无 Git 安装仅支持公开 HTTPS 仓库，请使用 npm 包或 HTTPS .tgz 安装包");
      return {
        fetchSpec: androidHttps,
        hosted: { ...hosted, tarballtemplate: hosted.type === "gitlab" ? gitlabTarballTemplate : hosted.tarballtemplate, _fill: hosted._fill, tarball: hosted.tarball },
        normalizedBareSpecifier: hosted.shortcut(),
        ...parseGitParams(hosted.committish)
      };
    `],
    ['async function resolveRef(repo, ref, range) {', 'async function resolveRef(repo, ref, range, androidDispatcherOptions = {}) {'],
    ['resolveRef(parsedSpec.fetchSpec, bareSpecifier, parsedSpec.gitRange)', 'resolveRef(parsedSpec.fetchSpec, bareSpecifier, parsedSpec.gitRange, opts2)'],
    ['const refs = await getRepoRefs(repo, range ?? committish ? null : ref);', `const refs = await __androidPackages.readGitRefs(repo, (url, options) => fetchWithDispatcher(url, { ...options, dispatcherOptions: androidDispatcherOptions, retry: { retries: 0 } }));`],
    ['async function pickFetcher(fetcherByHostingType, resolution, opts2) {', `
      // A previous install may already have pinned a Git clone in its lockfile.
      // Fetch that exact commit from the public archive without rewriting it.
      if (resolution.type === "git") {
        const hosted = require_hosted_git_info2().fromUrl(resolution.repo);
        if (!hosted || hosted.auth || !/^[0-9a-f]{40}$/.test(resolution.commit))
          throw new Error("Android 无 Git 安装不支持此仓库，请使用公开托管仓库、npm 包或 HTTPS .tgz 安装包");
        const tarball = hosted.type === "gitlab" ? gitlabTarballTemplate({ ...hosted, committish: resolution.commit }) : hosted.tarball?.({ committish: resolution.commit });
        if (!tarball) throw new Error("此 Git 来源没有公开的 HTTPS 安装包，Android 无法直接安装");
        return (cafs, _resolution, options) => fetcherByHostingType.gitHostedTarball(cafs, { tarball, gitHosted: true, ...resolution.path ? { path: resolution.path } : {} }, options);
      }
    `],
  ]
  for (const [marker, replacement] of edits) {
    if (source.split(marker).length !== 2) throw new Error('当前 pnpm 版本与 Android 无 Git 安装适配不兼容，请更新 APK 后重试')
    source = source.replace(marker, marker.startsWith('async function fromHostedGit') || marker.startsWith('async function pickFetcher') ? marker + replacement : replacement)
  }
  return `import { createRequire as __androidCreateRequire } from 'node:module';\nconst __androidPackages = __androidCreateRequire(import.meta.url)(${JSON.stringify(adapter)});\n` + source
}

const settings = {
  'ignore-scripts': true,
  'package-import-method': 'copy',
  'network-concurrency': 4,
  'child-concurrency': 1,
  'fetch-retries': 3,
  'fetch-retry-mintimeout': 1500,
  'fetch-retry-maxtimeout': 10000,
  'fetch-timeout': 60000,
  'pm-on-fail': 'ignore',
}
// updateConfig keeps numeric settings as numbers. pnpm 11 treats values from
// --config.<key>=<value> as strings, which breaks its install concurrency queue.
const hooks = { updateConfig: config => ({ ...config, ...Object.fromEntries(
  Object.entries(settings).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])
) }) }

async function main() {
  if (process.platform === 'android') require('./android-network.cjs').install()
  const { registerHooks } = require('node:module')
  const bundle = pathToFileURL(join(__dirname, 'node_modules/pnpm/dist/pnpm.mjs')).href
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url !== bundle) return result
    return { ...result, source: patchPnpmSource(Buffer.from(result.source).toString('utf8')) }
  } })
  process.argv.splice(2, 0, `--config.global-pnpmfile=${__filename}`, '--pm-on-fail=ignore')
  await import(pathToFileURL(join(__dirname, 'node_modules/pnpm/bin/pnpm.mjs')).href)
}

module.exports = { packageManager, parseRefs, readGitRefs, patchPnpmSource, settings, hooks }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
