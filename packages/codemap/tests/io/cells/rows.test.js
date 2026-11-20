/** @pullboard-test-input packages/codemap/index.js packages/codemap/src/io/cells/move/rows.js packages/kernel/index.js */
/** A cited spec row whose text changed without a rewrite edit refuses, naming the coordinator [B4,R2,#5704]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveAfterRowRewrite } from '../../../index.js';
import { requireRewrittenRows } from '../../../index.js';
import { requireRowRewriteForMove } from '../../../index.js';

const frozen = text => JSON.stringify({ criterion: 'x', rows: [{ id: 'C7', text }] });
const item = (id, status, text) => ({ item_id: id, item_status: status, item_frozen: frozen(text) });
const LIVE = [{ id: 'C7', text: 'CI runs the gate on every push, Node 22.13 and 24.' }];

test('codemap.rows.a-cited-spec-row-whose: clause 1: a cited spec row whose text changed without a recorded rewrite edit refuses, naming the coordinator as the next step [B4,R2]', () => {
  assert.throws(() => requireRewrittenRows([item(7, 'claimed', 'CI runs the gate on every push.')], LIVE, { enabled: true }),
    error => error.code === 'ROW_REWRITE_MISSING' && /#7 cites C7/u.test(error.message) && /ask the coordinator to rewrite its bar: pullboard edit 7 /u.test(error.next));
});

test('codemap.rows.a-row-that-still-reads: clause 1: a row that still reads as frozen, a closed item and the setting off all pass [B4,R2]', () => {
  const same = item(1, 'open', LIVE[0].text);
  const old = 'CI runs the gate on every push.';
  assert.doesNotThrow(() => requireRewrittenRows([same, item(2, 'landed', old)], LIVE, { enabled: true }));
  assert.doesNotThrow(() => requireRewrittenRows([item(3, 'open', old)], LIVE), 'off by default');
});

/** A stand-in for the pullboard command: list answers the items, spec answers the live rows; every call is recorded. */
function board(items, { listStatus = 0, specStatus = 0 } = {}) {
  const calls = [];
  const run = args => {
    calls.push(args.join(' '));
    if (args[0] === 'list') return { status: listStatus, stdout: JSON.stringify({ version: 1, items }), stderr: listStatus ? 'no board' : '' };
    return { status: specStatus, stdout: JSON.stringify({ version: 1, rows: LIVE }), stderr: specStatus ? 'spec has an error' : '' };
  };
  return { run, calls };
}

const stale = item(7, 'claimed', 'CI runs the gate on every push.');

test('codemap.rows.a-move-refuses-while-an-open: clause 1: with the setting on, a move refuses with ROW_REWRITE_MISSING naming the coordinator while an open item cites a changed row, and the move never runs [B4,R2]', () => {
  const { run, calls } = board([stale]);
  let moved = false;
  assert.throws(() => moveAfterRowRewrite({ run, enabled: true }, () => { moved = true; }),
    error => error.code === 'ROW_REWRITE_MISSING' && /#7 cites C7/u.test(error.message) && /ask the coordinator to rewrite its bar/u.test(error.next));
  assert.equal(moved, false, 'the refusal happens before the move, so no file moves');
  assert.deepEqual(calls, ['list --json', 'spec --json']);
});

test('codemap.rows.the-setting-off-moves-normally: clause 2: with the setting off the same board state moves normally, refuses nothing and reads nothing [B4,R2]', () => {
  const { run, calls } = board([stale]);
  assert.equal(moveAfterRowRewrite({ run, enabled: false }, () => 'moved'), 'moved');
  assert.equal(moveAfterRowRewrite({ run }, () => 'moved'), 'moved', 'off by default');
  assert.deepEqual(calls, []);
});

test('codemap.rows.a-clean-board-moves: clause 1: with the setting on and no changed cited row the move runs once [B4,R2]', () => {
  const { run } = board([item(1, 'open', LIVE[0].text), item(2, 'landed', 'CI runs the gate on every push.')]);
  let runs = 0;
  assert.equal(moveAfterRowRewrite({ run, enabled: true }, () => { runs += 1; return 'moved'; }), 'moved');
  assert.equal(runs, 1);
});

test('codemap.rows.an-unreadable-board-refuses: clause 1: with the setting on, a failed items or spec read refuses with ROW_REWRITE_UNREAD and the move never runs [B4,R2]', () => {
  for (const failing of [{ listStatus: 1 }, { specStatus: 1 }]) {
    const { run } = board([stale], failing);
    let moved = false;
    assert.throws(() => requireRowRewriteForMove({ run, enabled: true }), error => error.code === 'ROW_REWRITE_UNREAD');
    assert.throws(() => moveAfterRowRewrite({ run, enabled: true }, () => { moved = true; }), error => error.code === 'ROW_REWRITE_UNREAD');
    assert.equal(moved, false);
  }
});
