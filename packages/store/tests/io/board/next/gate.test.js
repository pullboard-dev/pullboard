/** A reopen or reject after an item's green gate sends it back to work, so next offers it again [C7,#2955]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
import { addItem } from '../../../../index.js';
import { nextFor } from '../../../../index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';

const HEAD = 'a'.repeat(40);

/** Record a green submit job at the item's head the way the submit queue does, finished at the given time. */
function green(board, id, at) {
  board.db.prepare('UPDATE item SET item_commit = ? WHERE item_id = ?').run(HEAD, id);
  recordSubmitHandoff(board.db, id, { id: `fixture-${id}`, commit: HEAD, agentId: 'web-1', state: 'green', at });
}

/** Append one board event of the given kind for the item at the given time. */
function event(board, id, kind, at) {
  board.db.prepare("INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,'{}')").run(at, 'coordinator', kind, id);
}

for (const kind of ['reopen', 'reject']) {
  test(`an item with a ${kind} after its green submit job is offered by next [C7,#2955]`, t => {
    const board = fixtureBoard(t);
    const id = addItem(board, { by: 'coordinator', lane: 'web', title: `${kind}ed after green` });
    green(board, id, '2026-11-04T07:31:47.230Z');
    event(board, id, kind, '2026-11-04T15:46:28.708Z');
    const offered = nextFor(board, { agentId: 'web-2', lane: 'web' });
    assert.equal(offered.item?.item_id, id, offered.reasons.join(' | '));
  });
}

test('store.io-board-next-gate.an-item-whose-green-submit-job: an item whose green submit job is newer than its last reopen is still skipped as gated [C7,#2955]', t => {
  const board = fixtureBoard(t);
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'resubmitted after reopen' });
  event(board, id, 'reopen', '2026-11-04T07:00:00.000Z');
  green(board, id, '2026-11-04T08:00:00.000Z');
  const offered = nextFor(board, { agentId: 'web-2', lane: 'web' });
  assert.equal(offered.item, null);
  assert.ok(offered.reasons.includes(`#${id}: gate green at ${HEAD.slice(0, 12)}; nothing to build`), offered.reasons.join(' | '));
});

test('store.next.derived-gate-at-head-used: nextFor skips an item the derived reader answers a reason for as GATE_AT_HEAD with that reason, without reading its submit hand-off [C7,#10880]', t => {
  const board = fixtureBoard(t);
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'gated by the derived table only' });
  const asked = [];
  const offered = nextFor(board, { agentId: 'web-2', lane: 'web', derivedGateAtHead: entry => { asked.push(entry.item_id); return 'gate green at aaaaaaaaaaaa'; } });
  assert.equal(offered.item, null);
  assert.ok(asked.includes(id), 'the reader was asked about the item');
  assert.ok(offered.reasons.includes(`#${id}: gate green at aaaaaaaaaaaa; nothing to build`), offered.reasons.join(' | '));
  assert.equal(nextFor(board, { agentId: 'web-2', lane: 'web' }).item?.item_id, id, 'with no submit hand-off recorded, only the derived answer skipped it');
});

test('store.next.derived-gate-at-head-fallback: nextFor computes an item the reader answers undefined for, and every item when the option is absent, with gateAtHead as before [C7,#10880]', t => {
  const board = fixtureBoard(t);
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'gate queued after the reader was built' });
  green(board, id, '2026-11-04T08:00:00.000Z');
  const gated = `#${id}: gate green at ${HEAD.slice(0, 12)}; nothing to build`;
  for (const options of [{ derivedGateAtHead: () => undefined }, {}]) {
    const offered = nextFor(board, { agentId: 'web-2', lane: 'web', ...options });
    assert.equal(offered.item, null);
    assert.ok(offered.reasons.includes(gated), offered.reasons.join(' | '));
  }
});
