// Run with the APK's Node launcher in a disposable runtime directory containing
// android-package-manager.cjs, android-network.cjs and node_modules/pnpm.
// Uses public packages and temporary profiles only; never edits the app profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const runtime = path.resolve(process.argv[2] || path.join(__dirname, '..', 'runtime'))
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dshan-npm-smoke-'))
const profile = path.join(root, 'profile')
const env = { ...process.env, HOME: root, TMPDIR: root, PATH: process.platform === 'win32' ? path.join(root, 'empty-path') : '/system/bin:/system/xbin' }
const run = args => {
  const result = spawnSync(process.execPath, [path.join(runtime, 'android-package-manager.cjs'), ...args,
    '--store-dir=' + path.join(root, 'store')], {
    cwd: profile, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
}

try {
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dshan-npm-smoke', private: true }))
  fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const git = spawnSync('git', ['--version'], { env, encoding: 'utf8' })
  assert.equal(git.error?.code, 'ENOENT', 'smoke test must run without git on PATH')
  console.log('ANDROID_NPM_SMOKE: install the reported GitHub theme without git')
  run(['add', 'https://github.com/Chiyang001/dsh-codsh-theme.git'])
  const installed = path.join(profile, 'node_modules/dsh-codsh-theme')
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-codsh-theme')
  assert.ok(fs.statSync(path.join(installed, 'dist/client.js')).size > 0)
  assert.match(fs.readFileSync(path.join(profile, 'pnpm-lock.yaml'), 'utf8'), /codeload\.github\.com.*[0-9a-f]{40}/)

  console.log('ANDROID_NPM_SMOKE: reinstall from the lockfile/cache offline')
  fs.rmSync(path.join(profile, 'node_modules'), { recursive: true, force: true })
  run(['install', '--offline', '--frozen-lockfile'])
  assert.ok(fs.existsSync(path.join(installed, 'index.js')))

  console.log('ANDROID_NPM_SMOKE: install a regular registry package')
  run(['add', 'is-number@7.0.0', '--registry=https://registry.npmmirror.com'])
  assert.equal(require(path.join(profile, 'node_modules/is-number'))(42), true)

  console.log('ANDROID_NPM_SMOKE: a package install script must not execute')
  const fixture = path.join(root, 'fixture')
  fs.mkdirSync(fixture)
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
    name: 'dshan-install-script-fixture', version: '1.0.0',
    scripts: { install: 'this-command-does-not-exist-on-android' },
  }))
  run(['add', 'file:' + fixture])
  assert.ok(fs.existsSync(path.join(profile, 'node_modules/dshan-install-script-fixture/package.json')))
  console.log(`ANDROID_NPM_SMOKE_OK: ${manifest.name}@${manifest.version}; GitHub, offline reinstall, registry and skipped build script`)
} finally {
  assert.ok(path.basename(root).startsWith('dshan-npm-smoke-'))
  fs.rmSync(root, { recursive: true, force: true })
}
