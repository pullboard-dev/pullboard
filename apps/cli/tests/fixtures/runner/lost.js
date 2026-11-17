/** @pullboard-test-loads packages/runners/src/io/dispatch.js */
/** @pullboard-test-loads packages/runners/src/io/health.js */
/** @pullboard-test-loads packages/runners/index.js */
/** @pullboard-test-loads apps/runner/src/io/scripts/worker.js */
/** @pullboard-test-loads apps/runner/src/io/controller.js */
/** @pullboard-test-loads packages/gate/src/io/main.js */
/** @pullboard-test-loads packages/runners/index.js */
/** @pullboard-test-loads packages/landing/index.js */
/** Exact job observations and owned SSH teardown, registered by the combined orphan-recovery check [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runnerJobReply } from '../../../../../packages/runners/index.js';
import { processCensus } from '../../../../runner/index.js';
import { isolateTestMachine } from '../../../../../packages/gate/index.js';
import { createE2eHelpers } from '../e2e.js';
import { waitForCondition } from './holders.js';

/** A private native project, SSH namespace and fixture-only model; real machine settings are never altered. */
function project(t) {
  const helpers = createE2eHelpers(), sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Test Model';
  isolateTestMachine(sandbox.env, sandbox.dir);
  const box = helpers.project('true', sandbox, { withWorktree: false });
  const record = join(box.dir, 'job.json');
  t.after(async () => {
    let owned = [];
    try {
      ({ owned = [] } = JSON.parse(readFileSync(record, 'utf8')));
      for (const owner of owned) {
        if (processCensus()?.get(owner.pid)?.started !== owner.started) continue;
        for (const signal of ['SIGTERM', 'SIGKILL']) { try { process.kill(owner.pid, signal); } catch { /* This exact owned fixture process already exited. */ } }
      }
    } catch { /* Setup may fail before this private fixture creates any process. */ }
    if (owned.length) await waitForCondition(() => {
      const census = processCensus();
      return census && owned.every(owner => { const found = census.get(owner.pid); return !found || found.started !== owner.started || found.state?.startsWith('Z'); });
    }, 'owned runner fixture processes exit', { signal: AbortSignal.timeout(5_000) }); // Budget: bounded drain of the fixture's exact owned processes.
    helpers.cleanup();
  });
  return { ...box, record };
}

/** Register meaningful native-boundary cases without dispatching another test command or claiming board work. */
export function registerRunnerJobLostTests() {
  test('exact job status distinguishes owner identity from unknown observations without certifying cleanup [C7,H16]', t => {
    const box = project(t), root = join(box.dir, 'status'), recovery = { version: 1, request: randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64), launchFence: 1 };
    const directory = join(root, 'recovery-launches', recovery.request); mkdirSync(directory, { recursive: true });
    const file = join(directory, 'startup.json'), owner = { pid: 12345, started: 'Thu Oct 29 12:00:00 2026' };
    writeFileSync(file, JSON.stringify({ ...recovery, owner }));
    const request = { nonce: randomUUID(), job: recovery.request, recovery };
    const row = { ...owner, state: 'S' };
    const observe = (value, inspect = () => {}) => runnerJobReply(root, request, { census: () => value, inspect });
    assert.equal(observe(new Map([[owner.pid, row]])).state, 'running');
    assert.equal(observe(new Map([[owner.pid, { ...row, started: 'Fri Oct 30 12:00:00 2026' }]])).state, 'gone');
    assert.equal(observe(new Map([[owner.pid, { ...row, state: 'Z' }]])).state, 'gone');
    assert.equal(observe(new Map(), () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }).state, 'gone');
    assert.equal(observe(new Map(), () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }).state, 'unknown');
    assert.equal(observe(null).state, 'unknown');
    assert.equal(runnerJobReply(root, { ...request, job: randomUUID() }, { census: () => new Map() }).state, 'unknown');
    writeFileSync(file, JSON.stringify({ ...recovery, owner: { ...owner, started: 'malformed' } }));
    assert.equal(observe(new Map()).state, 'unknown');
    writeFileSync(file, JSON.stringify({ ...recovery, nonce: randomUUID(), owner }));
    assert.equal(observe(new Map()).state, 'unknown');
    assert.equal(observe(new Map()).cleanup, false);
  });
}
