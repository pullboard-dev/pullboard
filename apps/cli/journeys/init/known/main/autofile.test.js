/** Automatic repairs preserve exact-main matching and ordinary claim authority [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  frozenCheck,
  policyAt,
} from '../../../../../../packages/sandbox/index.js';
import { submitGatePlan } from '../../../../../../packages/gate/index.js';
import { submitGateConfig } from '../../../../../../packages/gate/index.js';
import {
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { openBoard } from '../../../../../lib/index.js';
import * as store from '../../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../../packages/store/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../../packages/store/index.js';
import { KNOWN_MAIN_AUTOFILE_ENGINE } from '../../../../../../packages/state/light.js';
import { rememberCreatedItems } from '../../../../../../packages/link/index.js';
import {
  bindRefs,
  resolveMove,
} from '../../../../../../packages/outbox/index.js';
import { readGateReceipt } from '../../../../../../packages/gate/index.js';
import { sealKnownMainAutofile } from '../../../../../../packages/gate/index.js';
import { validateKnownMainAutofile } from '../../../../../../packages/store/index.js';
import {
  fixture,
  cli,
  rows,
} from '../../../../tests/fixtures/affected.js';

/** Observe only the private fixture's normal CLI result and durable native event rows. */
function submit(box) { return cli(box, box.builder, 'submit', String(box.item), '--no-next'); }

test('opted-in submit files one linked repair for an identical unowned main failure [V4,B3]', t => {
  const box = fixture(t, { autoFileMainReds: true });
  const generic = cli(box, box.builder, 'add', 'core', 'Unrelated repair', '--criterion', 'Not a derived repair.');
  assert.equal(generic.status, 1);
  assert.equal(JSON.parse(generic.stdout).error.code, 'AGENT_GRANT_ITEM', 'the opt-in never widens ordinary creation');
  // @pullboard-board-file persistence: snapshot the actual private CLI board before its atomic submit for replay.
  const beforeBoard = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let before, nativePlan;
  try {
    before = exportBoard(beforeBoard);
    const item = store.getItem(beforeBoard, box.item);
    nativePlan = submitGatePlan(box.builder, submitGateConfig(policyAt(box.builder, box.head).config, policyAt(box.builder, box.main).config),
      { base: item.item_claim_head, trunk: box.main, check: frozenCheck(item), commit: box.head });
  } finally { closeBoard(beforeBoard); }
  const result = submit(box);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  const repairs = rows(box, "SELECT * FROM item WHERE item_title LIKE 'Main red:%'");
  assert.equal(repairs.length, 1);
  assert.ok(repairs[0].item_criterion.includes(box.main));
  assert.ok(repairs[0].item_criterion.includes('affected case [G1]'));
  assert.ok(repairs[0].item_criterion.includes(`submit #${box.item}`));
  assert.ok(repairs[0].item_check.includes('test/affected.test.js'));
  assert.equal(report.gate.green, false, 'the original red never becomes a green run');
  assert.deepEqual(report.gate.knownMainReworks.map(row => row.item), [repairs[0].item_id]);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
  // Origin reads only actual gate-written private fixture receipts; replay needs none of the receiver's files.
  const folder = join(box.root, '.git', 'pullboard', 'gate-receipts');
  const receipts = readdirSync(folder).filter(file => file.endsWith('.json')).map(file => readGateReceipt(folder, file.slice(0, -5))).filter(Boolean);
  // Receipt filenames are random UUIDs; retain the real criterion-then-proof protocol order.
  const unordered = receipts.filter(row => row.kind === 'submit' && row.proof?.item === box.item);
  const candidates = nativePlan.phases.map(({ command }) => {
    const hash = createHash('sha256').update(command).digest('hex');
    const matches = unordered.filter(row => row.command === hash);
    assert.equal(matches.length, 1, 'each native phase has exactly one authentic receipt');
    return matches[0];
  });
  assert.equal(new Set(candidates.map(row => row.id)).size, unordered.length, 'no phase or extra receipt is omitted');
  const comparisons = receipts.filter(row => row.kind === 'main-red');
  // @pullboard-board-file persistence: authenticate actual native receipts against the private fixture's persisted submit policy.
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    board.gitRoot = box.builder;
    const submission = JSON.parse(rows(box, "SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1", box.item)[0].event_detail);
    const options = { submissionProof: submission.submissionProof, agentId: candidates[0].proof.seat, commit: candidates[0].head, tree: candidates[0].tree, policyCommit: candidates[0].main,
      autoMainReds: { main: box.main, candidateReceiptIds: candidates.map(row => row.id), mainReceiptIds: comparisons.map(row => row.id) } };
    assert.throws(() => sealKnownMainAutofile(board, box.item, { ...options, autoMainReds: { ...options.autoMainReds, candidateReceiptIds: options.autoMainReds.candidateReceiptIds.slice(1) } }), { code: 'SUBMISSION_PROOF' });
    const sealed = sealKnownMainAutofile(board, box.item, options);
    delete board.gitRoot;
    assert.equal(validateKnownMainAutofile(board, box.item, sealed).failures.length, 1);
    const rejects = change => {
      const forged = structuredClone(sealed); change(forged.autoMainReds);
      assert.throws(() => validateKnownMainAutofile(board, box.item, forged), { code: 'SUBMISSION_PROOF' });
    };
    rejects(value => { value.policy.enabled = false; });
    rejects(value => { value.main = 'f'.repeat(40); });
    rejects(value => { value.comparisons = []; });
    rejects(value => { value.phases.pop(); });
    const wrongActor = structuredClone(sealed); wrongActor.agentId = 'coordinator';
    assert.throws(() => validateKnownMainAutofile(board, box.item, wrongActor), { code: 'SUBMISSION_PROOF' });
    rejects(value => { delete value.candidates.find(row => !row.green).failureSignatures; });
    rejects(value => { value.candidates.find(row => !row.green).failureSignatures.failures[0].signature = 'f'.repeat(64); });
    const replay = openBoard(':memory:');
    try {
      importBoard(replay, before);
      store.addItem(replay, { by: 'coordinator', lane: 'core', title: 'Concurrent receiving-board item', criterion: 'Unrelated native item.' });
      replay.executionEngineVersion = KNOWN_MAIN_AUTOFILE_ENGINE;
      const replayResult = store.submit(replay, box.item, { ...sealed, gateGreen: false });
      const replayOwner = replayResult.mainRedRepairs[0].item;
      assert.notEqual(replayOwner, repairs[0].item_id, 'receiver allocates its own new id');
      const origin = { move: { id: 'derived-submit', operation: 'submit' } };
      rememberCreatedItems(origin, { mainRedRepairs: [{ file: 'test/affected.test.js', name: null, item: repairs[0].item_id }] });
      const outbox = { moves: [origin], results: {} };
      const child = { move: { operation: 'addItem', args: [{ after: [repairs[0].item_id] }] } };
      child.refs = bindRefs(outbox, child.move);
      outbox.results['derived-submit'] = replayResult;
      assert.deepEqual(resolveMove(child, outbox).move.args[0].after, [replayOwner]);
      assert.equal(store.getItem(replay, box.item).item_status, 'submitted');
    } finally { closeBoard(replay); }
  } finally { closeBoard(board); }

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
  const result = submit(box);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('opt-in does not match changed assertion diagnostics merely because the case name agrees [V4,B3]', t => {
  const box = fixture(t, { main: 2, candidate: 3, autoFileMainReds: true });
  const result = submit(box);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0);
});


test('a captured submit keeps its item binding when an offline source item is renumbered [B26,H16]', () => {
  const outbox = { moves: [{ move: { id: 'offline-item', operation: 'addItem' }, visible: 7 }], results: { 'offline-item': 12 } };
  const entry = { move: { operation: 'submit', args: [7, { autoMainReds: { candidates: [{ proof: { item: 7 } }] } }] } };
  entry.refs = bindRefs(outbox, entry.move);
  assert.equal(entry.refs.length, 2);
  assert.deepEqual(resolveMove(entry, outbox).move.args, [12, { autoMainReds: { candidates: [{ proof: { item: 12 } }] } }]);
});


test('an opted-in submit with a real docs companion files its untouched main failure [V4,B3]', t => {
  const box = fixture(t, { autoFileMainReds: true, companion: true });
  const author = JSON.parse(cli(box, box.builder, 'whoami').stdout).id;
  const patch = join(box.directory, 'autofile-companion.patch');
  writeFileSync(patch, 'diff --git a/docs/companion.md b/docs/companion.md\n--- a/docs/companion.md\n+++ b/docs/companion.md\n@@ -1 +1 @@\n-Before.\n+After.\n');
  const attached = cli(box, box.root, 'patch', 'attach', String(box.item), patch, '--key', 'autofile-docs', '--author', author, '--source', box.head);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  const result = submit(box);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate.knownMainFailures.main, box.main);
  assert.deepEqual(report.gate.knownMainReworks.map(row => row.file), ['test/affected.test.js']);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 1);
});
