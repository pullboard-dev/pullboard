/** A pulled gate or shard job carries the board ledger's hits, and its runner reuses a proven file with an empty store [P7,CD2]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { claimJob } from '../../../../packages/api/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { phaseLedger } from '../../../../packages/gate/index.js';
import { planTestActions } from '../../../../packages/gate/index.js';
import { ledgerHits } from '../../../../packages/store/index.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const GREEN = 'packages/gate/tests/io/test/action/memo.test.js';
const RED = 'packages/gate/tests/io/test/account/ledger.test.js';

/** This process's environment without any enclosing run's reuse or ledger variables, on a fresh empty result store. */
function cleanEnv(store, extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PULLBOARD_(TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)|LEDGER_HITS)$/u.test(name))),
    PULLBOARD_TEST_RESULT_STORE: store, ...extra };
}

/** Plan a run of both files at HEAD and return what it wrote and which file selectors it kept. */
async function plan(env) {
  const written = [];
  const files = [GREEN, RED].map(file => `./${file}`);
  const result = await planTestActions(ROOT, files, { fullSuite: false, listFiles: () => files, env, write: text => written.push(text) });
  return { text: written.join(''), args: result.args };
}

/** Post one pulled gate receipt through the board's queue, as a runner does. */
function postGate(board, job, ledger) {
  offerJob(board.db, { id: job, kind: 'gate', needs: [], now: 1 });
  const held = claimJob(board.db, { runner: 'r-controller', capabilities: [], now: 2 });
  return boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-controller', token: held.token,
    receipt: { version: 1, status: 1, gate: { source: HEAD, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: RED, name: 'a failing case' }], ledger }] } } }, { mode: 'pull', now: 3 });
}

test('clause 1: a pulled gate on a runner with an empty store reuses a file the controller proved at the same inputKey and runs only the rest [P7,CD2]', { timeout: 180_000 }, // budget: two files' import closures keyed at HEAD three times.
async t => {
  const scratch = privateFixtureFiles('pullboard-ledger-hits-').root;
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // The controller's run: GREEN passed and RED failed, each at its real inputKey and context class.
  const proved = await plan(cleanEnv(join(scratch, 'controller'), { PULLBOARD_TEST_REUSE: 'record' }));
  const ledger = phaseLedger(proved.text, { status: 1, failures: [{ file: RED, name: 'a failing case' }] });
  assert.ok(ledger, `the controller's run printed keyed frames: ${proved.text.slice(0, 2000)}`);
  const board = cellBoard(t, ':memory:');
  assert.equal(postGate(board, 'gate:51:ledger', ledger).recorded, true);

  // The job's hit list names only the proven green: the red file's fail row is never a hit.
  const hits = ledgerHits(board.db, [GREEN, RED]);
  assert.deepEqual(hits.files.map(([file]) => file), [GREEN], 'only the passing file is a hit');
  const hitFile = join(scratch, 'hits.json');
  writeFileSync(hitFile, JSON.stringify(hits));

  // A runner with an empty store and the job's hit list reuses GREEN and runs only RED.
  const ran = await plan(cleanEnv(join(scratch, 'runner'), { PULLBOARD_LEDGER_HITS: hitFile }));
  assert.match(ran.text, new RegExp(`# reused [0-9a-f]{64} from ledger \\(${GREEN.replaceAll('.', '\\.')}\\)`), ran.text.slice(0, 2000));
  assert.deepEqual(ran.args, [`./${RED}`], 'only the miss runs');

  // A hit under another context class is a miss: both files run.
  writeFileSync(hitFile, JSON.stringify({ ...hits, contexts: hits.contexts.map(() => 'f'.repeat(64)) }));
  const foreign = await plan(cleanEnv(join(scratch, 'foreign'), { PULLBOARD_LEDGER_HITS: hitFile }));
  assert.deepEqual(foreign.args, [GREEN, RED].map(file => `./${file}`), 'a foreign context reuses nothing');
});

test('clause 1: the hit list leaves out a key that also failed, and fits its byte budget [P7]', t => {
  const board = cellBoard(t, ':memory:');
  const key = 'a'.repeat(64), other = 'b'.repeat(64), context = 'c'.repeat(64);
  postGate(board, 'gate:52:ledger', { contexts: [context], files: [['x.test.js', key, 0, 'pass'], ['y.test.js', other, 0, 'pass']], omitted: 0 });
  postGate(board, 'gate:53:ledger', { contexts: [context], files: [['x.test.js', key, 0, 'fail']], omitted: 0 });
  assert.deepEqual(ledgerHits(board.db, ['x.test.js', 'y.test.js']).files, [['y.test.js', other, 0]], 'a key with a fail row is never a hit');
  assert.equal(ledgerHits(board.db, ['y.test.js'], { budget: 10 }), null, 'nothing fits a tiny budget');
  assert.equal(ledgerHits(board.db, []), null);
});
