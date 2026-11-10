/** @pullboard-test-input source-tree */
/** Coordinator-authored frozen timing reaches real submit/review leases and durable receipts [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  fixtureJoin,
} from '../../tests/fixtures/testkit.js';
import { fixtureCommittedPolicy } from '../../tests/fixtures/testkit.js';
import { recentReceipts } from '../../../../packages/gate/index.js';
import {
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
  BROWSER_SLOT_HELD_ENV,
} from '../../../../packages/resources/index.js';

/** Require genuine native success before treating a fixture as admission evidence. */
function document(result) {
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

for (const timing of [true, false]) {
  test(`frozen check timing ${timing} controls actual submit and verify admission and receipts [C7,V4]`, t => {
    const helpers = createE2eHelpers();
    t.after(helpers.cleanup);
    const box = helpers.project('true');
    box.env.CODEX_THREAD_ID = 'timing-builder-session';
    for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete box.env[key];
    mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
    // A bar may only name paths its lane owns (CROSS_OWNERSHIP, 24e3f4c070), so the web lane owns the check's test folder.
    fixtureCommittedPolicy(box, { lanes: { web: { owns: ['web/', 'test/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } } });
    mkdirSync(join(box.repo, 'test'));
    writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(box.repo, 'test/admission.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('actual frozen admission check executes', () => assert.equal(2 + 2, 4));\n");
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'test: real timing admission target [G1]');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const command = 'node --test --test-reporter=tap test/admission.test.js';
    document(fixtureAdd(box.run, box.repo, 'web', 'Real timing check', '--criterion', 'the actual selected check executes', '--check', command,
      ...(timing ? ['--check-timing', 'true'] : []), '--specs', 'G1', '--wait', '--json'));
    document(box.run(box.web, 'claim', '1', '--json'));
    const frozen = document(box.run(box.repo, 'show', '1', '--json'));
    assert.equal(JSON.parse(frozen.item_frozen).checkTiming === true, timing);
    if (!timing) assert.equal(Object.hasOwn(JSON.parse(frozen.item_frozen), 'checkTiming'), false, 'unflagged historical bytes remain absent');
    helpers.commitFile(box, box.web, 'web/change.txt', 'actual candidate\n', 'feat(web): real timing candidate [G1]');
    const submitted = document(box.run(box.web, 'submit', '1', '--no-next', '--json'));
    assert.equal(submitted.gate.green, true, 'actual native submit check and proof completed');
    const submitReceipt = recentReceipts(box.repo).filter(row => row.kind === 'submit').at(-1);
    assert.ok(submitReceipt, 'native submit persisted its real admission receipt');
    assert.equal(submitReceipt.timing, timing);
    assert.equal(submitReceipt.exclusive, timing);
    assert.equal(submitReceipt.occupiedSlots, timing ? 2 : 1);
    assert.deepEqual(submitReceipt.unfencedClients, []);
    const head = box.git(box.web, 'rev-parse', 'HEAD');
    // A submit proof is reused past a moved main unless main changed what the check runs (4bcbf7d227), so main edits the checked
    // test file; verification then runs the frozen check and writes its own review receipt.
    appendFileSync(join(box.repo, 'test/admission.test.js'), '// main changed the checked file\n');
    box.git(box.repo, 'add', 'test/admission.test.js');
    box.git(box.repo, 'commit', '-q', '-m', 'test: move main after submit');
    box.env.CODEX_THREAD_ID = 'timing-reviewer-session';
    const reviewer = join(box.dir, 'reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
    document(fixtureJoin(box.run, reviewer, 'api', '--model', FIXTURE_MODEL, '--json'));
    const accepted = document(box.run(reviewer, 'verify', '1', 'accept', '--note', 'real timed admission observed', '--no-next', '--json'));
    assert.equal(accepted.decision, 'ACCEPT');
    const reviewReceipt = recentReceipts(box.repo).filter(row => row.kind === 'review').at(-1);
    assert.ok(reviewReceipt, 'native verification persisted its real admission receipt');
    assert.equal(reviewReceipt.timing, timing);
    assert.equal(reviewReceipt.exclusive, timing);
    assert.equal(reviewReceipt.occupiedSlots, timing ? 2 : 1);
    assert.deepEqual(reviewReceipt.unfencedClients, []);
    assert.equal(box.git(reviewer, 'status', '--porcelain'), '', 'verification leaves live source clean');
  });
}

import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { frozenCriterion } from '../../../../packages/spec/index.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { parseCheckTiming } from '../../../../packages/items/index.js';
import { frozenCheckTiming } from '../../../../packages/items/index.js';
import { CHECK_TIMING_ENGINE } from '../../../../packages/state/light.js';
import { exportBoard } from '../../../../packages/store/index.js';

/** Freeze actual production fields against a deliberately row-free domain criterion fixture. */
function freeze(item) {
  return frozenCriterion(parseSpec('# Explicit domain timing fixture\n'), item);
}

test('timing is coordinator-only boolean bar data, corrected atomically and absent from historical criteria [C7,V4,H16]', t => {
  const board = fixtureBoard(t);
  store.board_ensureCoordinator(board, '/fixture/main');
  const builder = store.register(board, { lane: 'web', path: '/fixture/builder' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'timing declaration', criterion: 'actual domain contract', check: 'true' });
  const old = freeze(store.getItem(board, id));
  assert.equal(Object.hasOwn(JSON.parse(old.text), 'checkTiming'), false);
  assert.equal(parseCheckTiming('false'), false);
  assert.throws(() => parseCheckTiming('FALSE'), { code: 'USAGE' });
  for (const options of [{ agentId: builder, checkTiming: true }, { agentId: 'coordinator', checkTiming: 'false' }]) {
    const before = exportBoard(board);
    assert.throws(() => store.editItem(board, id, options), { code: options.agentId === builder ? 'COORDINATOR_CHECK' : 'BAD_CHECK' });
    assert.deepEqual(exportBoard(board), before, 'refused declaration changes no event or state');
  }
  store.editItem(board, id, { agentId: 'coordinator', checkTiming: true });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, head: 'a'.repeat(40), freeze });
  const flagged = store.getItem(board, id);
  assert.equal(frozenCheckTiming(flagged), true);
  const before = exportBoard(board);
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator', checkTiming: false }), { code: 'BAR_REASON' });
  assert.deepEqual(exportBoard(board), before);
  store.editItem(board, id, { agentId: 'coordinator', checkTiming: false, reason: 'The measurement no longer has a timing budget', correction: true, freeze });
  const corrected = store.getItem(board, id);
  assert.notEqual(corrected.item_frozen_digest, flagged.item_frozen_digest);
  assert.equal(corrected.item_status, 'claimed', 'atomic correction retains the legitimate holder');
  assert.equal(frozenCheckTiming(corrected), false);
  assert.equal(corrected.item_check_timing, false);
  assert.equal(store.events(board, { itemId: id }).filter(row => row.event_kind === 'edit').at(-1).event_detail.includes('checkTiming'), true);
  board.executionEngineVersion = CHECK_TIMING_ENGINE - 1;
  const historic = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'old declaration', check: 'true' });
  assert.equal(Object.hasOwn(JSON.parse(freeze(store.getItem(board, historic)).text), 'checkTiming'), false);
  assert.throws(() => store.editItem(board, historic, { agentId: 'coordinator', checkTiming: true }), { code: 'ENGINE_VERSION' });
});

import { prepareEngineMove } from '../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';

test('older ordered edits cannot strip timing from a modern bar while historical receipts replay unchanged [C7,V4,H16]', t => {
  const board = fixtureBoard(t);
  store.board_ensureCoordinator(board, '/fixture/main');
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'ordered timing bar', check: 'true' });
  const historical = { ...prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'old criterion' }], { id: 'historical-unflagged-timing-edit' }), engine: CHECK_TIMING_ENGINE - 1 };
  const first = applyEngineMove(board, historical, { sequence: 1, at: '2026-10-28T00:01:00.000Z' });
  assert.equal(first.error, undefined, 'the real older unflagged edit records normally');
  const receipt = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${historical.id}`).meta_value;
  store.editItem(board, id, { agentId: 'coordinator', checkTiming: true });
  const next = { ...prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'new old-client criterion' }], { id: 'fresh-old-client-timing-edit' }), engine: CHECK_TIMING_ENGINE - 1 };
  const before = exportBoard(board);
  assert.throws(() => applyEngineMove(board, next, { sequence: 2, at: '2026-10-28T00:02:00.000Z' }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(board), before, 'refused old client changes neither cursor, state nor events');
  assert.equal(minimumMoveEngine('rehomeItem', [id, { agentId: 'coordinator' }], board), CHECK_TIMING_ENGINE);
  assert.equal(minimumMoveEngine('advanceItemSource', [id, { agentId: 'coordinator' }], board), CHECK_TIMING_ENGINE, 'automatic same-bar source advancement must understand timing admission');
  assert.equal(minimumMoveEngine('applyRehomeItem', [{ item: { item_frozen: JSON.stringify({ checkTiming: true }) } }, {}], board), CHECK_TIMING_ENGINE, 'preserved source frozen flag alone fences the destination');
  assert.deepEqual(applyEngineMove(board, historical, { sequence: 1, at: '2026-10-28T00:01:00.000Z' }), first);
  assert.equal(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${historical.id}`).meta_value, receipt);
  assert.deepEqual(exportBoard(board), before, 'an existing historical receipt remains byte-identical after activation');
});
