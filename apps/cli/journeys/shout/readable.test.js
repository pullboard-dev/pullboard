/** Measured message readability at the real CLI boundary [B7,A2]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

test('a run-together shout is refused with the next step and a readable one is sent [B7,A2]', () => {
  const box = fixtures.project('true');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const before = store.events(board);
    const shouts = store.allShouts(board);
    const refused = box.run(box.web, 'shout', 'all', 'exactimmutableproducerpacket+SHA', '--json');
    assert.notEqual(refused.code, 0, refused.out || refused.err);
    const error = JSON.parse(refused.out).error;
    assert.equal(error.code, 'SHOUT_SPACES');
    assert.match(JSON.stringify(error), /rewrite.*spaces/i);
    assert.deepEqual(store.events(board), before, 'a refused message appends no event');
    assert.deepEqual(store.allShouts(board), shouts, 'a refused message is not sent');
    for (const text of [
      'The exact immutable producer packet and SHA are ready.',
      'Rewrite `exactimmutableproducerpacket+SHA` with spaces.',
      'Use runProfiledShellAsync and https://example.com/abcdefghijklmnopqrstuvwxyz for the result.',
      `The commit is ${'a'.repeat(40)}.`,
      'abcdefghijklmnopqrstuvwx',
    ]) {
      const sent = box.run(box.web, 'shout', 'all', text, '--json');
      assert.equal(sent.code, 0, sent.out || sent.err);
      assert.equal(store.getShout(board, JSON.parse(sent.out).id).shout_text, text);
    }
    for (const text of ['abcdefghijklmnopqrstuvwxy', '`exactimmutableproducerpacket+SHA`']) {
      const denied = box.run(box.web, 'shout', 'all', text, '--json');
      assert.notEqual(denied.code, 0, denied.out || denied.err);
      assert.equal(JSON.parse(denied.out).error.code, 'SHOUT_SPACES');
    }
  } finally { store.closeBoard(board); }
});
