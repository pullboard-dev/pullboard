/** Seats racing for one review wait on its lease file and the losers get REVIEW_HELD without a board write [C7,#11110]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withReviewLease } from '../../../src/io/next/review-lease.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

/** A folder standing in for .git/pullboard, with the board file path inside it. */
function folder(t) {
  const dir = privateFixtureFiles('review-lease-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'board.sqlite');
}

test('cli.io-next-review-lease.second-seat-refused-without-write: clause 1: while one withReviewLease for an item is held, a second waits on the lease, then is refused REVIEW_HELD with zero calls to the board write it wraps [C7,#11110]', async t => {
  const board = folder(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let firstWrites = 0;
  let secondWrites = 0;
  let waits = 0;
  let waiting;
  const sawWait = new Promise(resolve => { waiting = resolve; });
  const first = withReviewLease(board, 42, async () => { firstWrites += 1; await gate; return 'reserved'; }, { holder: 'a' });
  // The second seat's sleep is the observable wait: it opens the gate only after the second has seen the live lease.
  const outcome = withReviewLease(board, 42, () => { secondWrites += 1; return 'reserved'; },
    { holder: 'b', sleep: async () => { waits += 1; waiting(); await gate; } }).then(() => 'ran', error => error.code);
  await sawWait;
  assert.equal(secondWrites, 0, 'the second seat waits while the lease is held');
  release();
  assert.equal(await first, 'reserved');
  assert.equal(await outcome, 'REVIEW_HELD');
  assert.ok(waits >= 1, 'the second seat waited on the lease');
  assert.equal(firstWrites, 1);
  assert.equal(secondWrites, 0, 'the second seat never called the board write');
});

test('cli.io-next-review-lease.dead-holder-reclaimed: clause 2: a lease whose pid is gone is reclaimed at once [C7,#11110]', async t => {
  const board = folder(t);
  writeFileSync(join(board, '..', 'review-lease-7.json'), JSON.stringify({ pid: 999_999, start: Date.now(), expires: Date.now() + 60_000, holder: 'gone' }));
  let writes = 0;
  let slept = 0;
  const result = await withReviewLease(board, 7, () => { writes += 1; return 'reserved'; }, { holder: 'b', alive: () => false, sleep: async () => { slept += 1; } });
  assert.equal(result, 'reserved');
  assert.equal(writes, 1);
  assert.equal(slept, 0, 'no waiting on a dead holder');
});

test('cli.io-next-review-lease.failed-write-frees-lease: clause 1: a write that fails leaves no lease, so the next seat takes it [C7,#11110]', async t => {
  const board = folder(t);
  await assert.rejects(withReviewLease(board, 9, () => { throw new Error('board busy'); }, { holder: 'a' }), /board busy/);
  assert.equal(existsSync(join(board, '..', 'review-lease-9.json')), false);
  assert.equal(await withReviewLease(board, 9, () => 'ok', { holder: 'b' }), 'ok');
});
