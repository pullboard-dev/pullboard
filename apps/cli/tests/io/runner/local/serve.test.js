/** The local runner is keyed to the home it serves: a refusal for a second runner of one home, and a runner for a home with none [P7,C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { anyRunnerLive } from '../../../../src/io/runner/local.js';
import { ensureLocalRunner } from '../../../../src/io/runner/local.js';
import { localRunnerFolder } from '../../../../src/io/runner/local.js';
import { localRunnerCommand } from '../../../../src/io/runner/local/serve.js';
import { privateFixtureFiles } from '../../../../../../packages/gate/tests/fixtures/child.js';

const NAMES = ['PULLBOARD_MACHINE_HOME', 'PULLBOARD_HOME'];

/** A private machine folder and the given home for the test, with the real environment restored after it. */
function machineWith(t, home) {
  const { root } = privateFixtureFiles('pullboard-runner-local-');
  const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]));
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine');
  process.env.PULLBOARD_HOME = home;
  t.after(() => {
    for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    rmSync(root, { recursive: true, force: true });
  });
  const folder = localRunnerFolder();
  mkdirSync(folder, { recursive: true });
  return folder;
}

/** Write a live runner's state under the name a home keys it to (the plain name for no home), held by this process. */
function liveRunner(folder, home) {
  const key = home === null ? '' : `-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
  writeFileSync(join(folder, `state${key}.json`), JSON.stringify({ pid: process.pid, runner: 'local-fixture', url: null, heartbeatAt: Date.now() }));
  mkdirSync(join(folder, `lock${key}`), { recursive: true });
}

test('cli.io-runner-local-serve.refusal-exits-nonzero: clause 1: serveLocal refuses LOCAL_RUNNER_RUNNING with a next line when a live runner already serves this home, so the exit is non-zero [P7,C7]', async t => {
  const folder = machineWith(t, '/fixture/home-a');
  liveRunner(folder, '/fixture/home-a');
  await assert.rejects(() => localRunnerCommand({ say() {} }), error => {
    assert.equal(error.code, 'LOCAL_RUNNER_RUNNING');
    assert.match(error.message, new RegExp(`pid ${process.pid}`, 'u'));
    assert.match(error.next, /pullboard runner list/u);
    return true;
  });
});

test('cli.io-runner-local-serve.other-home-gets-runner: clause 2: ensureLocalRunner starts a runner and anyRunnerLive reports none for a home with no runner while another home runner is alive on the machine [P7,C7]', async t => {
  const folder = machineWith(t, '/fixture/home-b');
  liveRunner(folder, '/fixture/home-a');
  assert.equal(anyRunnerLive(), false, 'the other home runner is not this home runner');
  const started = [];
  const result = await ensureLocalRunner(join(folder, 'board'), { start: async root => { started.push(root); return 4242; } });
  assert.equal(result.started, true);
  assert.equal(result.pid, 4242);
  assert.equal(started.length, 1);
  liveRunner(folder, '/fixture/home-b');
  assert.equal(anyRunnerLive(), true, 'a live runner of this home counts');
});
