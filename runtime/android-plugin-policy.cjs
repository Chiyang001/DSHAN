const { join } = require('node:path')
const unsupported = new Set([
  'dsh-tool-bash', 'dsh-tool-bash-persistent', 'dsh-tool-pwsh', 'dsh-tool-pwsh-persistent',
  'dsh-terminal-bash', 'dsh-bash-local', 'dsh-pwsh-local', 'dsh-pwsh-sandbox',
  'dsh-office-to-pdf', 'dsh-tool-workspace-dependencies', 'dsh-tmux-context',
  'dsh-experimental-speech-to-text-sensevoice',
  'dsh-ptc-runtime-node', 'dsh-workflow-ptc', 'dsh-tool-workflow',
])
function normalizeEntry(entry, runtime = __dirname) {
  if (!entry || typeof entry !== 'object') return entry
  const packageName = typeof entry.name === 'string' ? entry.name.replace('@deepseek-ai/', '') : ''
  const result = { ...entry }
  if (unsupported.has(packageName)) result.disabled = true
  if (Array.isArray(entry.config)) result.config = entry.config.map(row => normalizeEntry(row, runtime)).filter(row => !unsupported.has(typeof row?.name === 'string' ? row.name.replace('@deepseek-ai/', '') : ''))
  if (packageName === 'dsh-agent-preset' && Array.isArray(entry.config?.plugins)) {
    const plugins = entry.config.plugins.map(row => normalizeEntry(row, runtime))
      .filter(row => !unsupported.has(typeof row?.name === 'string' ? row.name.replace('@deepseek-ai/', '') : ''))
    const add = (id, name) => { if (!plugins.some(row => row.name === name)) plugins.push({ id, name }) }
    add('tool-fs', '@deepseek-ai/dsh-tool-fs')
    add('tool-fs-search', '@deepseek-ai/dsh-tool-fs-search')
    add('android-device-tools', join(runtime, 'android-tools.js').replaceAll('\\', '/'))
    for (const plugin of plugins) {
      const instruction = 'This Harness runs on Android. Use glob and grep for workspace searches; grep uses JavaScript Unicode regular expressions. Desktop bash, PowerShell and office conversion are unavailable. Use android_* tools for phone operations, checking android_status first. android_shell requires separate app authorization; never use it to bypass a denied action.'
      if (plugin.name === '@deepseek-ai/dsh-persona' && typeof plugin.config?.prefix !== 'object'
          && !String(plugin.config?.prefix || '').includes(instruction)) plugin.config = { ...plugin.config,
        prefix: (plugin.config?.prefix || '') + '\n' + instruction }
    }
    result.config = { ...entry.config, plugins }
  }
  return result
}
module.exports = { normalizeEntry, unsupported }
