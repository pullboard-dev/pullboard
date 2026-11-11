/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/pullboard.js apps/cli/tests/fixtures/lock/hold/budget/preload.js */
/** The policy snapshot ignores a command's own Git churn but still refuses a foreign policy write [C7,V4,B2]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openBoard } from '../../../lib/index.js';
import { atomic } from '../../../../packages/store/index.js';
import { withOpenedBoard } from '../../index.js';
import { repoInfo } from '../../../../packages/git/index.js';

/** Commit one accepted-source alias, the same foreign write the budget test uses. */
function declare(box, alias) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, families: { openai: [alias] } }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: fixture accepted policy');
}

/** One real repo, one file board opened by the production opener. */
function setup(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  declare(box, 'codex');
  const directory = join(box.repo, '.git', 'policy-own-write-test');
  mkdirSync(directory);
  // @pullboard-board-file locking: the production opener owns this file board.
  const board = openBoard(join(directory, 'board.sqlite'));
  return { box, board, ctx: { info: repoInfo(box.repo), io: {} } };
}

test('a command that creates and removes Git lock files in its own write is not stale [C7,V4,B2]', t => {
  const { box, board, ctx } = setup(t);
  const gitDir = join(box.repo, '.git');
  let work = 0;
  withOpenedBoard(ctx, opened => atomic(opened, () => {
    work++;
    // The same directory churn as an index refresh or a companion composition inside the write.
    for (const name of ['index.lock', 'scratch-own-write', 'policy-own-write.lock']) {
      writeFileSync(join(gitDir, name), 'x');
      rmSync(join(gitDir, name));
    }
    writeFileSync(join(box.repo, 'own-write-scratch'), 'x');
    rmSync(join(box.repo, 'own-write-scratch'));
  }), board);
  assert.equal(work, 1);
});

test('a foreign accepted-policy write during the same write still refuses [C7,V4,B2]', t => {
  const { box, board, ctx } = setup(t);
  assert.throws(() => withOpenedBoard(ctx, opened => atomic(opened, () => {
    writeFileSync(join(box.repo, '.git', 'scratch-own-write'), 'x');
    declare(box, 'foreign-writer');
  }), board), error => error.code === 'POLICY_SNAPSHOT_STALE');
});
