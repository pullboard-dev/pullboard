/** @pullboard-test-gui */
/** The per-item projector the API reuses, checked against the full projection on a real board [A2,N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import * as serve from '../../src/io/view.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { projectItemState } from '../../../../packages/api/index.js';
import { lifecycleEvent } from '../../../../packages/items/index.js';
import { withdrawnFrom } from '../../../../packages/items/index.js';
import {
  machine,
  project,
  build,
  sendBack,
  accept,
} from '../../tests/fixtures/cockpit/harness.js';

/**
 * One item exactly as projectState wrote it inline before the per-item projector existed: the frozen reference that
 * says what "today's output" is, field for field and in the same order, with the withdrawn fields and lifecycle
 * history (lease deadlines on claims) every item has carried since.
 */
function todayItem(board, item, status) {
  const verdict = (row) => ({ decision: row.verdict_decision, reason: row.verdict_reason, note: row.verdict_note, by: row.verdict_by, at: row.verdict_at, commit: row.verdict_commit });
  const verdicts = store.verdictsFor(board, item.item_id).map(verdict);
  const after = item.item_after ? item.item_after.split(',').map(Number) : [];
  const history = store.events(board, { itemId: item.item_id }).map(lifecycleEvent);
  return {
    id: item.item_id,
    title: item.item_title,
    lane: item.item_lane,
    status: item.item_status,
    withdrawnReason: item.item_status === 'withdrawn' ? item.item_withdrawn_reason ?? null : null,
    withdrawnFrom: withdrawnFrom(history, item.item_status),
    route: item.item_route,
    owner: item.item_owner,
    reviewer: store.reviewHolder(board, item),
    reviewUntil: item.item_review_until ?? null,
    builtBy: item.item_built_by,
    verifiedBy: item.item_verified_by,
    specs: item.item_spec_ids ? item.item_spec_ids.split(',') : [],
    criterion: item.item_criterion,
    brief: item.item_brief,
    commit: item.item_commit,
    merged: item.item_merged_commit,
    blockedBy: after.filter((id) => status.get(id) !== 'verified'),
    updatedAt: item.item_updated_at,
    verdict: verdicts.at(-1) ?? null,
    verdicts,
    history,
  };
}

/** The same board connection, counting the per-item verdict reads that only building an item makes. */
function countingVerdictReads(board) {
  const counted = { reads: 0 };
  const db = new Proxy(board.db, {
    get(target, key) {
      if (key === 'prepare') return (sql) => { if (/FROM verdict WHERE item_id/.test(sql)) counted.reads += 1; return target.prepare(sql); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { board: { ...board, db }, counted };
}

test('the item projector matches the full projection [A2,N26]', () => {
  const box = machine();
  const p = project(box, 'projector-items');
  const add = (...args) => Number(/#(\d+)/.exec(box.run(p.repo, 'add', 'web', ...args))[1]);
  // Every state, with waits, verdicts and history: verified twice over, sent back, under review, claimed, open,
  // waiting, and withdrawn.
  const verified = add('Verified after a send-back', '--criterion', 'the page renders', '--specs', 'G1');
  build(box, p, verified, 'one.txt');
  sendBack(box, p, verified, 'the heading is missing');
  build(box, p, verified, 'two.txt');
  accept(box, p, verified);
  const reviewed = add('Under review', '--criterion', 'the page says goodbye', '--specs', 'G2');
  build(box, p, reviewed, 'three.txt');
  box.run(p.repo, 'next', '--verify', String(reviewed), '--as', 'coordinator');
  const sentBack = add('Sent back', '--criterion', 'a third page');
  build(box, p, sentBack, 'four.txt');
  sendBack(box, p, sentBack, 'it shows the wrong page');
  const claimed = add('Claimed', '--criterion', 'a fourth page');
  box.run(p.web, 'claim', String(claimed));
  const open = add('Open', '--criterion', 'a fifth page');
  const waiting = add('Waits on open and verified work', '--criterion', 'after the others', '--after', `${open},${verified},${claimed}`);
  const withdrawn = add('Withdrawn', '--criterion', 'nobody builds it');
  box.run(p.repo, 'withdraw', String(withdrawn), 'a duplicate of the open item');

  const file = join(p.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(file);
  try {
    const all = store.listItems(board, { all: true });
    const status = new Map(all.map((item) => [item.item_id, item.item_status]));
    assert.deepEqual([...new Set(status.values())].sort(), ['claimed', 'open', 'submitted', 'verified', 'withdrawn'], 'the board holds an item in every state');
    const full = serve.projectState(p.repo, { board });
    assert.ok('focusMilestone' in full && full.focusMilestone === null, 'with no focus set the projection carries focusMilestone: null [B26]');
    const byId = new Map(full.items.map((item) => [item.id, item]));
    assert.equal(byId.get(reviewed).reviewer !== null, true, 'the item under review names its reviewer');
    assert.deepEqual(byId.get(waiting).blockedBy, [open, claimed], 'the waiting item waits only on unverified work');
    assert.deepEqual(byId.get(verified).verdicts.map((verdict) => verdict.decision), ['REJECT', 'ACCEPT'], 'the verified item keeps both verdicts');
    assert.equal(byId.get(sentBack).verdict.decision, 'REJECT', 'the sent-back item shows its verdict');

    // With no callback, the projection is today's, byte for byte.
    assert.equal(JSON.stringify(full), JSON.stringify({ ...full, items: all.map((item) => todayItem(board, item, status)) }), 'projectState with no callback is today\'s output');
    // A pass-through callback changes nothing, and is offered each item in order with the board and the status map.
    const offered = [];
    const passed = serve.projectState(p.repo, { board, itemProjector: (item, context) => { offered.push([item.item_id, context.board === board, context.status.get(item.item_id)]); return context.project(); } });
    assert.equal(JSON.stringify(passed), JSON.stringify(full), 'projectState with a pass-through callback equals it too');
    assert.deepEqual(offered, all.map((item) => [item.item_id, true, item.item_status]), 'the callback is offered every item with its board and status');

    // Each item projected on its own is that item in the full projection, a fresh object each time, and it changes
    // neither the row nor the status map.
    assert.equal(typeof projectItemState, 'function', 'api.js exports projectItemState');
    for (const item of all) {
      const row = structuredClone(item), statuses = new Map(status);
      const one = projectItemState(board, item, status);
      assert.equal(JSON.stringify(one), JSON.stringify(byId.get(item.item_id)), `projectItemState for #${item.item_id} equals that item in the full projection`);
      assert.notEqual(projectItemState(board, item, status), one, `projectItemState for #${item.item_id} returns a fresh object`);
      assert.deepEqual(item, row, `projectItemState leaves #${item.item_id}'s row as it was`);
      assert.deepEqual(status, statuses, 'projectItemState leaves the status map as it was');
    }

    // A callback that returns its own object never has the item built: no per-item verdict read runs. The pass-through
    // control on the same counting connection reads one verdict list per item.
    const own = countingVerdictReads(board);
    const kept = new Map(all.map((item) => [item.item_id, { id: item.item_id, kept: true }]));
    const reused = serve.projectState(p.repo, { board: own.board, itemProjector: (item) => kept.get(item.item_id) });
    assert.equal(own.counted.reads, 0, 'project() is not called when the callback returns its own object');
    assert.deepEqual(reused.items, [...kept.values()], 'the items are the callback\'s own objects');
    assert.ok(reused.items.every((item, n) => item === kept.get(all[n].item_id)), 'each one is the very object the callback returned');
    const control = countingVerdictReads(board);
    serve.projectState(p.repo, { board: control.board, itemProjector: (item, { project }) => project() });
    assert.equal(control.counted.reads, all.length, 'project() reads each item\'s verdicts once when called');
  } finally {
    store.closeBoard(board);
  }
});

test('project state carries the focused release as name and item ids, and null without focus [B26,C7]', () => {
  const box = machine();
  const p = project(box, 'projector-focus');
  const add = (title) => Number(/#(\d+)/.exec(box.run(p.repo, 'add', 'web', title, '--criterion', 'a page renders'))[1]);
  const first = add('First'), second = add('Second');
  // @pullboard-board-file journey: seed the board file the real withdraw command reads
  const board = openBoard(join(p.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(serve.projectState(p.repo, { board }).focusMilestone, null);
    addMilestone(board, { agentId: 'coordinator', reason: 'Fixture release', name: 'focused', items: [first, second] });
    store.setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'focused', reason: 'Fixture focus.', window: { items: 2 } });
    assert.deepEqual(serve.projectState(p.repo, { board }).focusMilestone, { name: 'focused', items: [first, second] });
  } finally {
    store.closeBoard(board);
  }
});
