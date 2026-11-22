/** @pullboard-test-input source-tree */
/** Exercise capacity registration through a real pinned worker and real SQLite contention [C7,#12952]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../../../../packages/gate/tests/fixtures/child.js';
import { HOST } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';

/** Hold the runner's actual capacity database until its real registration SQL reports the lock. */
function registrationUnderLock(t) {
  const box = cellProject(t, { gate: 'true' });
  const bin = join(box.dir, 'bin');
  const worker = join(box.dir, 'worker');
  const home = join(box.dir, 'runner-home');
  const machineHome = join(home, '.pullboard');
  const observed = join(box.dir, 'registration-busy.json');
  const preload = join(box.dir, 'observe-registration.mjs');
  for (const directory of [bin, worker, machineHome]) mkdirSync(directory, { recursive: true });
  // Observe the genuine SQLite exception, never replace an operation or manufacture a refusal.
  writeFileSync(preload, `import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
const original = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  try { return original.call(this, sql); }
  catch (error) {
    if (String(sql).startsWith('PRAGMA journal_mode = WAL;') && [5, 6].includes(error.errcode & 255)) {
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
  const runners = pathToFileURL(join(import.meta.dirname, '../../../../../packages/runners/index.js')).href;
  const source = `
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, watch } from 'node:fs';
import { runOnRunnerAsync } from ${JSON.stringify(runners)};
const observed = ${JSON.stringify(observed)};
const db = new DatabaseSync(${JSON.stringify(join(machineHome, 'resources.sqlite'))});
db.exec('BEGIN EXCLUSIVE');
let held = true;
const release = () => { if (held) { db.exec('ROLLBACK'); held = false; } };
const watcher = watch(${JSON.stringify(box.dir)}, () => { if (existsSync(observed)) release(); });
try {
  const runner = { host: ${JSON.stringify(HOST)}, node: process.execPath, slots: 1, browser: 0 };
  const outcome = await runOnRunnerAsync(${JSON.stringify(box.repo)}, 'printf capacity-job; exit 3', { runner })
    .then(result => ({ exitCode: result.exitCode, output: result.output, kind: result.executionReceipt?.kind }),
      error => ({ refused: error.code, message: error.message }));
  console.log(JSON.stringify({ observation: existsSync(observed) ? JSON.parse(readFileSync(observed, 'utf8')) : null, outcome }));
} finally { watcher.close(); release(); db.close(); }
`;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, result.failure || result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('runner.capacity-startup.real-registration-lock-reaches-job: clause 1: a real startup registration SQLite lock releases after the observed failure and the worker executes its real job [C7,#12952]', { timeout: 140_000 }, t => {
  const actual = registrationUnderLock(t);
  assert.deepEqual(actual.observation, { sqliteCode: 5, registration: true, startup: true, operation: 'journal_mode WAL' },
    'the genuine SQLite lock is observed specifically inside capacity registration at the real worker startup');
  assert.deepEqual(actual.outcome, { exitCode: 3, output: 'capacity-job', kind: 'runner-completion' },
    'the same worker proceeds from transient registration contention to the real command and terminal result');
});
