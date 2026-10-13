import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundlePatchPaths, loadOverlayPatches, composeEntries } from '@deepseek-ai/dsh-app-boot';

test('plugin manifest declares a loadable Harness bundle with the peer component', () => {
  const packageDir = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.dsh.bundle, 'plugin manager requires dsh.bundle');
  const paths = bundlePatchPaths(packageDir, manifest.dsh.bundle);
  const patches = paths.flatMap(path => loadOverlayPatches('dsh', path));
  assert.ok(patches.some(patch => patch.insert?.some(row => row.id === 'dsh-peer' && row.name === 'dsh-peer')));
  assert.ok(manifest.files.includes('cordis.patch.yml'));
});

test('Android config supplies the pairing server to the peer component', () => {
  const source = new URL('../../android.patch.template.yml', import.meta.url);
  const asset = new URL('../../../app/src/main/assets/android.patch.template.yml', import.meta.url);
  assert.equal(readFileSync(source, 'utf8'), readFileSync(asset, 'utf8'));
  const patches = loadOverlayPatches('dsh', fileURLToPath(source));
  const peer = patches.flatMap(patch => patch.insert || []).find(row => row.id === 'dsh-peer');
  assert.equal(peer.config.signalingServer, 'ws://dshanp2p.chiyang001.top/peer');
  assert.equal(peer.config.signalingAddress, undefined, 'Android should use its system DNS instead of a pinned address');
  assert.equal(peer.config.connectionMode, 'auto');
});
