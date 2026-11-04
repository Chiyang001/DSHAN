const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')
const { packageManager, parseRefs, readGitRefs, patchPnpmSource } = require('./android-package-manager.cjs')
const semver = require('./node_modules/npm/node_modules/semver')
const sha = 'a'.repeat(40)
const other = 'b'.repeat(40)
const packet = value => Buffer.concat([Buffer.from((Buffer.byteLength(value) + 4).toString(16).padStart(4, '0')), Buffer.from(value)])
const advertisement = (...lines) => Buffer.concat([packet('# service=git-upload-pack\n'), Buffer.from('0000'), ...lines.map(packet), Buffer.from('0000')])
const refs = advertisement(`${sha} HEAD\0symref=HEAD:refs/heads/main\n`, `${sha} refs/heads/main\n`, `${other} refs/heads/feature/中文\n`, `${other} refs/tags/v1.0.0\n`, `${sha} refs/tags/v1.0.0^{}\n`, `${other} refs/tags/v2.0.0\n`)
const response = body => new Response(body, { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })

test('Git packet reader preserves HEAD, Unicode branches and peeled annotated tags', () => {
  const parsed = parseRefs(refs)
  assert.equal(parsed.HEAD, sha)
  assert.equal(parsed['refs/heads/feature/中文'], other)
  assert.equal(parsed['refs/tags/v1.0.0^{}'], sha)
  for (const body of ['<html>', '0003', 'ffffabc', '0000']) assert.throws(() => parseRefs(Buffer.from(body)))
  assert.throws(() => parseRefs(advertisement('ERR repository not found\n')), /repository not found/)
})

test('HTTPS refs retry temporary failures and retain timeout/transport options', async () => {
  let calls = 0
  const waits = []
  const result = await readGitRefs('https://github.com/owner/repo.git', async (url, options) => {
    assert.equal(url, 'https://github.com/owner/repo.git/info/refs?service=git-upload-pack')
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.redirect, 'follow')
    if (++calls < 3) return new Response('', { status: 503 })
    return response(refs)
  }, { delay: async ms => waits.push(ms), onRetry: () => {} })
  assert.equal(result.HEAD, sha)
  assert.deepEqual(waits, [1000, 2000])
  assert.equal(calls, 3)
})

test('bad credentials, unsupported transports and permanent HTTP errors fail without Git or retries', async () => {
  for (const repo of ['ssh://git@example.com/repo', 'http://example.com/repo', 'https://token@github.com/owner/repo']) {
    await assert.rejects(readGitRefs(repo, () => { throw new Error('must not fetch') }), /HTTPS/)
  }
  let calls = 0
  await assert.rejects(readGitRefs('https://github.com/missing/repo', async () => {
    calls++
    return new Response('', { status: 404 })
  }), /HTTP 404/)
  assert.equal(calls, 1)
  await assert.rejects(readGitRefs('https://github.com/owner/repo', async () => new Response('<html>login</html>')), /未返回 Git 引用/)
})

test('oversized reference advertisements are cancelled before exhausting phone memory', async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(9 * 1024 * 1024)) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  await assert.rejects(readGitRefs('https://github.com/owner/repo', async () => response(body)), /16 MiB/)
  assert.equal(cancelled, true)
})

// Exercise the functions from the actual pinned pnpm bundle, including its
// own ref precedence and semver selection, with a deterministic HTTPS server.
function resolver() {
  const source = patchPnpmSource(readFileSync(join(__dirname, 'node_modules/pnpm/dist/pnpm.mjs'), 'utf8'))
  let requests = 0
  const context = {
    URL, URL5: URL, urlLib: require('node:url'),
    import_semver15: { default: semver },
    gitProtocols: new Set(['git', 'git+https', 'git+ssh', 'ssh']),
    __require: require,
    __commonJS: callbacks => {
      let mod
      return () => {
        if (!mod) { mod = { exports: {} }; Object.values(callbacks)[0](mod.exports, mod) }
        return mod.exports
      }
    },
    require_lru_cache: () => class extends Map { constructor() { super() } },
    __androidPackages: { readGitRefs },
    PnpmError: Error,
    gracefulGit: () => { throw new Error('Android must never spawn git') },
    fetchWithDispatcher: async (url, options) => {
      requests++
      assert.equal(options.dispatcherOptions.proxy, 'https://proxy.example')
      return response(refs)
    },
  }
  const parts = [
    source.slice(source.indexOf('var require_git_host_info2 ='), source.indexOf('// ../resolving/git-resolver/lib/parseBareSpecifier.js')),
    'const import_hosted_git_info = { default: require_hosted_git_info2() };',
    source.slice(source.indexOf('function parseBareSpecifier2('), source.indexOf('var import_hosted_git_info, gitProtocols;')),
    source.slice(source.indexOf('function createGitResolver('), source.indexOf('var import_semver15;')),
    source.slice(source.indexOf('async function pickFetcher('), source.indexOf('function isGitHostedPkgUrl(')),
    'this.resolve = createGitResolver({ proxy: "https://proxy.example" }); this.pick = pickFetcher;',
  ]
  vm.runInNewContext(parts.join('\n'), context)
  return { resolve: context.resolve, pick: context.pick, requests: () => requests }
}

test('public GitHub HTTPS, github shorthand and SSH shorthand resolve to an immutable archive without Git', async () => {
  for (const spec of ['https://github.com/owner/repo.git', 'git+https://github.com/owner/repo.git', 'github:owner/repo', 'owner/repo', 'git@github.com:owner/repo.git', 'git+ssh://git@github.com/owner/repo.git']) {
    const r = resolver()
    const result = await r.resolve({ bareSpecifier: spec }, {})
    assert.equal(result.resolution.tarball, `https://codeload.github.com/owner/repo/tar.gz/${sha}`, spec)
    assert.equal(result.resolution.gitHosted, true)
    assert.equal(r.requests(), 1)
  }
})

test('upstream resolver retains branch, annotated tag, semver, full commit and subdirectory semantics', async () => {
  for (const [suffix, commit, calls] of [
    ['#feature/中文', other, 1], ['#v1.0.0', sha, 1], ['#semver:^1.0.0', sha, 1],
    [`#${sha}`, sha, 0], ['#main&path:packages/plugin', sha, 1],
  ]) {
    const r = resolver()
    const result = await r.resolve({ bareSpecifier: 'github:owner/repo' + suffix }, {})
    assert.ok(result.resolution.tarball.endsWith(commit))
    assert.equal(r.requests(), calls)
    if (suffix.includes('path:')) assert.equal(result.resolution.path, 'packages/plugin')
  }
})

test('locked tarballs are reused offline and old Git locks fetch exactly their pinned commit without clone', async () => {
  const r = resolver()
  const tarball = `https://codeload.github.com/owner/repo/tar.gz/${other}`
  const currentPkg = { id: tarball, resolution: { tarball, integrity: 'sha512-pinned' } }
  const result = await r.resolve({ bareSpecifier: 'github:owner/repo' }, { currentPkg })
  assert.equal(result.resolution, currentPkg.resolution)
  assert.equal(r.requests(), 0)
  const oldLock = { type: 'git', repo: 'git@github.com:owner/repo.git', commit: other, path: 'plugin' }
  let fetched
  const fetcher = await r.pick({ gitHostedTarball: (_cafs, resolution) => { fetched = resolution } }, oldLock)
  await fetcher({}, oldLock, {})
  assert.equal(fetched.tarball, tarball)
  assert.equal(fetched.path, 'plugin')
  assert.equal(oldLock.type, 'git')
  const fresh = await r.resolve({ bareSpecifier: oldLock.repo }, {})
  assert.ok(fresh.resolution.tarball.endsWith(sha), 'fetching an old lock must not pin the hosted-info cache to that old commit')
  assert.equal(r.requests(), 1)
  await assert.rejects(r.pick({}, { type: 'git', repo: 'https://example.com/custom.git', commit: sha }), /Android/)
})

test('GitLab and Bitbucket use their own HTTPS archive templates', async () => {
  for (const [spec, url] of [
    ['gitlab:owner/repo', `https://gitlab.com/owner/repo/-/archive/${sha}/repo-${sha}.tar.gz`],
    ['bitbucket:owner/repo', `https://bitbucket.org/owner/repo/get/${sha}.tar.gz`],
  ]) {
    const result = await resolver().resolve({ bareSpecifier: spec }, {})
    assert.equal(result.resolution.tarball, url)
  }
})

test('pnpm changes fail with an actionable compatibility error instead of silently spawning Git', () => {
  assert.throws(() => patchPnpmSource('unrecognized pnpm bundle'), /不兼容/)
})

test('Android service invocation carries the DNS bridge token without forwarding unrelated credentials', () => {
  const result = packageManager('/kernel', { DSH_ANDROID_NODE: '/apk/libdshnode.so', HOME: '/home', TMPDIR: '/cache', DSH_ANDROID_BRIDGE_TOKEN: 'bridge', DEEPSEEK_API_KEY: 'secret' })
  assert.deepEqual(result, {
    command: '/apk/libdshnode.so', args: [join('/kernel', 'android-package-manager.cjs')],
    env: { LD_LIBRARY_PATH: '/apk', HOME: '/home', TMPDIR: '/cache', DSH_ANDROID_BRIDGE_TOKEN: 'bridge' },
  })
})

test('the actual Android bootstrap routes profile installation into the compatibility launcher', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dshan-npm-bootstrap-'))
  try {
    const boot = join(temp, 'node_modules/@deepseek-ai/dsh/lib/profile-boot-fixture.js')
    mkdirSync(require('node:path').dirname(boot), { recursive: true })
    writeFileSync(join(require('node:path').dirname(boot), 'package.json'), '{"type":"module"}')
    writeFileSync(boot, 'const options = { profile: "web" }; export const profile = { name: options.profile, };')
    const code = `Object.defineProperty(process, 'platform', { value: 'android' });
      require(${JSON.stringify(join(__dirname, 'mobile-bootstrap.cjs'))});
      import(${JSON.stringify(pathToFileURL(boot).href)}).then(({profile}) => {
        const assert = require('node:assert/strict');
        assert.equal(profile.packageManager.command, process.execPath);
        assert.ok(profile.packageManager.args[0].endsWith('android-package-manager.cjs'));
      }).catch(e => { console.error(e); process.exitCode = 1 });`
    const result = spawnSync(process.execPath, ['-e', code], {
      cwd: __dirname, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, DSH_HOME: join(temp, 'home'), DSH_ANDROID_NODE: process.execPath },
    })
    assert.equal(result.status, 0, result.stderr)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('real pnpm installs local packages without Git or build commands and skips incompatible optional binaries', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dshan-npm-local-'))
  try {
    const profile = join(temp, 'profile')
    const plugin = join(temp, 'plugin')
    const optional = join(temp, 'desktop-only')
    for (const dir of [profile, plugin, optional]) mkdirSync(dir)
    writeFileSync(join(profile, 'package.json'), '{"name":"android-npm-local-test","private":true}')
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    writeFileSync(join(optional, 'package.json'), JSON.stringify({ name: 'desktop-only', version: '1.0.0', os: ['!' + process.platform] }))
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: 'android-plugin-fixture', version: '1.0.0',
      scripts: { install: 'this-build-command-must-never-run' },
      optionalDependencies: { 'desktop-only': 'file:' + optional.replaceAll('\\', '/') },
    }))
    const result = spawnSync(process.execPath, [join(__dirname, 'android-package-manager.cjs'),
      'add', 'file:' + plugin.replaceAll('\\', '/'), '--store-dir=' + join(temp, 'store')], {
      cwd: profile, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: temp, TMPDIR: temp, PATH: join(temp, 'empty-path') },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.ok(require('node:fs').existsSync(join(profile, 'node_modules/android-plugin-fixture/package.json')))
    assert.equal(require('node:fs').existsSync(join(profile, 'node_modules/desktop-only')), false)
    assert.equal(require('node:fs').statSync(join(profile, 'node_modules/android-plugin-fixture/package.json')).nlink, 1)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
