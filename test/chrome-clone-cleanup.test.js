/** @pullboard-test-gui */
/** Private clone fixtures prove cleanup custody; real Chrome proves native graceful shutdown [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepChromeClones } from '../src/chrome-clone-cleanup.js';
import { chromeLaunchArgs } from './chrome-launch-args.js';
import { findChromeExecutable } from './chrome-fixture.js';
import { launchChromeProcess } from './chrome-fixture.js';
import { startFixtureChild } from './fixture-child.js';

/** Keep every fixture and observation inside a unique private directory. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-clone-cleanup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const namespace = join(root, 'clones');
  mkdirSync(namespace, { mode: 0o700 });
  const clone = join(namespace, 'code_sign_clone.Abc123');
  mkdirSync(clone, { mode: 0o700 });
  writeFileSync(join(clone, 'held'), 'private clone fixture');
  return { root, namespace, clone };
}

/** Observe only a private fixture child's open files; never census or sweep the shared native namespace. */
function fixtureCustody(child, clone) {
  try { process.kill(child.pid, 0); } catch (error) {
    return error.code === 'ESRCH' ? { browserLive: false, paths: [] } : null;
  }
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-p', String(child.pid), '-Fn'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0 || result.stderr.trim()) return null;
  return { browserLive: false, paths: result.stdout.split('\n').filter(line => line.startsWith(`n${clone}/`)).map(line => line.slice(1)) };
}

test('killed private browser fixture leaves an old clone removed after its real FD owner exits [C7]', { timeout: 15000 }, async t => {
  const { namespace, clone } = fixture(t);
  // This is a browser-process stand-in; it does not claim to create a native code-sign clone.
  const child = startFixtureChild(process.execPath, ['-e',
    "require('node:fs').openSync(process.argv[1], 'r'); process.send('ready'); setInterval(() => {}, 1000)", join(clone, 'held')],
  { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await once(child, 'message');
  const custody = () => fixtureCustody(child, clone);
  const held = custody();
  assert.ok(held?.paths.includes(join(clone, 'held')), 'native lsof must identify the actual private open FD');
  const options = { directories: [namespace], custody, now: Date.now() + 3600001, log() {} };
  assert.equal((await sweepChromeClones(options)).removed, 0);
  assert.ok(existsSync(clone), 'live process clone stays intact');
  child.kill('SIGKILL');
  await closed;
  assert.equal((await sweepChromeClones(options)).removed, 1);
  assert.equal(existsSync(clone), false);
});

test('young clones, symlinks, live Chrome and unknown census never authorize removal [C7]', async t => {
  const { root, namespace, clone } = fixture(t);
  const link = join(namespace, 'code_sign_clone.Def456');
  symlinkSync(root, link);
  const options = { directories: [namespace], custody: () => ({ browserLive: false, paths: [] }), log() {} };
  assert.equal((await sweepChromeClones(options)).removed, 0, 'young directory is protected');
  for (const custody of [() => null, () => ({ browserLive: true, paths: [] })]) {
    assert.equal((await sweepChromeClones({ ...options, custody, now: Date.now() + 3600001 })).removed, 0);
    assert.ok(existsSync(clone));
  }
  assert.ok(existsSync(link), 'symlink target is never traversed or deleted');
});

test('fixture close quits actual Chrome cleanly before any signal fallback [C7]', { timeout: 40000 }, async t => {
  const { root } = fixture(t);
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  const launched = launchChromeProcess({ executable: findChromeExecutable(), args: chromeLaunchArgs(profile) });
  t.after(() => launched.close());
  const deadline = Date.now() + 30000;
  while (!existsSync(join(profile, 'DevToolsActivePort')) && Date.now() < deadline) {
    assert.equal(launched.child.exitCode, null, launched.stderr);
    assert.equal(launched.child.signalCode, null, launched.stderr);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(join(profile, 'DevToolsActivePort')), launched.stderr);
  await launched.close();
  assert.equal(launched.child.exitCode, 0, 'Browser.close must produce a clean native exit');
  assert.equal(launched.child.signalCode, null, 'a signal fallback is not graceful proof');
});
