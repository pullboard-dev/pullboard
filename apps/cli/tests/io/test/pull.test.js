/** @pullboard-test-input source-tree */
/** A test job request carries the caller's fixture switches and nothing else from its shell [C7,#10849]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LEDGER_SCHEMA_SQL } from '../../../../../packages/store/index.js';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { test } from 'node:test';
import { ledgerHits } from '../../../../../packages/store/index.js';
import { recordTestResults } from '../../../../../packages/store/index.js';
import { testResults } from '../../../../../packages/store/index.js';
import { finishLedgerRows } from '../../../src/io/test/pull.js';
import { testJobRow } from '../../../src/io/test/pull.js';
import { testJobEntry } from '../../../src/io/test/pull.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeTestResult } from '../../../../../packages/gate/src/io/test/store.js';

test('cli.io-test-pull.same-runner-complete-proof: clause 1: separate pulled checkouts reuse complete same-runner proof and fresh or changed input runs [C7,#12642]', { timeout: 300_000 }, t => {
  const repo = fixtureCommittedGraph('pull-test-proof-'), scratch = privateFixtureFiles('pull-test-runner-');
  const runner = join(scratch.root, 'runner'), one = join(runner, 'pull', 'one'), two = join(runner, 'pull', 'two');
  const counter = join(scratch.root, 'executions');
  repo.put('package.json', '{"type":"module"}\n');
  repo.put('test/proof.test.js', `import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('proof', () => appendFileSync(${JSON.stringify(counter)}, 'x'));\n`);
  const commit = repo.commit();
  mkdirSync(join(runner, 'pull'), { recursive: true });
  for (const path of [one, two]) runFixtureGit(['clone', '-q', repo.root, path]);
  const entry = join(scratch.root, 'entry.mjs');
  writeFileSync(entry, testJobEntry('RECEIPT', 'PULLBOARD_PULLED_JOB', 'PULLBOARD_TIMING_RUN_ID', '# pullboard test outcomes ', ''));
  const tests = fileURLToPath(new URL('../../../../../packages/gate/src/io/run/tests.js', import.meta.url));
  const data = { main: commit, source: commit, files: ['test/proof.test.js'], command: `${process.execPath} ${tests} ./test/proof.test.js`, runId: '11111111-2222-3333-4444-555555555555' };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PULLBOARD_(TEST_|LEDGER_HITS|TIMING_RUN_ID)/u.test(key)));
  const run = (root, extra = {}) => runFixtureChild(process.execPath, [entry, root], { input: JSON.stringify(data), encoding: 'utf8', env: { ...env, ...extra }, timeout: 120_000 });
  assert.equal(run(one).status, 0);
  const second = run(two);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /# reused /u);
  assert.equal(readFileSync(counter, 'utf8'), 'x', 'only first checkout executed');
  assert.equal(run(two, { TZ: 'Pacific/Honolulu' }).status, 0);
  assert.equal(readFileSync(counter, 'utf8'), 'xx', 'different runtime context executes');
  const store = join(runner, 'test-results', 'pull-gate');
  const entries = readdirSync(join(store, 'green')).map(name => {
    const path = join(store, 'green', name);
    return { path, value: JSON.parse(readFileSync(path, 'utf8')) };
  });
  // Poison every observed context so neither one can accidentally satisfy the next request.
  for (const { value } of entries) assert.equal(storeTestResult(store, { ...value, status: 'fail' }), true);
  assert.equal(run(two).status, 0);
  assert.equal(readFileSync(counter, 'utf8'), 'xxx', 'previously red key executes');
  for (const { value } of entries) rmSync(join(store, 'red', value.key), { force: true });
  for (const { path, value } of entries) writeFileSync(path, JSON.stringify({ ...value, tap: undefined }));
  assert.equal(run(two).status, 0);
  assert.equal(readFileSync(counter, 'utf8'), 'xxxx', 'incomplete outcome executes');
  assert.equal(run(two, { PULLBOARD_TEST_REUSE: '0' }).status, 0);
  assert.equal(readFileSync(counter, 'utf8'), 'xxxxx', 'fresh-only executes');
  writeFileSync(join(two, 'test/proof.test.js'), readFileSync(join(two, 'test/proof.test.js'), 'utf8') + '\n// changed input\n');
  assert.equal(run(two).status, 0);
  assert.equal(readFileSync(counter, 'utf8'), 'xxxxxx', 'changed input executes');
});

const SHELL = { PATH: '/usr/bin', HOME: '/home/user', NODE_OPTIONS: '--require ./evil.js', FIXTURE_ONE: '1', PULLBOARD_FIXTURE_INPROCESS_HOOKS: '1', PULLBOARD_FIXTUREX: 'no', MY_FIXTURE_A: 'no' };

/** The row testJobRow offers for a commit in a throwaway repository, given the caller's shell variables. */
async function rowFor(t, environment, extra = {}) {
  const { root, commit } = cellRepo(t, { real: true });
  const { row } = await testJobRow({ info: { root } }, { item: 1, commit, main: commit, command: 'true', files: [], environment, ...extra });
  return row;
}

test('cli.io-test-pull.forwards-fixture-variables: clause 1: testJobRow puts every caller variable matching the job env allowlist into the request env map [C7,#10849]', async t => {
  const row = await rowFor(t, SHELL);
  assert.deepEqual(row.request.env, { FIXTURE_ONE: '1', PULLBOARD_FIXTURE_INPROCESS_HOOKS: '1' });
});

test('cli.io-test-pull.leaves-other-variables-out: clause 2: testJobRow leaves PATH, HOME, NODE_OPTIONS and every other non-matching variable out of the request [C7,#10849]', async t => {
  const row = await rowFor(t, SHELL);
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'PULLBOARD_FIXTUREX', 'MY_FIXTURE_A']) assert.equal(name in row.request.env, false, name);
  const bare = await rowFor(t, { PATH: '/usr/bin' });
  assert.equal('env' in bare.request, false, 'a shell with no fixture variable adds no env map');
});

const KEY_A = 'a'.repeat(64), KEY_B = 'b'.repeat(64), CONTEXT = 'c'.repeat(64);

test('cli.io-test-pull.finish-run-carries-test-results: clause 1: the pulled finish test job carries testResults with the selected files\' input keys and an origin naming the finish run, and its receipt rows reach the ledger under the proof command [P7]', async t => {
  const ledger = { contexts: [CONTEXT], files: [['apps/cli/tests/a.test.js', KEY_B, 0], ['apps/cli/tests/b.test.js', KEY_A, 0]] };
  const row = await rowFor(t, {}, { runId: '11111111-2222-3333-4444-555555555555', ledger });
  const { testResults } = row.request.input.data;
  assert.equal(testResults.origin, 'finish:11111111-2222-3333-4444-555555555555');
  assert.deepEqual(testResults.inputKeys, [KEY_A, KEY_B]);
  assert.deepEqual(testResults.ledger, ledger);
  assert.equal('testResults' in (await rowFor(t, {})).request.input.data, false, 'a run with no ledger hit carries none');
  const phase = { role: 'test', ledger: { contexts: [CONTEXT], files: [['apps/cli/tests/a.test.js', KEY_B, 0, 'pass'], ['apps/cli/tests/b.test.js', KEY_A, 0, 'fail']] } };
  assert.deepEqual(finishLedgerRows({ phases: [phase] }), [
    { file: 'apps/cli/tests/a.test.js', inputKey: KEY_B, command: 'proof', context: CONTEXT, status: 'pass' },
    { file: 'apps/cli/tests/b.test.js', inputKey: KEY_A, command: 'proof', context: CONTEXT, status: 'fail' }]);
  assert.deepEqual(finishLedgerRows({ phases: [{ role: 'test' }] }), []);
});

test('cli.io-test-pull.finish-rows-reach-ledger: clause 2: a finish run of 5 files leaves 5 rows in the board ledger, and the next run of the same unchanged files is offered 5 hits to reuse [P7]', () => {
  const files = [1, 2, 3, 4, 5].map(n => `apps/cli/tests/f${n}.test.js`);
  const phase = { role: 'test', ledger: { contexts: [CONTEXT], files: files.map((file, n) => [file, String(n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/gu, 'a'), 0, 'pass']) } };
  const db = new DatabaseSync(':memory:');
  db.exec(LEDGER_SCHEMA_SQL);
  const rows = finishLedgerRows({ phases: [phase] });
  assert.equal(recordTestResults(db, { receipt: 'test:1#0', origin: 'finish:runner', commit: 'f'.repeat(40), rows }), 5);
  assert.deepEqual(testResults(db).map(row => row.file).sort(), files);
  const hits = ledgerHits(db, files);
  assert.deepEqual(hits.files.map(row => row[0]).sort(), files);
});
