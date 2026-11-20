/** @pullboard-test-input packages/landing/src/io/pulled/fresh.js */
/** The reopen note for a stale verdict asks a builder to resubmit for a fresh review when submit.composeAsObject is on, and is unchanged when it is off [C7,U159]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutStaleVerdicts } from '../../../../index.js';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../../../board/tests/fixtures/cell-board.js';
import { verifiedThenMainMoves } from '../../../fixtures/stale-verdict.js';

/** The note the offer writes when it reopens the stale item, under the given composeAsObject port. */
async function reopenNote(t, ports) {
  const { board, repo, item, main } = verifiedThenMainMoves(t, 'web/x.js', cellBoard);
  const notes = [];
  await withoutStaleVerdicts(board, repo.root, main, store.listItems(board, { all: true }), { candidate: () => true, say: () => {}, ...ports,
    write: async (operation, args) => { notes.push(args[1].note); return store[operation](board, args[0], args[1]); } });
  return { note: notes[0], main };
}

test('landing.fresh-stale-note.compose-on-asks-resubmit-for-fresh-review: clause 1: with the setting on the reopen note names the changed file and main commit and says resubmit for a fresh review, with no merge current main [C7,U159]', async t => {
  const { note, main } = await reopenNote(t, { composeAsObject: true });
  assert.match(note, new RegExp(`web/x\\.js changed on main in ${main.slice(0, 12)}`, 'u'));
  assert.match(note, /resubmit for a fresh review against current main/u);
  assert.doesNotMatch(note, /merge current main|merge main/u);
});

test('landing.fresh-stale-note.compose-off-note-unchanged: clause 2: with the setting off, or no setting passed, the reopen note is unchanged [C7,U159]', async t => {
  for (const ports of [{ composeAsObject: false }, {}]) {
    const { note, main } = await reopenNote(t, ports);
    assert.equal(note, `verdict stale: web/x.js changed on main in ${main.slice(0, 12)}, so the reviewed change no longer composes unchanged; merge current main, commit and resubmit`);
  }
});
