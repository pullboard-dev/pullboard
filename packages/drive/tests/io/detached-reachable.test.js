/** The dispatcher check starts through spawnReachable on the reachable path and stays a plain detached spawn otherwise [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDetachedCheck } from '../../index.js';
import { startReachableCheck } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { waitForCondition } from '../../../gate/tests/fixtures/runner/holders.js';

/** A private folder, removed after the test. */
function folder(t) {
  const root = privateFixtureFiles('pullboard-detached-reachable-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A script that records its own pid as the only content of `out`. */
function pidScript(root, out) {
  const script = join(root, 'check.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, String(process.pid));\n`);
  return script;
}

test('drive.detached-reachable.reachable-start-through-launcher: clause 1: startReachableCheck starts the entry through spawnReachable, a stub launcher receives the bootstrap call, and the returned pid is the stub job pid [C7]', async t => {
  const root = folder(t), calls = [];
  const entry = pidScript(root, join(root, 'never.txt'));
  const launcher = async args => { calls.push(args[0]); return args[0] === 'print' ? { status: 0, stdout: '\tpid = 4242\n' } : { status: 0, stdout: '' }; };
  const pid = await startReachableCheck(entry, { args: ['--wake'], cwd: root, home: root, launchd: true, launcher });
  assert.equal(pid, 4242, 'the pid is the launchd job process the stub reported');
  assert.ok(calls.includes('bootstrap'), 'the launchd bootstrap was asked for');
  const plist = readFileSync(join(root, 'launchd', readdirLabel(root)), 'utf8');
  assert.ok(plist.includes(entry) && plist.includes('--wake'), 'the job runs the entry with its arguments');
});

test('drive.detached-reachable.setting-off-plain-detached: clause 2: startDetachedCheck still does a plain detached spawn that never touches launchd [C7]', async t => {
  const root = folder(t), out = join(root, 'pid.txt');
  const pid = startDetachedCheck(pidScript(root, out), { cwd: root });
  assert.ok(Number.isSafeInteger(pid), 'a pid comes back at once');
  await waitForCondition(() => existsSync(out), 'the detached check ran');
  assert.equal(Number(readFileSync(out, 'utf8')), pid, 'the returned pid is the check process itself');
  assert.equal(existsSync(join(root, 'launchd')), false, 'no launchd job file is written');
});

/** The one job file name in the launchd folder under `root`. */
function readdirLabel(root) {
  return readdirSync(join(root, 'launchd')).find(name => name.endsWith('.plist'));
}
