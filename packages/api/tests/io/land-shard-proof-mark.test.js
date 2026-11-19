/** With landing.shardProof on, offerLandingJob marks the land payload with the gate its proof's shards run; off, it does not [C7,#7818,#8255]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { offerLandingJob } from '../../index.js';

const GATE = { run: ['node', '-e', 'x'], entry: 'gate.js' };
const COMMIT = 'a'.repeat(40);
let offers = 0;

/** Offer one land job under a landing config and return its payload; each offer names its own item, so none returns an earlier job as it stands. */
function offered(t, landing, extra = {}) {
  const db = cellBoard(t, ':memory:').db, id = 8255 + ++offers;
  const config = { trunk: { remote: '/trunk.git' }, ...(landing ? { landing } : {}) };
  const job = offerLandingJob(db, { items: [{ id, commit: COMMIT, ref: `refs/pullboard/land/${id}` }], expect: 'b'.repeat(40), config, ...extra });
  return job.steps.find(step => step.name === 'offered').payload.payload;
}

test('api.land-shard-proof-mark.offerlandingjob-marks-land-payload-shardproof: clause 1: offerLandingJob marks the land payload shardProof only when landing.shardProof is on [C7,#8255]', t => {
  assert.equal('shardProof' in offered(t, null, { shardGate: GATE }), false, 'off: the payload carries no mark, whatever gate the offerer holds');
  assert.equal('shardProof' in offered(t, { shardProof: false }, { shardGate: GATE }), false, 'set off: the same');
  assert.deepEqual(offered(t, { shardProof: true }, { shardGate: GATE }).shardProof, GATE, 'on: the payload carries the gate the proof\'s shards run');
  assert.throws(() => offered(t, { shardProof: true }), error => error.code === 'LANDING_SHARD_GATE', 'on with no gate to run is refused, not silently local');
});
