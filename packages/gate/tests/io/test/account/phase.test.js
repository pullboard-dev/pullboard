/** A run phase's own per-file frames give its proof-ledger rows, each with the file's real inputKey and context class [P7,CD2]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { phaseLedger } from '../../../../heavy.js';
import { planTestActions } from '../../../../index.js';
import { testActionKeys } from '../../../../index.js';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
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

test('gate.io-test-account-phase.a-red-phase-s-frames-give: clause 1: a red phase\'s frames give one ledger row per run file at its inputKey and context class, the green file of the red phase passing [P7]', { timeout: 120_000 }, // budget: two files' import closures keyed at HEAD.
async () => {
  const { text, keys } = await ranFrames();
  // The proof phase was red in one file's case only: the other file's green still counts (313 of 386 wasted reruns, 11 Nov).
  const ledger = phaseLedger(text, { status: 1, failures: [{ file: RED, name: 'a failing case' }] });
  assert.ok(ledger, `the run printed keyed frames: ${text.slice(0, 2000)}`);
  const rows = ledger.files.map(([file, inputKey, context, status]) => [file, inputKey, ledger.contexts[context], status]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(rows.map(([file, inputKey, , status]) => [file, inputKey, status]), [[RED, keys.get(RED), 'fail'], [GREEN, keys.get(GREEN), 'pass']], 'one row per run file at its inputKey');
  assert.ok(rows.every(row => /^[0-9a-f]{64}$/u.test(row[2]) && row[2] === rows[0][2]), 'each row names its context class');
  assert.equal(ledger.omitted, 0);
});

test('gate.io-test-account-phase.a-red-phase-with-no-case: clause 1: a red phase with no case account writes no row, and a keyless file is never a ledger row [P7]', () => {
  const key = 'a'.repeat(64), context = 'b'.repeat(64);
  const frames = ['x.test.js', 'y.test.js'].map(file => `# pullboard test cache ${JSON.stringify({ file, outcome: 'ran', key: 'c'.repeat(64), missed: null, inputKey: key, context })}`).join('\n');
  assert.equal(phaseLedger(frames, { status: 1, failures: null }), null, 'no row is guessed for a red phase that names no case');
  const ledger = phaseLedger(`${frames}\n# pullboard test cache ${JSON.stringify({ file: 'z.test.js', outcome: 'ran', key: null, missed: 'no key: x' })}`, { status: 0 });
  assert.deepEqual(ledger.files.map(row => row[0]), ['x.test.js', 'y.test.js'], 'a keyless file is never a ledger row');
});
