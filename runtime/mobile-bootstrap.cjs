// DeepSeek Harness's node-addon-require-builtin does not publish an Android
// binary. Node's supported --expose-internals flag supplies the same internal
// modules to the official Harness loader on this pinned Node 24 build.
const Module = require('node:module')

// Seed the Android default in the editable profile layer, never in --patch.
// A command-line default prevents ConfigEditor from saving preset changes.
function seedAndroidPreset(home) {
  const fs = require('node:fs')
  const path = require('node:path')
  const YAML = require('yaml')
  const patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  const before = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '[]\n'
  const document = YAML.parseDocument(before, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  if (document.errors.length) throw document.errors[0]
  if (!YAML.isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  for (const row of document.contents.items) {
    if (YAML.isMap(row) && row.get('id') === 'agent-preset-registry'
        && YAML.isMap(row.get('config')) && row.get('config').has('default')) return
  }
  document.add({ id: 'agent-preset-registry', config: { default: 'android' } })
  fs.mkdirSync(path.dirname(patch), { recursive: true })
  const temporary = patch + '.android-default.tmp'
  fs.writeFileSync(temporary, String(document), { mode: 0o600 })
  fs.renameSync(temporary, patch)
}
function addAndroidPluginWarning(runtime = __dirname) {
  const fs = require('node:fs')
  const path = require('node:path')
  const client = path.join(runtime, 'node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js')
  if (!fs.existsSync(client)) return
  const original = fs.readFileSync(client, 'utf8')
  if (original.includes('"data-android-plugin-warning": "v2"')) return
  // Replace the first version on previously downloaded kernels as well.
  const source = original.replace(/\(0, react_jsx_runtime\.jsx\)\("div", \{ role: "note", "data-android-plugin-warning": true,[^\n]*?\}\),\s*/, '')
  const marker = /("data-plugin-panel": true,[\s\S]*?children: \[)/
  if (!marker.test(source)) return
  const warning = '由于DSHAN在安卓本地运行，很多NPM插件并不支持在Android上运行，请选用支持的插件使用。'
  const banner = `(0, react_jsx_runtime.jsx)("div", { role: "note", "data-android-plugin-warning": "v2", style: { boxSizing: "border-box", flexShrink: 0, padding: "10px 12px", margin: "24px 0 -16px", borderRadius: 8, border: "1px solid #d99a284d", background: "#d99a281a", color: "inherit", fontSize: 13, lineHeight: 1.6, overflowWrap: "anywhere" }, children: ${JSON.stringify('⚠️ ' + warning)} }),`
  const updated = source.replace(marker, (match) => match + '\n' + banner)
    .replace('className: PluginManagerPage_module_css_default.pageHead,',
      'className: PluginManagerPage_module_css_default.pageHead, style: { paddingTop: 0 },')
  fs.writeFileSync(client, updated)
}
module.exports = { seedAndroidPreset, addAndroidPluginWarning }
if (process.platform === 'android') {
  addAndroidPluginWarning()
  seedAndroidPreset(process.env.DSH_HOME)
  require('./android-network.cjs').install()
  const { pathToFileURL } = require('node:url')
  const { join } = require('node:path')
  const adapter = pathToFileURL(join(__dirname, 'android-flock.cjs')).href
  const nativeCommandShim = pathToFileURL(join(__dirname, 'android-native-command-shim.mjs')).href
  const searchAdapter = pathToFileURL(join(__dirname, 'android-search.js')).href
  const pluginPolicy = pathToFileURL(join(__dirname, 'android-plugin-policy.cjs')).href
  const packageManagerAdapter = pathToFileURL(join(__dirname, 'android-package-manager.cjs')).href
  const PTY_UTILS_MARKER = 'function loadNativeModule(name) {'
  const PTY_UTILS_PATCH = `${PTY_UTILS_MARKER}
    if (name === "pty" && process.platform === "android") {
      const library = process.env.DSH_ANDROID_PTY_LIBRARY;
      if (!library) throw new Error("Android PTY library path is missing; upgrade the APK");
      const native = { exports: {} };
      process.dlopen(native, library);
      return { dir: require("node:path").dirname(library), module: native.exports };
    }`
  const INSPECTOR_MARKER = `function createProcessInspector(platform = process.platform, arch = process.arch, internals = DEFAULT_INTERNALS) {
	if (platform === "linux")`
  const INSPECTOR_PATCH = `function createProcessInspector(platform = process.platform, arch = process.arch, internals = DEFAULT_INTERNALS) {
	if (platform === "android") platform = "linux";
	if (platform === "linux")`
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/node-addon-system/flock') return { url: adapter, shortCircuit: true }
      if (specifier === '@deepseek-ai/dsh-native-command') return { url: nativeCommandShim, shortCircuit: true }
      if (specifier === '@deepseek-ai/dsh-tool-fs-search') return { url: searchAdapter, shortCircuit: true }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      // The embedded Android process has no executable Node on PATH. Give the
      // official profile manager a packaged Node launcher and the bundled pnpm.
      if (url.includes('/@deepseek-ai/dsh/lib/profile-boot-') && result.format === 'module') {
        const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
        const marker = 'name: options.profile,'
        if (source.includes(marker)) return { ...result, source: `import { packageManager as __androidPackageManager } from ${JSON.stringify(packageManagerAdapter)};\n` + source.replace(marker,
          marker + '\n packageManager: __androidPackageManager(),') }
      }
      if (url.includes('/@deepseek-ai/cordis-plugin-loader/lib/') && result.format === 'module') {
        const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
        const marker = 'async update(options, create = false, force = false) {'
        if (source.includes(marker)) return { ...result, source: `import { normalizeEntry as __androidEntry } from ${JSON.stringify(pluginPolicy)};\n` + source.replace(marker, marker + '\n options = __androidEntry({ ...this.options, ...options });') }
      }
      if (url.includes('/@deepseek-ai/dsh-llm-deepseek/lib/') && result.format === 'module') {
        const original = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
        const marker = 'throw new LlmError("DeepSeek Messages transport failed", "TRANSPORT", { cause: error });'
        if (original.includes(marker)) return { ...result, source: original.replaceAll(marker,
          'console.error("ANDROID_MODEL_TRANSPORT", JSON.stringify([error, error?.cause, error?.cause?.cause].map(e => e ? {name:e.name,code:e.code} : null))); ' + marker) }
      }
      const replacements = url.includes('/node-pty/lib/utils.js')
        ? [[PTY_UTILS_MARKER, PTY_UTILS_PATCH]]
        : url.includes('/@deepseek-ai/dsh-subprocess-local/lib/runner-launch')
          ? [[INSPECTOR_MARKER, INSPECTOR_PATCH]]
          : url.includes('/@deepseek-ai/dsh-session-persistence-jsonl/lib/')
          ? [['await link(tmp, finalPath)', 'await __androidPublishNew(tmp, finalPath)'],
             ['await internals.fs.link(staged, currentPath)', 'await __androidPublishNew(staged, currentPath)']]
          : url.includes('/@deepseek-ai/dsh-fs-local/lib/')
            ? [['await linkFile(tempPath, absolutePath)', 'await __androidPublishNew(tempPath, absolutePath)']]
            : url.includes('/@deepseek-ai/dsh-attachment-local/lib/')
              ? [['await link(source, target)', 'await __androidPublishCopyNew(source, target)'],
                 ['await link(staged.path, target)', 'await __androidPublishCopyNew(staged.path, target)'],
                 ['await ensureDurableDirectory(home, parse(home).root)', 'await ensureDurableDirectory(home, await __androidDurableBoundary(home))']]
              : []
      if (!replacements.length || (result.format !== 'module' && result.format !== 'commonjs')) return result
      let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
      let changed = false
      for (const [before, after] of replacements) {
        if (source.includes(before)) { source = source.replaceAll(before, after); changed = true }
      }
      if (!changed) return result
      const needsFlockPrefix = url.includes('/@deepseek-ai/dsh-session-persistence-jsonl/lib/')
        || url.includes('/@deepseek-ai/dsh-fs-local/lib/')
        || url.includes('/@deepseek-ai/dsh-attachment-local/lib/')
      if (result.format !== 'module' || !needsFlockPrefix) return { ...result, source }
      const prefix = `import { publishNew as __androidPublishNew, publishCopyNew as __androidPublishCopyNew, durableBoundary as __androidDurableBoundary } from ${JSON.stringify(adapter)};\n`
      return { ...result, source: `${prefix}${source}` }
    },
  })
}
const load = Module._load
Module._load = function (request, parent, isMain) {
  if (process.platform === 'android' && request === '@deepseek-ai/dsh-tool-fs-search')
    return load.call(this, require('node:path').join(__dirname, 'android-search.js'), isMain)
  if (process.platform === 'android' && request === '@deepseek-ai/dsh-native-command') {
    // Preserve the upstream utility exports for CommonJS plugins too.
    const original = load.call(this, require('node:path').join(__dirname,
      'node_modules/@deepseek-ai/dsh-native-command/lib/index.js'), isMain)
    return { ...original, ...require('./android-native-command.cjs') }
  }
  if (request === 'node-addon-require-builtin') {
    return { requireBuiltin: (id) => require(id), isAllowedInternalId: () => true }
  }
  const exports = load.call(this, request, parent, isMain)
  if (process.platform === 'android' && /(?:^|[/\\])node-pty[/\\]lib[/\\]utils\.js$/.test(Module._resolveFilename(request, parent))) {
    exports.loadNativeModule = function (name) {
      if (name !== 'pty') throw new Error('Unsupported Android terminal native module: ' + name)
      const library = process.env.DSH_ANDROID_PTY_LIBRARY
      if (!library) throw new Error('Android PTY library path is missing; upgrade the APK')
      const native = { exports: {} }
      process.dlopen(native, library)
      return { dir: require('node:path').dirname(library), module: native.exports }
    }
  }
  return exports
}
