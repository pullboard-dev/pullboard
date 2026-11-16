/** With landing.reuseGateReceipts on, the land request's hit list carries the item's own green gate results first; off, it is exactly today's [C7,#9243]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { recordTestResults } from '../../../store/index.js';
import { offerLandingJob } from '../../index.js';

const COMMIT = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
const CONTEXT = 'c'.repeat(64);
const key = n => n.toString(16).padStart(64, '0');
const FILES = ['packages/area/tests/a.test.js', 'packages/area/tests/b.test.js'];
let offers = 0;

/** A board where the item's gate (at COMMIT) proved both files at key 1, then three newer runs elsewhere proved other keys for the same files. */
function board(t, { fail = false } = {}) {
  const db = cellBoard(t, ':memory:').db;
  const row = (file, inputKey, status = 'pass') => ({ file, inputKey: key(inputKey), command: 'proof', context: CONTEXT, status });
  recordTestResults(db, { receipt: 'gate:item#0', origin: 'pulled:r-1', commit: COMMIT, rows: FILES.map(file => row(file, 1)) });
  for (const at of [2, 3, 4]) recordTestResults(db, { receipt: `gate:other-${at}#0`, origin: 'pulled:r-2', commit: OTHER, rows: FILES.map(file => row(file, at)) });
  if (fail) recordTestResults(db, { receipt: 'gate:red#0', origin: 'pulled:r-3', commit: COMMIT, rows: [row(FILES[1], 1, 'fail')] });
  return db;
}

/** Offer one land job for the item and return its payload. */
function offered(db, extra = {}) {
  const id = 9243 + ++offers;
  const job = offerLandingJob(db, { items: [{ id, commit: COMMIT, ref: `refs/pullboard/land/${id}` }], expect: 'b'.repeat(40), config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node bin/proof.mjs' }, ...extra });
  return job.steps.find(step => step.name === 'offered').payload.payload;
}

/** The hit list as [file, inputKey] pairs. */
const hits = payload => payload.proof.ledger.files.map(([file, inputKey]) => `${file}@${Number.parseInt(inputKey, 16)}`).sort();

test('clause 1: with landing.reuseGateReceipts on, the hit list lists the item\'s green gate results for its files [C7,#9243]', t => {
  const payload = offered(board(t), { reuseGateReceipts: true });
  assert.ok(FILES.every(file => hits(payload).includes(`${file}@1`)), 'both files hit at the key the item\'s gate proved');
  assert.equal(payload.reuseGateReceipts, true, 'the job says the setting is on, for the runner');
});

test('clause 2: with it off the hit list is exactly today\'s and the setting is not on the job [C7,#9243]', t => {
  const payload = offered(board(t));
  assert.deepEqual(hits(payload), FILES.flatMap(file => [`${file}@3`, `${file}@4`]).sort(), 'the newest two rows of any origin, as before');
  assert.equal('reuseGateReceipts' in payload, false);
});

test('clause 2: a gate result with a fail row at the same key is not a hit, setting on [C7,#9243]', t => {
  const payload = offered(board(t, { fail: true }), { reuseGateReceipts: true });
  assert.ok(hits(payload).includes(`${FILES[0]}@1`));
  assert.equal(hits(payload).includes(`${FILES[1]}@1`), false, 'a key that also failed is run, never reused');
});
