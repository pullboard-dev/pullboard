/** A pulled gate receipt's kept timing profiles settle the gate as check.profilePath and proofProfilePath, only as plain file names in the kept folder [C7,#9615]. @pullboard-test-input source-cell packages/api packages/store packages/jobs */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { getItem } from '../../../store/index.js';
import { applyGateReceipt } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

const SOURCE = 'c'.repeat(40);
const MAIN = 'd'.repeat(40);
const FOLDER = '/kept/runner-1/job';

/** A claimed item with an offered, runner-held gate job; the receipt the runner posts is built by the case. */
function gateFor(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const job = `gate:${item.item_id}:${SOURCE.slice(0, 12)}`;
  offerJob(board.db, { id: job, kind: 'gate', priority: 'gate', item: item.item_id, candidate: SOURCE, base: MAIN, now: 11,
    request: { submit: { agentId: seat.id, digest: getItem(board, item.item_id).item_frozen_digest } } });
  assert.equal(claimJob(board.db, { runner: 'runner-1', now: 13 })?.job, job);
  return { board, job };
}

/** A red pulled receipt whose check and proof phase rows carry the given kept profile names. */
function receipt({ check, proof, folder = FOLDER }) {
  const row = (role, profileKept) => ({ role, status: 1, tail: 'not ok', ...(profileKept === undefined ? {} : { profileKept }) });
  return { version: 1, status: 1, ...(folder ? { output: { runner: 'runner-1', folder } } : {}), gate: { green: false, error: 'proof not ok', phases: [row('check', check), row('proof', proof)] } };
}

test('api.gate-receipt-profile.receipt-whose-check-proof-phase: clause 1: a receipt whose check and proof phase rows carry profileKept and output.folder settles a gate whose check.profilePath and proofProfilePath are the files in that folder [C7,#9615]', t => {
  const { board, job } = gateFor(t);
  const applied = applyGateReceipt(board, { job, receipt: receipt({ check: 'check.profile.json', proof: 'proof.profile.json' }) });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.deepEqual(applied.gate, { check: { profilePath: join(FOLDER, 'check.profile.json') }, proofProfilePath: join(FOLDER, 'proof.profile.json') });
});

test('api.gate-receipt-profile.receipt-profilekept-leaves-both-fields: clause 2: a receipt with no profileKept leaves both fields unset, as today [C7,#9615]', t => {
  const { board, job } = gateFor(t);
  const applied = applyGateReceipt(board, { job, receipt: receipt({}) });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.equal('gate' in applied, false, 'no gate fields without a kept profile');
  const unfolded = gateFor(t);
  const noFolder = applyGateReceipt(unfolded.board, { job: unfolded.job, receipt: receipt({ check: 'check.profile.json', proof: 'proof.profile.json', folder: null }) });
  assert.equal('gate' in noFolder, false, 'a profile name with no kept folder names no file');
});

test('api.gate-receipt-profile.profilekept-plain-file-name-ignored: clause 3: a profileKept that is not one plain file name is ignored [C7,#9615]', t => {
  for (const bad of ['../escape.json', '/etc/passwd', 'a/b.json', '..', '.', 'sp ace.json', 7]) {
    const { board, job } = gateFor(t);
    const applied = applyGateReceipt(board, { job, receipt: receipt({ check: bad, proof: 'proof.profile.json' }) });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(applied.gate, { proofProfilePath: join(FOLDER, 'proof.profile.json') }, `${String(bad)} is ignored and the plain name still counts`);
  }
});
