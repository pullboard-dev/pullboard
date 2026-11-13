/**
 * Next resumes a claim that changed in the same moment [C7]: a seat's claim lapses between two `next` calls.
 * The invariant: `next` prints "you hold #N" only after re-reading, in the read that prints, that #N is claimed by
 * this seat with a live lease; a lapsed lease is never printed as held and selection runs again (SM6, #4056).
 * Run alone with `node packages/gate/tests/fixtures/pipeline/next-resumes-a-claim-that-changed-in-the.js`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  from,
  guardProcesses,
  hopCheck,
} from './kit.js';

const { fixture, cli } = await from('apps/cli/tests/fixtures/next/take.js');
const store = await from('packages/store/index.js');

guardProcesses();

test('clause 1: next never prints you hold for a claim whose lease lapsed since the last read [C7]', { timeout: 240_000 }, async t => {
  await hopCheck('next-claim-fresh', async () => {
    const started = Date.now();
    const box = await fixture(t);
    box.board.gitRoot = box.root;
    const seat = box.seats.actor;
    const mine = box.add('A claim that changes', { brief: 'Files: web/mine.js\nTest: the claim stays fresh.' });
    box.add('Other work', { brief: 'Files: web/other.js\nTest: other work.' });
    const claim = await cli(box, seat.path, ['claim', String(mine), '--no-next']);
    assert.equal(claim.code, 0, claim.out + claim.err);
    const live = await cli(box, seat.path, ['next']);
    assert.equal(live.document.item.item_id, mine);
    assert.equal(live.document.held, true, 'a live lease is printed as held');
    // The lease lapses after that read; the next answer must come from a fresh read, not the earlier snapshot.
    box.advance(30 * 24 * 3_600_000);
    assert.ok(!(store.getItem(box.board, mine).item_lease_until > box.clock.now().toISOString()), 'the lease lapsed');
    const lapsed = await cli(box, seat.path, ['next']);
    assert.equal(lapsed.code, 0, lapsed.out + lapsed.err);
    assert.notEqual(lapsed.document.held, true, `a lapsed lease is never printed as held: ${lapsed.out}`);
    return { ms: Date.now() - started, measured: `#${mine} printed held while live, and not held after its lease lapsed` };
  });
});
