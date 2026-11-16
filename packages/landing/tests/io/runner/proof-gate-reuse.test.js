/** The land proof counts a ledger hit as reused and runs only the misses, with a per-file account, behind landing.reuseGateReceipts [C7,#9244]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { planTestActions } from '../../../../gate/index.js';
import { phaseLedger } from '../../../../gate/index.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { ledgerProofCheck } from '../../../src/io/runner/proof.js';

const RUNNER = `node ${fileURLToPath(new URL('../../../../gate/src/io/run/tests.js', import.meta.url))}`;
const FILES = ['tests/one.test.js', 'tests/two.test.js', 'tests/three.test.js'];
const PASSING = "import { test } from 'node:test';\ntest('passes', () => {});\n";

/** This process's environment without any enclosing run's reuse, ledger or timing variables, on the given store. */
function cleanEnv(store) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PULLBOARD_(TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)|LEDGER_HITS|TIMING_RUN_ID|COLLECTION_ID)$/u.test(name))), PULLBOARD_TEST_RESULT_STORE: store };
}

/** A committed fixture repository with three passing test files, and a scratch folder for the result stores. */
function fixture(t) {
  const repo = fixtureCommittedGraph('pullboard-land-reuse-'), scratch = privateFixtureFiles('pullboard-land-reuse-store-').root;
  t.after(() => { rmSync(repo.root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); });
  repo.put('package.json', '{"name":"demo","type":"module"}\n');
  for (const file of FILES) repo.put(file, PASSING);
  repo.commit();
  return { repo, scratch };
}

/** The ledger hit list a green gate run leaves for `files`, as the board hands it to a land job. */
async function hitList(fx, files) {
  const selectors = files.map(file => `./${file}`), written = [];
  await planTestActions(fx.repo.root, selectors, { fullSuite: false, listFiles: () => selectors, write: text => written.push(text), env: { ...cleanEnv(join(fx.scratch, 'gate')), PULLBOARD_TEST_REUSE: 'record' } });
  const ledger = phaseLedger(written.join(''), { status: 0 });
  assert.equal(ledger?.files.length, files.length, `the gate plan keyed every file: ${written.join('').slice(0, 1500)}`);
  return { contexts: ledger.contexts, files: ledger.files.map(row => row.slice(0, 3)) };
}

/** Run the land proof over every fixture file with `ledger` as the hit list. */
function prove(fx, ledger, reuseGate) {
  return ledgerProofCheck({ runner: RUNNER, files: FILES, ledger }, { env: cleanEnv(join(fx.scratch, 'land')), reuseGate })({ root: fx.repo.root });
}

test('clause 1: a hit list covering two of three files reports reused 2 and ran 1, with the per-file account [C7,#9244]', { timeout: 300_000 }, async t => {
  const fx = fixture(t), ledger = await hitList(fx, FILES.slice(0, 2));
  const result = await prove(fx, ledger, true);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual([result.proof.files, result.proof.reused, result.proof.ran], [3, 2, 1]);
  assert.deepEqual([result.proof.hits, result.proof.reusedFiles], [2, FILES.slice(0, 2)], 'the account names each reused file');
  assert.equal('dirty' in result.proof, false, 'a clean tree reports no dirty paths');
  const off = await prove(fx, ledger, false);
  assert.deepEqual([off.proof.files, off.proof.reused, off.proof.ran], [3, 2, 1], 'with the setting off the counts are the same');
  assert.equal('reusedFiles' in off.proof, false, 'with the setting off the receipt carries no account');
});

test('clause 2: a hit whose inputKey no longer matches is run, not reused [C7,#9244]', { timeout: 300_000 }, async t => {
  const fx = fixture(t), ledger = await hitList(fx, FILES);
  // The merged tree changed one hit file's contents after the gate proved it, so its inputKey is new.
  fx.repo.put(FILES[0], `${PASSING}// changed after the gate\n`);
  fx.repo.commit();
  const result = await prove(fx, ledger, true);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual([result.proof.files, result.proof.reused, result.proof.ran], [3, 2, 1]);
  assert.deepEqual(result.proof.reusedFiles, FILES.slice(1), 'the changed file is not in the reused account');
});
