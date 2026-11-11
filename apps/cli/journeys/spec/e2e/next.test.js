/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();

after(e2e.cleanup);

const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('next claims the next free item in its folder; --verify names the next to check [N2,B5]', () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1');
  fixtureAdd(box.run, box.repo, 'web', 'Second page', '--specs', 'G1', '--after', '1');
  const first = box.run(box.web, 'next');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /claimed #1: Page/);
  assert.match(first.out, /G1: The page renders\./);
  assert.ok(first.out.includes(`item folder: ${box.web}-item-1;`), 'next prints the claimed item\'s folder');
  assert.match(first.out, new RegExp(`when it is built and committed: cd ${box.web}-item-1 && pullboard submit 1`));
  assert.match(box.run(box.web, 'next').out, /you hold #1: Page/);
  const item = `${box.web}-item-1`;
  assert.equal(commitFile(box, item, 'web/a.html', 'a', 'feat(web): page [G1]').status, 0);
  const submitted = box.run(item, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const blocked = box.run(box.web, 'next', '--take');
  assert.equal(blocked.code, 1, blocked.err || blocked.out);
  // Since the idle-seat queue step, the refusal first names the seat's lane and route.
  assert.match(blocked.err, /NOTHING_FREE\] lane web, route strong: no item is free; nothing submitted that you did not build; #2 waits on #1 \(submitted, web lane\)/);
  assert.match(box.run(box.repo, 'next', '--verify').err, /MAIN_IS_COORDINATOR/);
  const named = box.run(box.repo, 'next', '--verify', '--as', 'coordinator').out;
  assert.match(named, /next to verify: #1 Page, built by web-1/);
  assert.match(named, new RegExp(`check out exactly that commit, here: cd ${box.repo} && git switch --detach [0-9a-f]{40}`));
  assert.match(named, /pullboard verify 1 accept --as coordinator --note/);
  assert.match(box.run(box.web, 'next', '--verify').err, /NOTHING_FREE/);
});

test('next --verify can reserve a named submitted review and default to the lowest free one [V15]', () => {
  const box = project();
  const reviewers = ['api-1', 'api-2'].map((name) => {
    const path = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path);
    const joined = fixtureJoin(box.run, path, 'api', '--route', 'strong');
    assert.equal(joined.code, 0, joined.err);
    return path;
  });
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let first;
  let second;
  try {
    const commit = box.git(box.repo, 'rev-parse', 'HEAD');
    const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
    /** Create and submit an item through the real SQLite board state. */
    const submit = (title) => {
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
      store.claim(board, id, {
        agentId: 'web-1', lane: 'web', leaseMs: 60 * 60_000,
        freeze: (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` }),
      });
      submitFixture(board, id, { agentId: 'web-1', commit, tree });
      return id;
    };
    first = submit('First review');
    second = submit('Second review');
  } finally {
    store.closeBoard(board);
  }

  const named = box.run(reviewers[0], 'next', '--verify', String(second));
  assert.equal(named.code, 0, named.err);
  assert.match(named.out, new RegExp(`next to verify: #${second} Second review, built by web-1`));
  assert.match(named.out, new RegExp(`check out exactly that commit, here: cd ${reviewers[0]} && git switch --detach [0-9a-f]{40}`));
  const namedJson = box.run(reviewers[0], 'next', '--verify', String(second), '--json');
  assert.equal(namedJson.code, 0, namedJson.err);
  const result = JSON.parse(namedJson.out);
  assert.equal(result.version, 1);
  assert.equal(result.item.item_id, second);
  assert.equal(result.review, true);
  assert.equal(result.held, false);
  assert.deepEqual(result.shared, []);
  const reserved = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(store.getItem(reserved, second).item_review_by, 'api-1', 'the named item is reserved for the caller');
  } finally {
    store.closeBoard(reserved);
  }

  const held = box.run(reviewers[1], 'next', '--verify', String(second));
  assert.equal(held.code, 1, held.out);
  assert.match(held.err, /REVIEW_HELD/);
  const builder = box.run(box.web, 'next', '--verify', String(first));
  assert.equal(builder.code, 1, builder.out);
  assert.match(builder.err, /SELF_VERIFY/);

  const lowest = box.run(reviewers[1], 'next', '--verify');
  assert.equal(lowest.code, 0, lowest.err);
  assert.match(lowest.out, new RegExp(`next to verify: #${first} First review, built by web-1`));
});

test('a deleted spec row is refused at commit; spec check finds any id gone from history or cited [S8, S9]', () => {
  const box = project();
  const spec = join(box.repo, 'SPEC.md');
  writeFileSync(spec, SPEC.replace(/- G2 .*\n/, ''));
  box.git(box.repo, 'add', 'SPEC.md');
  const refused = box.tryGit(box.repo, 'commit', '-q', '-m', 'docs(spec): drop the api row');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /SPEC.md: G2 is gone; ids are permanent: keep the row and mark it wont/);
  box.git(box.repo, 'commit', '-q', '--no-verify', '-m', 'docs(spec): drop the api row');
  box.git(box.repo, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'feat(web): ghost [G7]');
  writeFileSync(spec, `${SPEC.replace(/- G2 .*\n/, '')}- G3 [draft, must] Not committed yet.\n`);
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Uses G3', '--specs', 'G3').code, 0);
  writeFileSync(spec, SPEC.replace(/- G2 .*\n/, ''));
  const check = box.run(box.repo, 'spec', 'check');
  assert.equal(check.code, 1);
  assert.match(check.out, /SPEC.md: G2 error: was committed in [0-9a-f]{12} and is gone/);
  assert.match(check.out, /SPEC.md: G7 error: commit [0-9a-f]{7,} cites it, but it was never committed/);
  assert.match(check.out, /SPEC.md: G3 error: item #1 cites it, but it was never committed/);
  writeFileSync(spec, `${SPEC.replace('- G2 [approved, must]', '- G2 [wont, must]')}- G3 [retired] Planned before the spec settled.\n- G7 [retired] Cited by mistake.\n`);
  const fixed = box.run(box.repo, 'spec', 'check');
  assert.equal(fixed.code, 0, fixed.out);
  box.git(box.repo, 'add', 'SPEC.md');
  assert.equal(box.tryGit(box.repo, 'commit', '-q', '-m', 'docs(spec): keep every id').status, 0);
  const cited = commitFile(box, box.repo, 'docs/api.md', 'x', 'feat(api): call the api [G2]');
  assert.notEqual(cited.status, 0);
  assert.match(cited.stderr, /G2 is marked won't build/);
});
