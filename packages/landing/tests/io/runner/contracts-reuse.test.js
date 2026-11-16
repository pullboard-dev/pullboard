/** Contract files whose result is recorded green at unchanged inputs are reused and only the others run, behind landing.reuseContractResults [C7,#9301]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { planTestActions } from '../../../../gate/index.js';
import { phaseLedger } from '../../../../gate/index.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { contractAccount } from '../../../src/io/runner/contracts.js';
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

/** Run the contract files the way contractCheck does: the hit list and the per-file account only when the setting is on, then the receipt account. */
async function runContracts(fx, ledger, reuse) {
  const result = await ledgerProofCheck({ runner: RUNNER, files: FILES, ledger: reuse ? ledger : null }, { env: cleanEnv(join(fx.scratch, 'land')), reuseGate: reuse })({ root: fx.repo.root });
  return { result, contracts: { files: FILES, count: FILES.length, ...(reuse ? contractAccount(FILES, result.proof) : {}) } };
}

test('clause 1: with landing.reuseContractResults on, a contract file green at unchanged inputs is reused and only the other files run [C7,#9301]', { timeout: 300_000 }, async t => {
  const fx = fixture(t), ledger = await hitList(fx, FILES.slice(0, 2));
  const { result } = await runContracts(fx, ledger, true);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual([result.proof.files, result.proof.reused, result.proof.ran], [3, 2, 1]);
  assert.deepEqual(result.proof.reusedFiles, FILES.slice(0, 2));
});

test('clause 2: with the setting off every contract file runs and the receipt account is exactly as before [C7,#9301]', { timeout: 300_000 }, async t => {
  const fx = fixture(t), ledger = await hitList(fx, FILES);
  const { result, contracts } = await runContracts(fx, ledger, false);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual([result.proof.files, result.proof.reused, result.proof.ran], [3, 0, 3]);
  assert.deepEqual(contracts, { files: FILES, count: 3 }, 'no reused or run lists when off');
});

test('clause 3: the contracts account lists reused and run files separately when the setting is on [C7,#9301]', { timeout: 300_000 }, async t => {
  const fx = fixture(t), ledger = await hitList(fx, FILES);
  fx.repo.put(FILES[2], `${PASSING}// changed after the gate\n`);
  fx.repo.commit();
  const { result, contracts } = await runContracts(fx, ledger, true);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(contracts.reused, { files: FILES.slice(0, 2), count: 2 });
  assert.deepEqual(contracts.run, { files: [FILES[2]], count: 1 });
});
