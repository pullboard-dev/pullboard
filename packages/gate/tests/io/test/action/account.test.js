/** A reused test file keeps its test account: a ledger hit with no stored outcomes runs, and a resubmit stays green [C7,#7937]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planTestActions } from '../../../../src/io/test/action/cache.js';
import { phaseLedger } from '../../../../src/io/test/account.js';
import { readTestOutcomes } from '../../../../src/io/test/outcomes.js';
import { requireTestTierAccount } from '../../../../src/io/test/tier/selection.js';
import { fixtureCommittedGraph } from '../../../fixtures/testkit.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFocusedRunner } from '../../../fixtures/focused-runner.js';

const FILES = ['tests/one.test.js', 'tests/two.test.js'];

/** This process's environment without any enclosing run's reuse, ledger or timing variables, on the given store. */
function cleanEnv(store, extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PULLBOARD_(TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)|LEDGER_HITS|TIMING_RUN_ID|COLLECTION_ID)$/u.test(name))),
    PULLBOARD_TEST_RESULT_STORE: store, ...extra };
}

/** A committed fixture repository with two passing test files, its result store and scratch folder outside it. */
function fixture(t) {
  const repo = fixtureCommittedGraph('pullboard-reuse-account-'), scratch = privateFixtureFiles('pullboard-reuse-account-store-').root;
  t.after(() => { rmSync(repo.root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); });
  repo.put('package.json', '{"name":"demo","type":"module"}\n');
  for (const file of FILES) repo.put(file, "import { test } from 'node:test';\ntest('passes', () => {});\n");
  repo.commit();
  return { root: repo.root, scratch };
}

/** The board's ledger hits for every file, as a controller's recorded green run makes them, written as a pulled gate proof writes them. */
async function ledgerHitFile(fx) {
  const written = [], selectors = FILES.map(file => `./${file}`);
  await planTestActions(fx.root, selectors, { fullSuite: false, listFiles: () => selectors, write: text => written.push(text),
    env: cleanEnv(join(fx.scratch, 'controller'), { PULLBOARD_TEST_REUSE: 'record' }) });
  const ledger = phaseLedger(written.join(''), { status: 0 });
  assert.ok(ledger?.files.length === FILES.length, `the controller's plan keyed every file: ${written.join('').slice(0, 2000)}`);
  const hits = join(fx.scratch, 'hits.json');
  writeFileSync(hits, JSON.stringify({ contexts: ledger.contexts, files: ledger.files.map(row => row.slice(0, 3)), omitted: 0, account: true }));
  return hits;
}

/** Run the focused runner on both files as a pulled proof phase does, and return its output and the gate's account verdict. */
function proof(fx, hits) {
  const id = randomUUID();
  const ran = runFocusedRunner(fx.root, FILES.map(file => `./${file}`),
    cleanEnv(join(fx.scratch, 'runner'), { PULLBOARD_LEDGER_HITS: hits, PULLBOARD_TIMING_RUN_ID: id }));
  const text = ran.text;
  let refused = null;
  try { requireTestTierAccount({ green: ran.status === 0, testOutcomes: readTestOutcomes(text, id) }, FILES); }
  catch (error) { refused = error; }
  return { status: ran.status, text, refused };
}

test('gate.io-test-action-account.a-selection-reused-from-the-ledger: clause 1: a selection reused from the ledger gets a verdict with each file counted from its result, never TEST_SELECTION_UNVERIFIED [C7,#7937]', { timeout: 300_000 }, // budget: key two files, run them, then reuse them.
async t => {
  const fx = fixture(t), hits = await ledgerHitFile(fx);
  // An empty store holds no outcome for the ledger's hits: the files run, so their account is real.
  const first = proof(fx, hits);
  assert.equal(first.status, 0, first.text.slice(-3000));
  assert.equal(first.refused, null, `a ledger hit with no stored outcome runs and reports: ${first.refused?.message}\n${first.text.slice(-3000)}`);
  // Now the store holds each file's green with its outcomes: both are reused and counted from those outcomes.
  const second = proof(fx, hits);
  assert.equal(second.status, 0, second.text.slice(-3000));
  for (const file of FILES) assert.match(second.text, new RegExp(`# reused [0-9a-f]{64} from ledger \\(${file.replaceAll('.', '\\.')}\\)`), second.text.slice(0, 3000));
  assert.equal(second.refused, null, `a wholly reused selection keeps its account: ${second.refused?.message}`);
});

test('gate.io-test-action-account.resubmitting-the-same-commit-twice-gives: clause 2: resubmitting the same commit twice gives the same green verdict [C7,#7937]', { timeout: 300_000 }, // budget: key two files, run them three times.
async t => {
  const fx = fixture(t), hits = await ledgerHitFile(fx);
  const verdicts = [proof(fx, hits), proof(fx, hits), proof(fx, hits)].map(run => ({ status: run.status, refused: run.refused?.code ?? null }));
  assert.deepEqual(verdicts, Array(3).fill({ status: 0, refused: null }), 'each resubmit is green, however much the cache reuses');
});
