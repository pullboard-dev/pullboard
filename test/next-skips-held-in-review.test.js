/** next and next --take pass over the seat's own submitted item and say it waits on its gate or reviewer [C7,#3532]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submitFixture } from './board-submit-fixture.js';
import { recordSubmitHandoff } from '../packages/jobs/index.js';
import { cli, fixture } from './next-take-fixture.js';

for (const args of [['next'], ['next', '--take']]) {
  test(`clause 1: ${args.join(' ')} skips the seat's own submitted item, offers new work and names the wait [C7,#3532]`, async t => {
    const box = await fixture(t);
    const seat = box.seats.actor;
    const held = box.add('Submitted and in review');
    box.claim(held, seat);
    const head = box.git(seat.path, 'rev-parse', 'HEAD');
    submitFixture(box.board, held, { agentId: seat.id, commit: head, tree: box.git(box.root, 'rev-parse', `${head}^{tree}`) });
    const other = box.add('Another open item', { brief: 'Files: web/other.js\nTest: an unrelated file.' });

    const result = await cli(box, seat.path, args);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.document.item.item_id, other, result.out);
    assert.ok(result.document.reasons.some(line => new RegExp(`#${held}\\b.*waiting on its (gate|reviewer)`, 'u').test(line)), JSON.stringify(result.document.reasons));
  });
}

for (const state of ['running', 'green']) for (const args of [['next'], ['next', '--take']]) {
  test(`clause 1: ${args.join(' ')} skips the seat's own claimed item whose gate is ${state}, offers new work and names the gate wait [C7,#3532]`, async t => {
    const box = await fixture(t);
    const seat = box.seats.actor;
    const held = box.add('Claimed with a gate in flight');
    box.claim(held, seat);
    const head = box.git(seat.path, 'rev-parse', 'HEAD');
    const item = box.board.db.prepare('SELECT item_frozen_digest AS digest FROM item WHERE item_id = ?').get(held);
    recordSubmitHandoff(box.board.db, held, { id: `gate-${held}`, commit: head, agentId: seat.id, digest: item.digest, state });
    const other = box.add('Another open item', { brief: 'Files: web/other.js\nTest: an unrelated file.' });

    const result = await cli(box, seat.path, args);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.document.item.item_id, other, result.out);
    assert.ok(result.document.reasons.some(line => new RegExp(`#${held}\\b.*waiting on its (gate|reviewer)`, 'u').test(line)), JSON.stringify(result.document.reasons));
  });
}
