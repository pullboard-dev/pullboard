/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (V4, C3, N2, B5): the red gate, pre-push and next cases, split from next.test.js to stay under the runner time budget.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { failingParts } from '../../../../../packages/api/index.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();

after(e2e.cleanup);

const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('a red gate refuses submit [V4]', async t => {
  const box = project();
  writeFileSync(join(box.repo, 'RED'), 'red');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: turn the gate red');
  await fixtureAdd(box.runIn, box.repo, 'web', 'Page', '--specs', 'G1');
  assert.equal((await box.runIn(box.web, 'claim', '1')).code, 0);
  const item = `${box.web}-item-1`;
  assert.equal((await commitFile(box, item, 'web/red.html', 'candidate', 'feat(web): red gate witness [G1]')).status, 0);
  // A pulled submit queues its gate; the red receipt keeps the item out of review and is the refusal the builder reads [V4,C7,#7725].
  const queued = await box.runIn(item, 'submit', '1', '--json');
  assert.equal(queued.code, 0, queued.err + queued.out);
  const settled = await settleSubmit(t, { repo: box.repo, env: box.env, run: box.runIn }, JSON.parse(queued.out));
  assert.equal(settled.gate.green, false);
  assert.match(failingParts({ status: 1, gate: settled.gate }).join('\n'), /proof (?:failed|exited)|check exited/);
  assert.equal(JSON.parse((await box.runIn(box.repo, 'show', '1', '--json')).out).item_status, 'claimed');
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
  await commitFile(box, box.web, 'web/b.html', 'b', 'feat(web): second page [G1]');
  const notHere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one');
  assert.notEqual(notHere.status, 0);
  assert.match(notHere.stderr, /is not checked out/);
});

test('next claims the next free item in its folder; --verify names the next to check [N2,B5]', async t => {
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
  assert.equal((await commitFile(box, item, 'web/a.html', 'a', 'feat(web): page [G1]')).status, 0);
  // A pulled submit only queues its gate; the item stays claimed until the receipt applies, so wait for it before asking next.
  const submitted = await box.runIn(item, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  assert.equal((await settleSubmit(t, { repo: box.repo, env: box.env, run: box.runIn }, JSON.parse(submitted.out))).gate.green, true);
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
