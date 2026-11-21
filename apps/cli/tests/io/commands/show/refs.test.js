/**
 * End to end on real repos, part two: replacement refs, red owned trees and detached coordinator reviews
 * (L3, V4, V16, M3).
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { submitFixture } from '../../../fixtures/board/submit.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureAdd } from '../../../fixtures/testkit.js';
import { fixtureJoin } from '../../../fixtures/testkit.js';
import { openKitBoard } from '../../../fixtures/board.js';
import { settleSubmit } from '../../../fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, attackCommit, LIGHT_BRIEF,
} = e2e;

/**
 * Assert a green submit routed only foreign paths to their owner: the builder is freed and nothing is submitted (B3,L1,V4).
 *
 * Why: the ownership routing (814a7def2a) replaced the immediate OUTSIDE_LANE refusal for proved foreign paths; the owner decides.
 */
async function assertWaitsOnOwner(t, box, id, submitted, paths, label = '') {
  assert.equal(submitted.code, 0, `${label} ${submitted.out}${submitted.err}`);
  // A pulled gate settles on the machine's runner; the green proof of foreign paths is routed to its owner when its receipt applies [P7,C7,#7705].
  await settleSubmit(t, { repo: box.repo, env: box.env, run: box.inProcess }, JSON.parse(submitted.out));
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let waiting;
  try { waiting = store.ownershipWait(board, id); } finally { store.closeBoard(board); }
  assert.deepEqual(waiting?.owners, ['coordinator'], label);
  for (const path of paths) assert.equal(waiting.paths.includes(path), true, `${label} ${path}`);
  const item = JSON.parse((await box.inProcess(box.repo, 'show', String(id), '--json')).out);
  assert.equal(item.item_status, 'open', label);
  assert.equal(item.item_commit, null, `${label}: owner waiting is not a submission`);
  assert.match(item.item_hold_reason, /^waiting on ownership /u, label);
}


test('cli.journeys-show-policy-refs.accept-independently-refuses-a-historically-unchecked: accept independently refuses a historically unchecked foreign submission [L3,M3]', async () => {
  const box = project('true');
  assert.equal((await fixtureAdd(box.runIn, box.repo, 'web', 'Foreign receipt', '--specs', 'G1', '--criterion', 'the original check passes', '--brief', LIGHT_BRIEF, '--check', 'true')).code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  writeFileSync(join(box.web, 'coordinator.txt'), 'unauthorized');
  const commit = attackCommit(box, box.web);
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') }); }
  finally { store.closeBoard(board); }
  const review = join(box.dir, 'foreign-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal((await fixtureJoin(box.runIn, review, 'api')).code, 0);
  const refused = await box.inProcess(review, 'verify', '1', 'accept', '--note', 'a green check cannot authorize this path', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE');
});

test('cli.journeys-show-policy-refs.replacement-refs-cannot-conceal-the-real: clause 1: replacement refs cannot conceal the real submitted foreign paths [L3,V4,M3]', async () => {
  const box = project('true');
  assert.equal((await fixtureAdd(box.runIn, box.repo, 'web', 'Replacement probe', '--specs', 'G1', '--criterion', 'the original check passes', '--brief', LIGHT_BRIEF, '--check', 'true')).code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  writeFileSync(join(box.web, 'coordinator.txt'), 'underlying unauthorized object');
  const commit = attackCommit(box, box.web);
  box.git(box.web, 'replace', commit, base);
  box.git(box.web, 'reset', '--hard', 'HEAD');
  assert.equal(existsSync(join(box.web, 'coordinator.txt')), false, 'Git normally shows the replacement tree');
  const submitted = await box.inProcess(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'DIRTY', 'the underlying tree differs from the visible one, so submit refuses before the lane check');
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId: 'web-1', commit, tree: 'synthetic unchecked tree' }); }
  finally { store.closeBoard(board); }
  const review = join(box.dir, 'replacement-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal((await fixtureJoin(box.runIn, review, 'api')).code, 0);
  const accepted = await box.inProcess(review, 'verify', '1', 'accept', '--note', 'the replacement is not the pinned object', '--json');
  assert.equal(accepted.code, 1);
  assert.equal(JSON.parse(accepted.out).error.code, 'OUTSIDE_LANE');
});

test('cli.journeys-show-policy-refs.replacement-refs-cannot-turn-a-red: replacement refs cannot turn a red committed owned tree into a clean green submission [V4,V16]', async () => {
  const box = project('test ! -f web/RED');
  assert.equal((await fixtureAdd(box.runIn, box.repo, 'web', 'Exact red tree', '--specs', 'G1')).code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED'), 'committed red');
  const commit = attackCommit(box, box.web);
  box.git(box.web, 'replace', commit, base);
  box.git(box.web, 'reset', '--hard', 'HEAD');
  assert.equal(existsSync(join(box.web, 'web/RED')), false, 'ordinary Git hides the failing committed file');
  const submitted = await box.inProcess(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'DIRTY', 'the underlying tree differs from the files the gate would execute');
});

test('cli.journeys-show-policy-refs.a-detached-coordinator-review-cannot-become: a detached coordinator review cannot become a new claim policy [V4,V16]', async t => {
  const box = project('test ! -f web/RED');
  assert.equal((await fixtureAdd(box.runIn, box.repo, 'web', 'Detached policy', '--specs', 'G1')).code, 0);
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.gate = 'true';
  config.lanes.web.owns.push('pullboard.json');
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  const candidate = attackCommit(box, box.web);
  box.git(box.repo, 'switch', '-q', '--detach', candidate);
  const refused = await box.inProcess(box.web, 'claim', '1', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'NO_POLICY');
  assert.match(JSON.parse(refused.out).error.message, /return to its main branch/);
  box.git(box.repo, 'switch', '-q', 'main');
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  await assertWaitsOnOwner(t, box, 1, await box.inProcess(box.web, 'submit', '1', '--json'), ['pullboard.json']);
});
