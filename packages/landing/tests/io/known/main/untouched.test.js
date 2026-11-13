/** A runner abort that names no case, in a file red on main that no batch item changed, is main's red [C7,#3073]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redOnMainUntouched } from '../../../../src/io/known/main.js';

const FILE = 'apps/cli/tests/worktree-maintenance-scheduler.test.js';
const ABORTED = { file: FILE, name: `/Users/example/.pullboard-runner/jobs/8faf/checkout/${FILE}` };

test('an aborted file red on main that no item changed is known-main [C7,#3073]', () => {
  assert.equal(redOnMainUntouched(ABORTED, { files: [{ file: FILE, result: 'red' }] }, new Set(['src/other.js'])), true);
});

test('a red in a file the batch changed still blocks, even when main fails it too [C7,#3073]', () => {
  assert.equal(redOnMainUntouched(ABORTED, { files: [{ file: FILE, result: 'red' }] }, new Set([FILE])), false);
});

test('a red in a file green on main, or with unreadable changes, still blocks [C7,#3073]', () => {
  assert.equal(redOnMainUntouched(ABORTED, { files: [{ file: FILE, result: 'green' }] }, new Set()), false);
  assert.equal(redOnMainUntouched(ABORTED, { files: [], coarseFiles: [] }, new Set()), false);
  assert.equal(redOnMainUntouched(ABORTED, { files: [{ file: FILE, result: 'red' }] }, null), false);
});

test('a named case is never excused by its file being red on main: it must match main case by case [C7,#3073]', () => {
  const named = { file: FILE, name: 'a private shipped CLI timer wakes once [B3,C7,N26]' };
  assert.equal(redOnMainUntouched(named, { files: [{ file: FILE, result: 'red' }] }, new Set()), false);
});

test('a case title that mentions the file path is a named case, never a whole-file row [C7,#3073]', () => {
  for (const name of [`handles /${FILE}`, `checks/${FILE}`, `/tmp/x ${FILE}`]) {
    assert.equal(redOnMainUntouched({ file: FILE, name }, { files: [{ file: FILE, result: 'red' }] }, new Set()), false, name);
  }
});
