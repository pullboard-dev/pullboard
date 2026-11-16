/** @pullboard-test-input apps/cli/src/io/read.js */
/** A main-independent write reads accepted main's policy before it takes the writer lock, never while holding it [C7,#8770]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { openKitBoard } from '../../fixtures/board.js';
import { atomic } from '../../../../../packages/store/index.js';
import { withOpenedBoard } from '../../../src/io/read.js';
import { fixturePolicy } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { repoInfo } from '../../../../../packages/git/index.js';

/**
 * Open the board for one named command and, inside its writer lock, move main to a policy that turns quarantine on.
 * A policy read made under the lock sees that new main; one made before the lock sees the main it started from.
 */
function quarantineSeenUnderLock(t, command) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const directory = join(box.repo, '.git', 'write-lock-policy-test');
  mkdirSync(directory);
  const ctx = { info: repoInfo(box.repo), io: { relayCommand: { cliOperation: command, positionals: [], values: {} } } };
  let seen;
  withOpenedBoard(ctx, opened => atomic(opened, () => {
    fixturePolicy(box, { flakes: { quarantine: true } });
    seen = opened.quarantineEnabled();
  }), openKitBoard(join(directory, 'board.sqlite')));
  return seen;
}

test('clause 1: a release reads quarantine from the main it started on, so no policy read, and no Git, runs under the writer lock [C7]', t => {
  assert.equal(quarantineSeenUnderLock(t, 'release'), false);
});

test('clause 2: a claim, which the same rule covers, also holds the writer lock without reading policy [C7]', t => {
  assert.equal(quarantineSeenUnderLock(t, 'claim'), false);
});
