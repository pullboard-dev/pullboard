/** A posted gate or shard receipt writes one proof-ledger row per file it ran, keyed by inputKey and context class [P7,CD2]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { phaseLedger } from '../../../gate/index.js';
import { planTestActions } from '../../../gate/index.js';
import { testActionKeys } from '../../../gate/index.js';
import { testResults } from '../../../store/index.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const GREEN = 'packages/gate/tests/io/test/action/memo.test.js';
const RED = 'packages/gate/tests/io/test/account/ledger.test.js';

/** The per-file frames a record-only run of both files prints at HEAD, from a scratch result store, with each file's inputKey. */
async function ranFrames() {
  const store = privateFixtureFiles('pullboard-ledger-').root;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PULLBOARD_TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)$/u.test(name))),
    PULLBOARD_TEST_RESULT_STORE: store, PULLBOARD_TEST_REUSE: 'record' };
  try {
    const written = [];
    const files = [GREEN, RED];
    await planTestActions(ROOT, files.map(file => `./${file}`), { fullSuite: false, listFiles: () => files.map(file => `./${file}`), env: { ...env }, write: text => written.push(text) });
    const keys = await testActionKeys(ROOT, { commit: HEAD, files, env, maintain: false });
    return { text: written.join(''), keys: new Map(files.map(file => [file, keys.get(file).inputKey])) };
  } finally { rmSync(store, { recursive: true, force: true }); }
}

/** Offer one job of a kind, claim it as a runner and post a receipt through the board API's queue, as a runner does. */
function postThrough(board, { id, kind, receipt }) {
  offerJob(board.db, { id, kind, needs: [], now: 1 });
  const held = claimJob(board.db, { runner: 'r-ledger', capabilities: [], now: 2 });
  return boardJobQueueCall(board, { action: 'receipt', job: id, runner: 'r-ledger', token: held.token, receipt }, { mode: 'pull', now: 3 });
}

test('clause 1: after one pulled gate job posts, the board holds one row per run file with its inputKey and context class, green files of a red job included [P7]', { timeout: 120_000 }, // budget: two files' import closures keyed at HEAD.
async t => {
  const { text, keys } = await ranFrames();
  // The proof phase was red in one file's case only: the other file's green still counts (313 of 386 wasted reruns, 11 Nov).
  const ledger = phaseLedger(text, { status: 1, failures: [{ file: RED, name: 'a failing case' }] });
  assert.ok(ledger, `the run printed keyed frames: ${text.slice(0, 2000)}`);
  const board = cellBoard(t, ':memory:');
  const job = 'gate:41:ledger';
  const posted = postThrough(board, { id: job, kind: 'gate', receipt: { version: 1, status: 1, gate: { source: HEAD, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: RED, name: 'a failing case' }], ledger }] } } });
  assert.equal(posted.recorded, true);

  const rows = testResults(board.db, { receipt: `${job}#1` }).sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(rows.map(row => [row.file, row.inputKey, row.status]), [[GREEN, keys.get(GREEN), 'pass'], [RED, keys.get(RED), 'fail']], 'one row per run file at its inputKey');
  assert.ok(rows.every(row => /^[0-9a-f]{64}$/u.test(row.context) && row.context === rows[0].context), 'each row names its context class');
  assert.ok(rows.every(row => row.command === 'proof' && row.origin === 'pulled:r-ledger' && row.commit === HEAD), 'with its command class, origin and commit');
  assert.deepEqual(testResults(board.db, { inputKey: keys.get(GREEN) }).map(row => row.status), ['pass'], 'the green row is found by its inputKey');
});

test('clause 1: a shard receipt writes its files too, and a red phase with no case account writes none [P7]', t => {
  const board = cellBoard(t, ':memory:');
  const key = 'a'.repeat(64), context = 'b'.repeat(64);
  const frames = ['x.test.js', 'y.test.js'].map(file => `# pullboard test cache ${JSON.stringify({ file, outcome: 'ran', key: 'c'.repeat(64), missed: null, inputKey: key, context })}`).join('\n');
  assert.equal(phaseLedger(frames, { status: 1, failures: null }), null, 'no row is guessed for a red phase that names no case');
  const ledger = phaseLedger(`${frames}\n# pullboard test cache ${JSON.stringify({ file: 'z.test.js', outcome: 'ran', key: null, missed: 'no key: x' })}`, { status: 0 });
  assert.deepEqual(ledger.files.map(row => row[0]), ['x.test.js', 'y.test.js'], 'a keyless file is never a ledger row');
  postThrough(board, { id: 'gate:42:shard:0', kind: 'gate-shard', receipt: { version: 1, status: 0, gate: { kind: 'shard', source: HEAD, green: true, phases: [{ role: 'proof', status: 0, ledger }] } } });
  assert.deepEqual(testResults(board.db, { inputKey: key }).map(row => [row.file, row.status, row.origin]).sort(), [['x.test.js', 'pass', 'shard:r-ledger'], ['y.test.js', 'pass', 'shard:r-ledger']]);
});
