/** BAR_CLAUSE_REQUIRED lists the frozen clauses, ready to paste (UX F7, #6565). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureOpenBoard } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const CRITERION = '1. The page renders its title [test]. 2. The page renders its footer [test].';

test('clause 1: the BAR_CLAUSE_REQUIRED refusal lists each frozen clause as a paste-ready --clause argument [F7]', async t => {
  const helpers = createE2eHelpers();
  let board;
  t.after(() => { if (board) store.closeBoard(board); helpers.cleanup(); });
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runIn, box.repo, 'web', 'Render the page', '--criterion', CRITERION,
    '--check', 'test -f web/page.html', '--route', 'strong', '--brief', 'Files: web/page.html\nTest: assert the title and footer.', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runIn(box.web, 'claim', String(id))).code, 0);
  const committed = helpers.commitFile(box, box.web, 'web/page.html', '<main>Missing the title</main>', 'feat(web): render a page [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  // @pullboard-board-file persistence: separate CLI reviewer commands read and append this exact private board file.
  board = fixtureOpenBoard(box);
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  submitFixture(board, id, { agentId: 'web-1', commit: head, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') });
  const reviewer = join(box.dir, 'clause-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  box.env.CODEX_THREAD_ID = 'independent-clause-refusal-fixture';
  assert.equal((await fixtureJoin(box.runIn, reviewer, 'api', '--route', 'strong')).code, 0);
  const reserved = await box.runIn(reviewer, 'next', '--verify', String(id), '--json');
  assert.equal(reserved.code, 0, reserved.out || reserved.err);
  const missing = await box.runIn(reviewer, 'verify', String(id), 'reject', '--reason', 'TEST_FAILURE', '--note', 'The title is missing.', '--json');
  assert.equal(missing.code, 1, missing.err + missing.out);
  const error = JSON.parse(missing.out).error;
  assert.equal(error.code, 'BAR_CLAUSE_REQUIRED');
  assert.match(error.next, /--clause "1\. The page renders its title \[test\]\."/u);
  assert.match(error.next, /--clause "2\. The page renders its footer \[test\]\."/u);
  assert.doesNotMatch(error.next, /--clause "[12]\."/u, 'a bare clause number is not a clause');
});
