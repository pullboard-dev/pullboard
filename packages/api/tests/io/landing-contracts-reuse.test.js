/** With landing.reuseContractResults on, the land job's contracts carry the reuse flag and the ledger's green hits; off, they are exactly as before [C7,#9301]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { recordTestResults } from '../../../store/index.js';
import { offerLandingJob } from '../../index.js';

const COMMIT = 'a'.repeat(40);
const CONTEXT = 'c'.repeat(64);
const FILE = 'packages/area/tests/a.test.js';
let offers = 0;

/** A board whose ledger holds one green proof row for FILE. */
function board(t) {
  const db = cellBoard(t, ':memory:').db;
  recordTestResults(db, { receipt: 'gate:other#0', origin: 'pulled:r-1', commit: 'd'.repeat(40), rows: [{ file: FILE, inputKey: '1'.padStart(64, '0'), command: 'proof', context: CONTEXT, status: 'pass' }] });
  return db;
}

/** The contracts block of one offered land job. */
function contractsOf(db, extra = {}) {
  const id = 9301 + ++offers;
  const job = offerLandingJob(db, { items: [{ id, commit: COMMIT, ref: `refs/pullboard/land/${id}` }], expect: 'b'.repeat(40), config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node bin/proof.mjs' }, ...extra });
  return job.steps.find(step => step.name === 'offered').payload.payload.contracts;
}

test('api.landing-contracts-reuse.setting-contracts-carry-reuse-hit: clause 1: setting on, the contracts carry reuse and a hit list for the ledger\'s green files [C7,#9301]', t => {
  const contracts = contractsOf(board(t), { reuseContractResults: true });
  assert.equal(contracts.reuse, true);
  assert.deepEqual(contracts.ledger.files.map(row => row[0]), [FILE]);
});

test('api.landing-contracts-reuse.setting-off-contracts-exactly-runner: clause 2: setting off, the contracts are exactly the runner command [C7,#9301]', t => {
  assert.deepEqual(contractsOf(board(t)), { runner: 'node bin/proof.mjs' });
});
