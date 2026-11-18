/** A settled item-only red has no review packet (V4, C7, #7500). */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { showReviewPacket } from '../../src/io/review/packet.js';

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);

/** Inputs for one settled submit whose gate is red in `failures`, while main fails only `excused`. */
function inputs(failures, excused) {
  return {
    item: { item_id: 7500, item_commit: HEAD, item_frozen_digest: 'digest' },
    submit: { commit: HEAD, gateGreen: false, submissionProof: { knownMainFailures: { main: MAIN, failures: excused } } },
    receipts: [{ id: 'r1', exitCode: 1, green: false, failures }],
    baseline: null, mainRuns: [], thread: [],
  };
}

test('clause 1: showReviewPacket refuses NO_REVIEW_PACKET for a settled red outside main\'s named failures and stores no packet [V4,C7]', async () => {
  // A path that does not exist: nothing may be written under it.
  const commonDir = join(tmpdir(), `pullboard-no-packet-${process.pid}`);
  const ctx = { info: { root: commonDir, commonDir }, io: { say() {}, err() {} } };
  const own = [{ file: 'packages/x/tests/own.test.js', name: 'the item broke this' }];
  const main = [{ file: 'packages/y/tests/main.test.js', name: 'main already fails this' }];
  const run = () => showReviewPacket(ctx, 7500, async () => inputs([...own, ...main], main));
  await assert.rejects(run(), error => error.code === 'NO_REVIEW_PACKET' || /NO_REVIEW_PACKET/u.test(String(error.message)));
  assert.equal(existsSync(join(commonDir, 'pullboard', 'review-packets')), false, 'no packet was stored');
});
