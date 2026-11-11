/** Private clone fixtures prove cleanup custody [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepChromeClones } from '../../src/io/chrome.js';
import { startFixtureChild } from '../../../cli/tests/fixtures/child.js';

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
    "process.on('message', () => { require('node:fs').openSync(process.argv[1], 'r'); process.send('opened'); }); process.send('ready'); setInterval(() => {}, 1000)", join(clone, 'held')],
  { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await once(child, 'message');
  const custody = () => fixtureCustody(child, clone);
  const before = lstatSync(clone).mtimeMs;
  let observations = 0;
  /** Open the real private FD only after the initial snapshot, preserving the directory timestamp. */
  const racingCustody = async () => {
    const observed = custody();
    if (++observations === 1) {
      assert.ok(observed && !observed.paths.includes(join(clone, 'held')));
      const opened = once(child, 'message');
      child.send('open');
      await opened;
    }
    return observed;
  };
  const options = { directories: [namespace], custody, now: Date.now() + 3600001, log() {} };
  assert.equal((await sweepChromeClones({ ...options, custody: racingCustody })).removed, 0);
  assert.ok(observations >= 2, 'removal requires a fresh second custody observation');
  assert.ok(custody()?.paths.includes(join(clone, 'held')), 'native lsof identifies the newly opened private FD');
  assert.equal(lstatSync(clone).mtimeMs, before, 'read-only FD opening did not change directory age');
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
  assert.equal((await sweepChromeClones({ ...options, now: Date.now() + 3600001, deadline: Date.now() - 1 })).removed, 0,
    'expired cleanup budget never authorizes removal');
  let observations = 0;
  const changing = () => {
    if (++observations === 2) utimesSync(clone, new Date(), new Date(Date.now() + 7200000));
    return { browserLive: false, paths: [] };
  };
  assert.equal((await sweepChromeClones({ ...options, custody: changing, now: Date.now() + 3600001 })).removed, 0,
    'a directory changed after initial custody must be preserved');
});
