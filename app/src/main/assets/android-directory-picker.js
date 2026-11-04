import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

/** Mount Android browse backend + standard browse UI surface. */
export const name = 'directory-picker-android'
export const inject = ['webServer', 'loader']

const SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const backend = fileURLToPath(new URL('./android-directory-picker-backend.js', import.meta.url))
const require = createRequire(import.meta.url)

// The upstream browser assumes every listing is a real directory. Android's
// storage-location page is navigation only, so it must never become an Open
// or New folder target. Adapt the active kernel before its UI is registered.
export function patchBrowseClient(source) {
  if (source.includes('/* dshan-directory-target-v1 */')) return source
  const replacements = [
    ['const targetPath = selected?.path ?? parent?.path ?? null;',
      '/* dshan-directory-target-v1 */\n' +
      '\t\t\tconst androidTargetPath = selected?.path ?? parent?.path ?? null;\n' +
      '\t\t\tconst targetPath = typeof androidTargetPath === "string" && androidTargetPath.startsWith("/") ? androidTargetPath : null;'],
    ['disabled: parent === null || loading || parentInert || draftPending,',
      'disabled: targetPath === null || loading || parentInert || draftPending,'],
    ['const base = selected?.path ?? parent.path;',
      'const base = targetPath ?? "/";'],
  ]
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error('当前内核的目录选择界面不兼容，请切回内置内核后重试')
    source = source.replace(before, after)
  }
  return source
}

export async function apply(ctx) {
  const client = require.resolve(`${SURFACE}/client`)
  const original = readFileSync(client, 'utf8')
  const updated = patchBrowseClient(original)
  if (updated !== original) {
    const temporary = `${client}.android.tmp`
    writeFileSync(temporary, updated)
    renameSync(temporary, client)
  }
  await ctx.effect(async () => {
    const ids = []
    const unmount = async () => {
      for (const id of [...ids].reverse()) {
        const entry = ctx.loader.store[id]
        if (entry === undefined) continue
        const disposal = entry.fiber?.dispose()
        ctx.loader.remove(id)
        await disposal
      }
    }
    try {
      for (const name of [backend, SURFACE]) {
        const id = await ctx.loader.create({ name })
        ids.push(id)
        const entry = ctx.loader.resolve(id)
        if (entry.fiber === undefined) throw new Error(`directory-picker-android: failed to load ${name}`)
        await entry.fiber.await()
      }
    } catch (cause) {
      await unmount()
      throw cause
    }
    return unmount
  }, 'directory-picker-android: interaction entries')
}
