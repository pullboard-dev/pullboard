/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../../../tests/fixtures/child.js';
import { existsSync } from 'node:fs';
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

/**
 * Run `pullboard claim` from two worktrees at once, so both race for the same lock.
 */
function race(box, first, second, id) {
  const one = (cwd) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [BIN, 'claim', String(id)], { cwd, env: box.env });
      let err = '';
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('close', (code) => done({ cwd, code, err }));
    });
  return Promise.all([one(first), one(second)]);
}

test('a red gate refuses submit [V4]', async () => {
  const box = project();
  writeFileSync(join(box.repo, 'RED'), 'red');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: turn the gate red');
  await fixtureAdd(box.runIn, box.repo, 'web', 'Page', '--specs', 'G1');
  assert.equal((await box.runIn(box.web, 'claim', '1')).code, 0);
  const item = `${box.web}-item-1`;
  assert.equal(commitFile(box, item, 'web/red.html', 'candidate', 'feat(web): red gate witness [G1]').status, 0);
  const refused = await box.runIn(item, 'submit', '1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /GATE_RED/);
});

test('verify runs at the submitted commit, against the criterion frozen at claim [V3, V7, V9, V19]', async () => {
  const box = project();
  await fixtureAdd(box.runIn, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders a heading');
  await box.runIn(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', '<h1>Hi</h1>', 'feat(web): page [G1]');
  assert.equal((await box.runIn(box.web, 'submit', '1')).code, 0);
  assert.match((await box.runIn(box.web, 'verify', '1', 'accept')).err, /SELF_VERIFY/);
  const unsaid = await box.runIn(box.repo, 'verify', '1', 'accept', '--note', 'ran it');
  assert.match(unsaid.err, /MAIN_IS_COORDINATOR\] this is the main checkout, so this verdict would be the coordinator's/);
  assert.match(unsaid.err, new RegExp(`Agent worktrees: web-1 \\(fixture-model\\) at ${box.web}`));
  assert.match((await box.runIn(box.web, 'verify', '1', 'accept', '--as', 'coordinator')).err, /USAGE.*only in the main checkout/);
  assert.match((await box.runIn(box.repo, 'verify', '1', 'accept', '--as', 'coordinator')).err, /NOT_AT_COMMIT/);
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('The page renders.', 'The page renders a heading.'));
  assert.equal((await box.runIn(box.repo, 'spec', 'approve', 'G1')).code, 0);
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  assert.match((await box.runIn(box.repo, 'verify', '1', 'accept', '--as', 'coordinator')).err, /CRITERIA_CHANGED/);
  assert.match((await box.runIn(box.repo, 'refreeze', '1')).out, /refrozen/);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal((await box.runIn(box.web, 'claim', '1')).code, 0);
  const refrozenItem = `${box.web}-item-1`;
  assert.equal(commitFile(box, refrozenItem, 'web/a.html', '<h1>Hi again</h1>', 'feat(web): update page [G1]').status, 0);
  const resubmitted = await box.runIn(refrozenItem, 'submit', '1');
  assert.equal(resubmitted.code, 0, resubmitted.err || resubmitted.out);
  const submittedHead = JSON.parse((await box.runIn(box.repo, 'show', '1', '--json')).out).item_commit;
  box.git(box.repo, 'switch', '--detach', submittedHead);
  assert.match((await box.runIn(box.repo, 'verify', '1', 'accept', '--as', 'coordinator')).err, /PROOF_REQUIRED/);
  assert.match((await box.runIn(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'removed the heading; the page test failed')).out, /verified #1: CRITERION_MET/);
  const show = (await box.runIn(box.repo, 'show', '1')).out;
  assert.match(show, /G1: The page renders a heading\./);
  assert.match(show, /ACCEPT CRITERION_MET by coordinator/);
  const ledger = (await box.runIn(box.repo, 'ledger')).out;
  assert.match(ledger, /1 verified by a second agent/);
  assert.match(ledger, /\| 1 \| web \| Page \| G1 \| web-1 \(fixture-model\) \| coordinator \(unknown\) \|/);
});

test('pre-push runs the gate once per tree and pushes only the checked-out commit [C3]', async () => {
  const box = project();
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  const first = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(box.repo, '.git', 'pullboard-gate-green')));
  assert.match((await box.runIn(box.repo, 'gate')).out, /this tree already passed/);
  const elsewhere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one:web/one');
  assert.equal(elsewhere.status, 0, 'web/one is at the same commit as main, so it is what is checked out');
  assert.match(`${elsewhere.stdout}${elsewhere.stderr}`, /the gate passed on this exact tree; not running it twice/, 'the second push of a passed tree skips the gate');
  commitFile(box, box.web, 'web/b.html', 'b', 'feat(web): second page [G1]');
  const notHere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one');
  assert.notEqual(notHere.status, 0);
  assert.match(notHere.stderr, /is not checked out/);
});

test('two agents racing for one item: exactly one wins, every time [B2]', async () => {
  const box = project();
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.match((await fixtureJoin(box.runIn, second, 'web', '--route', 'strong')).out, /joined as web-2/);
  for (let round = 1; round <= 6; round += 1) {
    await fixtureAdd(box.runIn, box.repo, 'web', `Item ${round}`);
    const results = await race(box, box.web, second, round);
    const winners = results.filter((result) => result.code === 0);
    const losers = results.filter((result) => result.code !== 0);
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
    assert.match(losers[0].err, /HELD/);
    assert.equal((await box.runIn(winners[0].cwd, 'release', String(round), '--reason', 'BLOCKED')).code, 0);
  }
});

test('next claims the next free item in its folder; --verify names the next to check [N2,B5]', async () => {
  const box = project();
  await fixtureAdd(box.runIn, box.repo, 'web', 'Page', '--specs', 'G1');
  await fixtureAdd(box.runIn, box.repo, 'web', 'Second page', '--specs', 'G1', '--after', '1');
  const first = await box.runIn(box.web, 'next');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /claimed #1: Page/);
  assert.match(first.out, /G1: The page renders\./);
  assert.ok(first.out.includes(`item folder: ${box.web}-item-1;`), 'next prints the claimed item\'s folder');
  assert.match(first.out, new RegExp(`when it is built and committed: cd ${box.web}-item-1 && pullboard submit 1`));
  assert.match((await box.runIn(box.web, 'next')).out, /you hold #1: Page/);
  const item = `${box.web}-item-1`;
  assert.equal(commitFile(box, item, 'web/a.html', 'a', 'feat(web): page [G1]').status, 0);
  const submitted = await box.runIn(item, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const blocked = await box.runIn(box.web, 'next', '--take');
  assert.equal(blocked.code, 1, blocked.err || blocked.out);
  // Since the idle-seat queue step, the refusal first names the seat's lane and route.
  assert.match(blocked.err, /NOTHING_FREE\] lane web, route strong: no item is free; nothing submitted that you did not build; #2 waits on #1 \(submitted, web lane\)/);
  assert.match((await box.runIn(box.repo, 'next', '--verify')).err, /MAIN_IS_COORDINATOR/);
  const named = (await box.runIn(box.repo, 'next', '--verify', '--as', 'coordinator')).out;
  assert.match(named, /next to verify: #1 Page, built by web-1/);
  assert.match(named, new RegExp(`check out exactly that commit, here: cd ${box.repo} && git switch --detach [0-9a-f]{40}`));
  assert.match(named, /pullboard verify 1 accept --as coordinator --note/);
  assert.match((await box.runIn(box.web, 'next', '--verify')).err, /NOTHING_FREE/);
});

test('next --verify can reserve a named submitted review and default to the lowest free one [V15]', async () => {
  const box = project();
  const reviewers = [];
  for (const name of ['api-1', 'api-2']) {
    const path = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path);
    const joined = await fixtureJoin(box.runIn, path, 'api', '--route', 'strong');
    assert.equal(joined.code, 0, joined.err);
    reviewers.push(path);
  }
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

  const named = await box.runIn(reviewers[0], 'next', '--verify', String(second));
  assert.equal(named.code, 0, named.err);
  assert.match(named.out, new RegExp(`next to verify: #${second} Second review, built by web-1`));
  assert.match(named.out, new RegExp(`check out exactly that commit, here: cd ${reviewers[0]} && git switch --detach [0-9a-f]{40}`));
  const namedJson = await box.runIn(reviewers[0], 'next', '--verify', String(second), '--json');
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

  const held = await box.runIn(reviewers[1], 'next', '--verify', String(second));
  assert.equal(held.code, 1, held.out);
  assert.match(held.err, /REVIEW_HELD/);
  const builder = await box.runIn(box.web, 'next', '--verify', String(first));
  assert.equal(builder.code, 1, builder.out);
  assert.match(builder.err, /SELF_VERIFY/);

  const lowest = await box.runIn(reviewers[1], 'next', '--verify');
  assert.equal(lowest.code, 0, lowest.err);
  assert.match(lowest.out, new RegExp(`next to verify: #${first} First review, built by web-1`));
});

test('a deleted spec row is refused at commit; spec check finds any id gone from history or cited [S8, S9]', async () => {
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
  assert.equal((await fixtureAdd(box.runIn, box.repo, 'web', 'Uses G3', '--specs', 'G3')).code, 0);
  writeFileSync(spec, SPEC.replace(/- G2 .*\n/, ''));
  const check = await box.runIn(box.repo, 'spec', 'check');
  assert.equal(check.code, 1);
  assert.match(check.out, /SPEC.md: G2 error: was committed in [0-9a-f]{12} and is gone/);
  assert.match(check.out, /SPEC.md: G7 error: commit [0-9a-f]{7,} cites it, but it was never committed/);
  assert.match(check.out, /SPEC.md: G3 error: item #1 cites it, but it was never committed/);
  writeFileSync(spec, `${SPEC.replace('- G2 [approved, must]', '- G2 [wont, must]')}- G3 [retired] Planned before the spec settled.\n- G7 [retired] Cited by mistake.\n`);
  const fixed = await box.runIn(box.repo, 'spec', 'check');
  assert.equal(fixed.code, 0, fixed.out);
  box.git(box.repo, 'add', 'SPEC.md');
  assert.equal(box.tryGit(box.repo, 'commit', '-q', '-m', 'docs(spec): keep every id').status, 0);
  const cited = commitFile(box, box.repo, 'docs/api.md', 'x', 'feat(api): call the api [G2]');
  assert.notEqual(cited.status, 0);
  assert.match(cited.stderr, /G2 is marked won't build/);
});
