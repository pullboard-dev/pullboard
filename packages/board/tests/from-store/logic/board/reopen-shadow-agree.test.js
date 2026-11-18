/** The reopen shadow compare agrees with the writer on a seat's reported-conflict reopen (#9150 and its kin) and still refuses what the table should refuse [C7,#9359]. */
/** @pullboard-test-input packages/store/src/io/board/reopen-table.js packages/moves/src/logic/table/reopen.table.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

const COMMIT = '5108337ee32cb03255cf0517a606664959b053d5';
const TRUNK = 'f7eff113370187b2aa443c6a9dbeb02b93125ceb';
const CONFLICT = { files: ['packages/api/index.js'], trunk: TRUNK };
const NOTE = 'conflicts with the trunk at f7eff1133701 in packages/api/index.js; merge main and resubmit';
const COMPUTED = { version: 4, item: 9150, actor: 'core-4871', head: COMMIT, trunk: TRUNK, files: CONFLICT.files, submission: 518954 };
const WINDOW = { builder: 'core-4861', until: '2026-11-16T16:20:54.206Z' };

/** The call the writer made for #9150's reopen: a builder seat reported a conflict the board computed, so reopenAuthority had already accepted it. */
function writerCall(over = {}) {
  return { before: { item_status: 'submitted', item_commit: COMMIT, item_merged_commit: null }, agentId: 'core-4871', joined: true, note: NOTE, cause: 'conflict:packages/api/index.js',
    conflict: CONFLICT, withdrawVerdict: false, conflictAccepted: true, conflictNote: NOTE, derivedCause: { cause: 'conflict:packages/api/index.js' }, causeOverrides: true,
    reservation: { reopenFirstRefusal: WINDOW }, conflictDetail: { conflict: CONFLICT }, computedConflict: COMPUTED, ...over };
}

/** The reopen event the writer recorded for it, as the shadow hook reads it back from the event table. */
const wrote = [{ kind: 'reopen', by: 'core-4871', detail: JSON.stringify({ commit: COMMIT, note: NOTE, judgment: null, reopenFirstRefusal: WINDOW, conflict: CONFLICT, cause: 'conflict:packages/api/index.js', computedConflict: COMPUTED }) }];

test('board.reopen-shadow-agree.seats-reported-conflict-reopen-not-refused: clause 1: a seat\'s reported-conflict reopen is not refused and the compare reads no difference [C7,#9359]', t => {
  cellBoard(t, ':memory:');
  const decided = store.reopenDecision(9150, writerCall());
  assert.equal(decided.refused, undefined, `refused: ${JSON.stringify(decided.refused)}`);
  assert.equal(store.reopenDiffers({ decided, wrote }), null);
});

test('board.reopen-shadow-agree.merged-item-and-non-coordinator-reopen: clause 2: a merged item and a non-coordinator reopen with no reported conflict still read refused [C7,#9359]', t => {
  cellBoard(t, ':memory:');
  const merged = store.reopenDecision(9150, writerCall({ agentId: 'coordinator', before: { item_status: 'verified', item_commit: COMMIT, item_merged_commit: 'a'.repeat(40) }, conflict: undefined, computedConflict: undefined }));
  assert.equal(merged.refused?.code, 'ALREADY_MERGED');
  assert.equal(store.reopenDiffers({ decided: merged, wrote }), 'refused');
  const bare = store.reopenDecision(9150, writerCall({ conflict: undefined, conflictDetail: undefined, computedConflict: undefined }));
  assert.equal(bare.refused?.code, 'COORDINATOR_ONLY');
  assert.equal(store.reopenDiffers({ decided: bare, wrote }), 'refused');
});
