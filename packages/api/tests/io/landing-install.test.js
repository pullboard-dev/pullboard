/** The land job offer carries the repository's check.install command, and no install field without one [C7,#12231]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { offerLandingJob } from '../../index.js';

const COMMIT = 'a'.repeat(40);
let offers = 0;

/** The payload of one offered land job under `config`. */
function payloadOf(t, config) {
  const db = cellBoard(t, ':memory:').db;
  const id = 12231 + ++offers;
  const job = offerLandingJob(db, { items: [{ id, commit: COMMIT, ref: `refs/pullboard/land/${id}` }], expect: 'b'.repeat(40), config: { trunk: { remote: '/trunk.git' }, ...config } });
  return job.steps.find(step => step.name === 'offered').payload.payload;
}

test('api.landing-install.offer-carries-install: clause 1: a land job offered for a repository with check.install set carries that command in its payload [C7,#12231]', t => {
  assert.equal(payloadOf(t, { check: { install: ' npm ci ' } }).install, 'npm ci');
});

test('api.landing-install.offer-without-install-has-no-field: clause 2: a repository with no check.install offers a land payload with no install field [C7,#12231]', t => {
  assert.equal('install' in payloadOf(t, {}), false);
  assert.equal('install' in payloadOf(t, { check: { install: '  ' } }), false);
});
