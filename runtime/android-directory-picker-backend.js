import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'

export const ROOTS = '__dsh_android_roots__'

const BRIDGE = 'http://127.0.0.1:3981/rpc'
const token = () => process.env.DSH_ANDROID_BRIDGE_TOKEN

const STORAGE_PREFIXES = [
  '/storage/emulated/0',
  '/storage/self/primary',
  '/sdcard',
]

function normalizePath(path) {
  if (path == null || path === '') return path
  const trimmed = String(path).replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

const storageRoot = () => normalizePath(process.env.DSH_ANDROID_STORAGE_ROOT || '/storage/emulated/0')

function isSharedStoragePath(path) {
  const normalized = normalizePath(path)
  if (normalized == null) return false
  const storage = storageRoot()
  if (normalized === storage || normalized.startsWith(`${storage}/`)) return true
  for (const prefix of STORAGE_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true
  }
  return normalized === '/storage' || normalized.startsWith('/storage/')
}

function storageHomeFor(path) {
  const normalized = normalizePath(path)
  const crumbs = ancestryCrumbs(normalized)
  for (const crumb of crumbs) {
    const crumbPath = normalizePath(crumb.path)
    if (STORAGE_PREFIXES.includes(crumbPath) || crumbPath === storageRoot()) return crumbPath
  }
  return storageRoot()
}

function isUnderHome(path) {
  const home = normalizePath(homedir())
  const normalized = normalizePath(path)
  return normalized === home || normalized.startsWith(`${home}/`)
}

function ancestryCrumbs(target) {
  const crumbs = []
  let current = normalizePath(target)
  for (;;) {
    const parent = dirname(current)
    crumbs.unshift({
      name: parent === current ? current : basename(current),
      path: current,
      hidden: false,
    })
    if (parent === current) break
    current = parent
  }
  return crumbs
}

async function bridgeCall(method, fields, signal) {
  const t = token()
  if (!t) throw new DirectoryPickerError('directory-unreadable', fields.path ?? ROOTS, 'Android bridge token is missing')
  let response
  try {
    response = await fetch(BRIDGE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': t },
      body: JSON.stringify({ method, ...fields }),
      signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new DirectoryPickerError('directory-unreadable', fields.path ?? ROOTS, `无法连接 Android 文件桥接：${message}`)
  }
  const body = await response.json()
  if (!response.ok) {
    throw new DirectoryPickerError('directory-unreadable', fields.path ?? ROOTS, body.error ?? `bridge HTTP ${response.status}`)
  }
  return body
}

async function listStorageDirectory(path, signal) {
  const result = await bridgeCall('listDirectory', { path }, signal)
  const resolved = normalizePath(result.path ?? path)
  const entries = (result.entries ?? []).map((entry) => ({
    name: entry.name,
    path: entry.path,
    hidden: Boolean(entry.hidden),
  }))
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return {
    path: resolved,
    home: storageHomeFor(resolved),
    crumbs: ancestryCrumbs(resolved),
    entries,
    truncated: Boolean(result.truncated),
  }
}

function anchorHome(listing, path) {
  const anchor = isSharedStoragePath(path) ? storageHomeFor(listing.path ?? path)
    : isUnderHome(path) ? normalizePath(homedir()) : null
  const crumbs = listing.crumbs ?? ancestryCrumbs(listing.path ?? path)
  const index = anchor == null ? -1 : crumbs.findIndex((crumb) => crumb.path === anchor)
  listing.home = ROOTS
  listing.crumbs = [
    { name: '存储位置', path: ROOTS, hidden: false },
    ...(index === -1 ? crumbs : crumbs.slice(index)),
  ]
  return listing
}

async function probeDirectory(path, signal) {
  try {
    await bridgeCall('listDirectory', { path }, signal)
    return true
  } catch {
    return false
  }
}

class AndroidBrowseDirectoryPicker extends BrowseDirectoryPicker {
  capability() {
    const base = super.capability()
    return {
      ...base,
      list: (path, signal) => this.androidList(path, signal, base.list),
    }
  }

  async androidList(path, signal, baseList) {
    path = normalizePath(path)
    if (path == null || path === '' || path === ROOTS || path === '/') return await this.listRoots(signal)
    if (isSharedStoragePath(path)) return anchorHome(await listStorageDirectory(path, signal), path)
    const listing = await baseList(path, signal)
    return anchorHome(listing, path)
  }

  async createDirectory(path, name) {
    const normalized = normalizePath(path)
    if (normalized == null || normalized === '' || normalized === ROOTS || normalized === '/') {
      throw new DirectoryPickerError('directory-create-failed', path ?? ROOTS, '请先选择内部存储或应用数据中的文件夹，再新建文件夹')
    }
    return await super.createDirectory(normalized, name)
  }

  async listRoots(signal) {
    const storage = storageRoot()
    const home = normalizePath(homedir())
    // Keep the entry visible even before permission is granted. Opening it reports
    // the bridge's actionable error instead of silently hiding phone storage.
    const entries = [{ name: '内部存储 (emulated)', path: storage, hidden: false }]
    if (await probeDirectory(home, signal)) {
      entries.push({ name: '应用数据', path: home, hidden: false })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return {
      path: ROOTS,
      home: ROOTS,
      crumbs: [{ name: '存储位置', path: ROOTS, hidden: false }],
      entries,
      truncated: false,
    }
  }
}

export default AndroidBrowseDirectoryPicker
