/** @pullboard-test-input packages/runners/index.js */
/** Exercise capacity registration through a real pinned worker and real SQLite contention [C7,#12952]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { runOnRunnerAsync } from '../../../../../packages/runners/index.js';
import { withEnvironment } from '../../../../../packages/resources/index.js';
import { HOST } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';

/** Hold the runner's actual capacity database until its real registration SQL reports the lock. */
async function registrationUnderLock(t, mode = 'transient') {
  const box = cellProject(t, { gate: 'true' });
  const bin = join(box.dir, 'bin');
  const worker = join(box.dir, 'worker');
  const home = join(box.dir, 'runner-home');
  const machineHome = join(home, '.pullboard');
  const observed = join(box.dir, 'registration-busy.json');
  const preload = join(box.dir, 'observe-registration.mjs');
  const attempts = join(box.dir, 'registration-attempts.jsonl');
  for (const directory of [bin, worker, machineHome]) mkdirSync(directory, { recursive: true });
  // Observe the genuine SQLite exception, never replace an operation or manufacture a refusal.
  writeFileSync(preload, `import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const original = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  try { return original.call(this, sql); }
  catch (error) {
    if (String(sql).startsWith('PRAGMA journal_mode = WAL;') && [5, 6].includes(error.errcode & 255)) {
      appendFileSync(${JSON.stringify(attempts)}, JSON.stringify({ sqliteCode: error.errcode & 255 }) + '\\n');
      const previous = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      const stack = new Error().stack;
      Error.stackTraceLimit = previous;
      if (!existsSync(${JSON.stringify(observed)})) writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
        sqliteCode: error.errcode & 255, registration: stack.includes('registeredCapacity'),
        startup: stack.includes('/worker/entry.js'), operation: 'journal_mode WAL',
      }));
    }
    throw error;
  }
};\n`);
  installSshStandIn({ bin, worker, home, machineHome, requests: join(box.dir, 'requests.jsonl'),
    nodeCommand: process.execPath, nodeOptions: `--import=${pathToFileURL(preload).href}` });
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = await withEnvironment(env, async () => {
    const db = new DatabaseSync(join(machineHome, 'resources.sqlite'));
    db.exec('BEGIN EXCLUSIVE');
    let held = true;
    const release = () => { if (held) { db.exec('ROLLBACK'); held = false; } };
    const controller = new AbortController();
    // Preserve the former child-operation bound; a deadline cannot masquerade as the cancellation case.
    const deadline = AbortSignal.timeout(120_000);
    const watcher = watch(box.dir, () => {
      if (!existsSync(observed)) return;
      if (mode === 'transient') release();
      if (mode === 'cancel') controller.abort();
    });
    try {
      const runner = { host: HOST, node: process.execPath, slots: 1, browser: 0 };
      const outcome = await runOnRunnerAsync(box.repo, 'printf capacity-job; exit 3', { runner, signal: AbortSignal.any([controller.signal, deadline]) })
        .then(result => ({ exitCode: result.exitCode, output: result.output, kind: result.executionReceipt?.kind }),
          error => ({ refused: error.code ?? error.name, message: error.message }));
      deadline.throwIfAborted();
      return { status: 0, stdout: JSON.stringify({ observation: existsSync(observed) ? JSON.parse(readFileSync(observed, 'utf8')) : null, outcome,
        attempts: existsSync(attempts) ? readFileSync(attempts, 'utf8').trim().split('\n').filter(Boolean).length : 0 }) };
    } finally { watcher.close(); release(); db.close(); }
  });
  assert.equal(result.status, 0, result.failure || result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('runner.capacity-startup.real-registration-lock-reaches-job: clause 1: a real startup registration SQLite lock releases after the observed failure and the worker executes its real job [C7,#12952]', { timeout: 140_000 }, async t => {
  const actual = await registrationUnderLock(t);
  assert.deepEqual(actual.observation, { sqliteCode: 5, registration: true, startup: true, operation: 'journal_mode WAL' },
    'the genuine SQLite lock is observed specifically inside capacity registration at the real worker startup');
  assert.deepEqual(actual.outcome, { exitCode: 3, output: 'capacity-job', kind: 'runner-completion' },
    'the same worker proceeds from transient registration contention to the real command and terminal result');
});


test('runner.capacity-startup.permanent-registration-lock-exhausts-existing-budget: clause 2: permanent real registration contention stops after the existing eight attempts without executing the command [C7,#12952]', { timeout: 140_000 }, async t => {
  const actual = await registrationUnderLock(t, 'permanent');
  assert.equal(actual.observation.registration, true);
  assert.equal(actual.observation.startup, true);
  assert.equal(actual.attempts, 8, 'the existing retrySlotLocked default remains eight attempts');
  assert.equal(actual.outcome.refused, 'RUNNER_SETUP_REFUSED');
  assert.match(actual.outcome.message, /\[SLOT_DB_LOCKED\]/u);
  assert.equal(actual.outcome.output, undefined, 'a refused worker never claims the command executed');
});

test('runner.capacity-startup.transport-loss-stops-registration-retries: clause 2: actual transport cancellation after the first registration SQLite refusal stops further attempts and never executes the command [C7,#12952]', { timeout: 140_000 }, async t => {
  const actual = await registrationUnderLock(t, 'cancel');
  assert.equal(actual.observation.registration, true);
  assert.equal(actual.attempts, 1, 'the closed transport prevents a second registration attempt');
  assert.equal(actual.outcome.refused, 'RunnerDropped');
  assert.match(actual.outcome.message, /disconnected before a complete result/u);
  assert.equal(actual.outcome.output, undefined);
});
