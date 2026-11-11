/** @pullboard-test-input source-tree */
/** Prove a landing worker obtains a bounded identity receipt before its body [C7,V4]. */
import { copyPackageFiles } from '../../../index.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { stageFixtureTests } from '../../fixtures/tests.js';


/** Create an isolated runner tree with one tracked test file, so the regression exercises its own worker. */
function makeIdentityFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-worker-identity-overflow-')));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), root);
  const fixtureRunner = join(root, 'apps/cli/src/io/run/tests.js');
  assert.equal(realpathSync(fixtureRunner), fixtureRunner, 'the copied runner uses its physical path');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runner: fixtureRunner, workerTest: join(root, 'test/worker-start.test.js') };
}

test('a landing worker gets its identity without the oversized process census [C7,V4]', t => {
  const fixture = makeIdentityFixture(t);
  const preload = join(fixture.root, 'worker-snapshot-overflow.mjs');
  const calls = join(fixture.root, 'worker-snapshot-calls.jsonl');
  writeFileSync(fixture.workerTest, `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('worker identity is recorded before the file body [C7,V4]', () => {
  const receipts = readFileSync(process.env.PULLBOARD_LANDING_WORKER_STARTS, 'utf8').trim().split(/\\r?\\n/u).map(line => JSON.parse(line));
  const receipt = receipts.find(row => row.type === 'worker' && row.pid === process.pid);
  assert.ok(receipt?.pgid && receipt.started, 'the compact PID query produced a usable worker identity');
  const controls = readFileSync(process.env.PULLBOARD_C7_SNAPSHOT_CALLS, 'utf8').trim().split(/\\r?\\n/u).map(line => JSON.parse(line));
  const realPs = controls.find(row => row.type === 'real-ps-control' && row.pid === process.pid);
  assert.ok(realPs, 'the accepted identity came from a real ps response');
  assert.notEqual(realPs.widenedStarted, realPs.canonicalStarted, 'the successful ps row widened only legal whitespace');
  assert.equal(receipt.started, realPs.canonicalStarted, 'the accepted identity uses normalized real lstart fields');
  assert.equal(receipts.some(row => row.type === 'worker-identity-unavailable' && row.pid === process.pid), false);
});
`);
  stageFixtureTests(fixture.root, ['test/worker-start.test.js']);
  execFileSync('git', ['branch', '-M', 'main'], { cwd: fixture.root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Pullboard fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '-m', 'test: commit worker identity fixture'], { cwd: fixture.root, stdio: 'ignore' });
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
if (process.argv[1] !== ${JSON.stringify(fixture.runner)}) {
  const originalExec = childProcess.execFile;
  let pidQueries = 0;
  childProcess.execFile = (command, args, options, callback) => {
    if (command === 'ps' && args?.[0] === '-axo') {
      const error = new Error('simulated full process census exceeded execFile maxBuffer');
      error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      setImmediate(() => callback(error, '', ''));
      return undefined;
    }
    if (command === 'ps' && args?.[0] === '-p') {
      pidQueries += 1;
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ type: 'pid-query', pid: process.pid, args }) + '\\n');
      if (pidQueries === 1) {
        const wrongPid = process.pid + 1;
        const row = [wrongPid, process.ppid, process.pid, 'S', 'Thu Oct  2 12:34:56 2026'].join(' ');
        appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ type: 'wrong-pid-control', pid: process.pid, row }) + '\\n');
        setImmediate(() => callback(null, row + '\\n', ''));
        return undefined;
      }
      return originalExec(command, args, options, (error, stdout, stderr) => {
        if (error) { callback(error, stdout, stderr); return; }
        const match = stdout.trim().match(/^(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.+)$/u);
        if (!match) { callback(new Error('real ps returned an unexpected PID identity row'), stdout, stderr); return; }
        const canonicalStarted = match[5].trim().split(/\\s+/u).join(' ');
        const widenedStarted = match[5].trim().replace(/\\s+/gu, '  ');
        appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ type: 'real-ps-control', pid: Number(match[1]),
          canonicalStarted, widenedStarted }) + '\\n');
        callback(null, [match[1], match[2], match[3], match[4], widenedStarted].join(' ') + '\\n', stderr);
      });
    }
    return originalExec(command, args, options, callback);
  };
  syncBuiltinESMExports();
}
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1', PULLBOARD_C7_SNAPSHOT_CALLS: calls,
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  // The copied CLI is standalone; inherited test-worker context selects Node's binary event reporter.
  delete env.NODE_TEST_CONTEXT;
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/worker-start.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 25_000,
  });
  assert.equal(result.status, 0, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.match(result.stdout, /# fail 0/u);
  assert.match(result.stdout, /^ok \d+ - worker identity is recorded before the file body \[C7,V4\]$/mu,
    'the nested worker test ran and recorded identity before its body');
  const queries = readFileSync(calls, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const compactQueries = queries.filter(row => row.type === 'pid-query');
  const workerPid = compactQueries[0]?.pid;
  assert.ok(workerPid && compactQueries.length >= 2, 'a mismatched first row caused another compact identity query');
  assert.ok(compactQueries.every(row => row.args[1] === String(workerPid)
    && row.args[3] === 'pid=,ppid=,pgid=,stat=,lstart='),
  'the worker requested only its own compact process identity row');
  assert.ok(queries.some(row => row.type === 'wrong-pid-control'
    && row.row.startsWith(`${workerPid + 1} `) && row.row.includes('Oct  2 ')),
  'the fixture supplied a parseable row with legal single-digit-day spacing for the wrong PID');
});
