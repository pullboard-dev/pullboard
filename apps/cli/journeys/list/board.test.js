/**
 * End to end on real repos: doctrine citations, the shared board, spec ids and lane commits (A5, B1, B3, B6, L3, L4). Split from e2e.test.js to stay under two minutes.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const { SPEC, project, commitFile } = e2e;

test('items and commit headers cite doctrine rows by namespace; bare collisions warn [A5]', async () => {
  const box = project();
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Use the inherited rule', '--specs', 'doctrine:PB1'));
  assert.equal(added.code, 0, added.err);
  assert.match((await box.runLocal(box.repo, 'show', '1')).out, /\[doctrine:PB1\]/u);

  const message = join(box.dir, 'message.txt');
  writeFileSync(message, 'feat(web): use the inherited rule [doctrine:PB1]\n');
  const namespaced = (await box.runLocal(box.repo, 'hook', 'commit-msg', message));
  assert.equal(namespaced.code, 0, namespaced.err);
  assert.doesNotMatch(namespaced.out, /warning:/u);

  const doctrine = readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8');
  writeFileSync(join(box.repo, 'DOCTRINE.md'), `${doctrine}\n## Local\n- G1 [draft] A local rule colliding with SPEC.md.\n`);
  writeFileSync(message, 'feat(web): use the product rule [G1]\n');
  const warning = (await box.runLocal(box.repo, 'hook', 'commit-msg', message));
  assert.equal(warning.code, 0, warning.err);
  assert.match(warning.out, /warning: G1 is a known collision at SPEC\.md:4 and DOCTRINE\.md:\d+; bare ids cite SPEC\.md/u);
  assert.match(warning.out, /use doctrine:G1 for a doctrine row/u);
  const check = (await box.runLocal(box.repo, 'spec', 'check'));
  assert.equal(check.code, 1);
  assert.match(check.out, /duplicate id; also appears at DOCTRINE\.md:/u);
  const legacy = readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8');
  rmSync(join(box.repo, 'DOCTRINE.md'));
  writeFileSync(join(box.repo, 'PRACTICE.md'), legacy);
  const legacyCheck = (await box.runLocal(box.repo, 'spec', 'check'));
  assert.equal(legacyCheck.code, 1);
  assert.match(legacyCheck.out, /SPEC\.md:4 G1 error: duplicate id; also appears at PRACTICE\.md:\d+/u);
  assert.match(legacyCheck.out, /PRACTICE\.md:\d+ G1 error: duplicate id; also appears at SPEC\.md:4/u);
  assert.doesNotMatch(legacyCheck.out, /DOCTRINE\.md:/u);
});

test('clause 1: the board lives in the git common dir; every worktree sees it; nothing is committed [B1, B3]', async () => {
  const box = project();
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Build', 'the', 'page', '--specs', 'G1')).out.trim().split('\n');
  assert.equal(added[0], '#1');
  assert.match(added.at(-1), /^next: pullboard next$/u);
  const listed = JSON.parse((await box.runLocal(box.web, 'list', '--json')).out).items.find(item => item.item_id === 1);
  assert.equal(listed.item_status, 'open');
  assert.equal(listed.item_lane, 'web');
  assert.equal(listed.item_title, 'Build the page');
  assert.equal(listed.item_spec_ids, 'G1');
  assert.ok(existsSync(join(box.repo, '.git', 'pullboard', 'board.sqlite')));
  assert.equal(box.git(box.repo, 'status', '--porcelain'), '');
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'whoami', '--json')).out).lane, 'coordinator');
  const firstSeat = JSON.parse((await box.runLocal(box.web, 'whoami', '--json')).out);
  assert.deepEqual([firstSeat.id, firstSeat.lane, firstSeat.model], ['web-1', 'web', 'fixture-model']);
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.match(fixtureJoin(box.run, second, 'web', '--model', 'Fixture').out, /joined as web-2/);
  const secondSeat = JSON.parse((await box.runLocal(second, 'whoami', '--json')).out);
  assert.deepEqual([secondSeat.id, secondSeat.lane, secondSeat.model], ['web-2', 'web', 'Fixture'], 'a second worktree in the same lane is its own agent');
  const stillFirst = JSON.parse((await box.runLocal(box.web, 'whoami', '--json')).out);
  assert.deepEqual([stillFirst.id, stillFirst.lane, stillFirst.model], ['web-1', 'web', 'fixture-model'], 'and the first stays itself');
  assert.match((await box.runLocal(box.web, 'init')).err, /NOT_MAIN/);
  assert.match(fixtureJoin(box.run, box.repo, 'web').err, /MAIN_IS_COORDINATOR/);
});

test('items cite spec ids that exist [B6]', async () => {
  const box = project();
  const refused = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Ghost', '--specs', 'G9'));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /UNKNOWN_SPEC\] G9 is not in SPEC.md/);
});

test('a lane commits only inside its folders; an unjoined worktree cannot commit [L3, L4]', () => {
  const box = project();
  const loose = join(box.dir, 'loose');
  box.git(box.repo, 'worktree', 'add', '-q', loose, '-b', 'loose');
  const unjoined = commitFile(box, loose, 'web/a.html', 'a', 'feat(web): page [G1]');
  assert.notEqual(unjoined.status, 0);
  assert.match(unjoined.stderr, /has not joined a lane/);
  const foreign = commitFile(box, box.web, 'api/a.js', 'a', 'feat(web): page [G1]');
  assert.match(foreign.stderr, /outside the web lane: api\/a.js \(api's\)/);
  assert.match(foreign.stderr, /Fix what each line names/, 'a blocked hook says what to do (C4)');
  box.git(box.web, 'reset', '-q', '--hard');
  box.git(box.web, 'clean', '-fdq');
  assert.equal(commitFile(box, box.web, 'docs/web.md', 'shared', 'docs: web notes').status, 0);
  assert.equal(commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]').status, 0);
  mkdirSync(join(box.web, 'api'));
  box.git(box.web, 'mv', 'web/a.html', 'api/a.html');
  const moved = box.tryGit(box.web, 'commit', '-q', '-m', 'refactor(web): move the page');
  assert.match(moved.stderr, /outside the web lane: api\/a.html/);
  assert.equal(commitFile(box, box.repo, 'api/b.js', 'b', 'feat(api): an api file [G2]').status, 0);
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.match(fixtureJoin(box.run, second, 'web', '--model', 'Fixture').out, /joined as web-2/);
  mkdirSync(join(second, 'web'), { recursive: true });
  box.git(second, 'mv', 'api/b.js', 'web/b.js');
  const taken = box.tryGit(second, 'commit', '-q', '-m', 'refactor(web): take the api file');
  assert.match(taken.stderr, /outside the web lane: api\/b.js/, 'a move counts where it left, not only where it lands');
});

test("a lane merges main's foreign changes but still refuses its own and non-main foreign changes [L3]", () => {
  const mainChange = project();
  assert.equal(commitFile(mainChange, mainChange.repo, 'api/main.js', 'from main', 'feat(api): main change [G2]').status, 0);
  const preparedMerge = mainChange.tryGit(mainChange.web, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(preparedMerge.status, 0, preparedMerge.stderr);
  const merged = mainChange.tryGit(mainChange.web, 'commit', '-q', '-m', 'Merge main');
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(mainChange.git(mainChange.web, 'show', 'HEAD:api/main.js'), 'from main');

  const editedDuringMerge = project();
  assert.equal(commitFile(editedDuringMerge, editedDuringMerge.repo, 'api/main.js', 'from main', 'feat(api): main change [G2]').status, 0);
  const preparedMain = editedDuringMerge.tryGit(editedDuringMerge.web, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(preparedMain.status, 0, preparedMain.stderr);
  writeFileSync(join(editedDuringMerge.web, 'api/main.js'), 'changed in the lane merge');
  editedDuringMerge.git(editedDuringMerge.web, 'add', 'api/main.js');
  const changedForeign = editedDuringMerge.tryGit(editedDuringMerge.web, 'commit', '-q', '-m', 'Merge main');
  assert.notEqual(changedForeign.status, 0);
  assert.match(changedForeign.stderr, /outside the web lane: api\/main.js/);

  const sideBranch = project();
  sideBranch.git(sideBranch.repo, 'switch', '-q', '-c', 'side');
  assert.equal(commitFile(sideBranch, sideBranch.repo, 'api/side.js', 'from side', 'feat(api): side change [G2]').status, 0);
  sideBranch.git(sideBranch.repo, 'switch', '-q', 'main');
  const preparedSide = sideBranch.tryGit(sideBranch.web, 'merge', '--no-commit', '--no-ff', 'side');
  assert.equal(preparedSide.status, 0, preparedSide.stderr);
  const changedSide = sideBranch.tryGit(sideBranch.web, 'commit', '-q', '-m', 'Merge side');
  assert.notEqual(changedSide.status, 0);
  assert.match(changedSide.stderr, /outside the web lane: api\/side.js/);
});

