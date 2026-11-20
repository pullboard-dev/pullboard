/** A land job's reopen note tells a builder to fix and resubmit when the merged tree went red, and to merge main only when the job could not merge [C7,U159]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { returnedItemNote } from '../../../src/io/gate.js';

const RED = 'land job land:7:x checked the merged tree red: test failed: a.test.js';
const CONFLICT = 'land job land:7:x could not merge it: CONFLICT in a.js';

test('api.gate-red-reopen-note.red-tree-fix-and-resubmit: clause 1: the reopen note of a land job that checked the merged tree red says fix it, commit and resubmit, with no "merge current main" [C7,U159]', () => {
  for (const reason of ['red', 'hook']) {
    const note = returnedItemNote(reason, RED);
    assert.match(note, /fix it, commit and resubmit \(submit composes current main\)/u);
    assert.doesNotMatch(note, /merge current main/u);
  }
});

test('api.gate-red-reopen-note.red-tree-names-failure: clause 2: the red note still names the land job and the first failing line, and a land job that could not merge still says merge current main and resolve [C7,U159]', () => {
  assert.ok(returnedItemNote('red', RED).startsWith(RED), 'the red note leads with the job and the failing line');
  const conflict = returnedItemNote('conflict', CONFLICT);
  assert.ok(conflict.startsWith(CONFLICT));
  assert.match(conflict, /merge current main, resolve the conflict, commit and resubmit/u);
});
