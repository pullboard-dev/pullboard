/** Automatic repairs preserve exact-main matching and ordinary claim authority [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { openBoard } from '../../../../../lib/index.js';
import { closeBoard } from '../../../../../../packages/store/index.js';
import {
  bindRefs,
  resolveMove,
} from '../../../../../../packages/outbox/index.js';
import { sealKnownMainAutofile } from '../../../../../../packages/gate/index.js';
import {
  fixture,
  cli,
  rows,
} from '../../../../tests/fixtures/affected.js';

/** Observe only the private fixture's normal CLI result and durable native event rows. */
function submit(box) { return cli(box, box.builder, 'submit', String(box.item), '--no-next'); }

test('automatic filing stays off by default and preserves the existing unowned-main handoff [V4,B3]', t => {
  const box = fixture(t);
  const result = submit(box);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0);
  // @pullboard-board-file persistence: authenticate actual native receipts against the private fixture's persisted submit policy.
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    board.gitRoot = box.builder;
    assert.throws(() => sealKnownMainAutofile(board, box.item, { commit: box.head, policyCommit: box.main,
      autoMainReds: { main: box.main } }), { code: 'SUBMISSION_PROOF' }, 'actual accepted-main policy is off');
  } finally { closeBoard(board); }
});

test('opt-in cannot excuse a candidate failure green on main or file a repair for it [V4,B3]', t => {
  const box = fixture(t, { main: 1, candidate: 2, autoFileMainReds: true });
  // A pulled submit queues; the settled red gate leaves the item claimed with no submit event and files no repair [P7,C7].
  const result = submit(box);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).gate.green, false, 'a candidate failure green on main is a red gate');
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('opt-in does not match changed assertion diagnostics merely because the case name agrees [V4,B3]', t => {
  const box = fixture(t, { main: 2, candidate: 3, autoFileMainReds: true });
  const result = submit(box);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).gate.green, false, 'a changed diagnostic is a red gate, never matched by name');
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0);
});


test('a captured submit keeps its item binding when an offline source item is renumbered [B26,H16]', () => {
  const outbox = { moves: [{ move: { id: 'offline-item', operation: 'addItem' }, visible: 7 }], results: { 'offline-item': 12 } };
  const entry = { move: { operation: 'submit', args: [7, { autoMainReds: { candidates: [{ proof: { item: 7 } }] } }] } };
  entry.refs = bindRefs(outbox, entry.move);
  assert.equal(entry.refs.length, 2);
  assert.deepEqual(resolveMove(entry, outbox).move.args, [12, { autoMainReds: { candidates: [{ proof: { item: 12 } }] } }]);
});
