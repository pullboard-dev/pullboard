/** Automatic repairs preserve exact-main matching and ordinary claim authority [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
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
  settledSubmit,
} from '../../../../tests/fixtures/affected.js';

/** Observe only the private fixture's normal CLI result and durable native event rows. */
function submit(box) { return cli(box, box.builder, 'submit', String(box.item), '--no-next'); }

test('opted-in submit files one linked repair for an identical unowned main failure [V4,B3]', async t => {
  const box = fixture(t, { autoFileMainReds: true });
  const generic = cli(box, box.builder, 'add', 'core', 'Unrelated repair', '--criterion', 'Not a derived repair.');
  assert.equal(generic.status, 1);
  assert.equal(JSON.parse(generic.stdout).error.code, 'AGENT_GRANT_ITEM', 'the opt-in never widens ordinary creation');
  // The pulled gate judges the red against main's receipt; the board files the repair from accepted main's opt-in [V4,B3,C7].
  const report = await settledSubmit(t, box);
  const repairs = rows(box, "SELECT * FROM item WHERE item_title LIKE 'Main red:%'");
  assert.equal(repairs.length, 1);
  assert.ok(repairs[0].item_criterion.includes(box.main));
  assert.ok(repairs[0].item_criterion.includes('affected case [G1]'));
  assert.ok(repairs[0].item_criterion.includes(`submit #${box.item}`));
  assert.ok(repairs[0].item_check.includes('test/affected.test.js'));
  assert.equal(report.gate.green, false, 'the original red never becomes a green run');
  assert.equal(report.submission?.gateGreen, true, 'the submission is green only over main\'s own case');
  assert.deepEqual(report.submission.submissionProof.knownMainFailures.failures.map(row => row.item), [repairs[0].item_id]);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
  const asked = rows(box, 'SELECT * FROM shout').filter(row => row.shout_to === 'coordinator' && row.shout_decision === 1);
  assert.equal(asked.length, 0, 'a filed repair owns the red, so the coordinator is not asked');
});

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


test('an opted-in submit with a real docs companion files its untouched main failure [V4,B3]', async t => {
  const box = fixture(t, { autoFileMainReds: true, companion: true });
  const author = JSON.parse(cli(box, box.builder, 'whoami').stdout).id;
  const patch = join(box.directory, 'autofile-companion.patch');
  writeFileSync(patch, 'diff --git a/docs/companion.md b/docs/companion.md\n--- a/docs/companion.md\n+++ b/docs/companion.md\n@@ -1 +1 @@\n-Before.\n+After.\n');
  const attached = cli(box, box.root, 'patch', 'attach', String(box.item), patch, '--key', 'autofile-docs', '--author', author, '--source', box.head);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  const report = await settledSubmit(t, box);
  const known = report.submission?.submissionProof?.knownMainFailures;
  assert.equal(known?.main, box.main, JSON.stringify(report.submission));
  assert.deepEqual(known.failures.map(row => row.file), ['test/affected.test.js']);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 1);
});
