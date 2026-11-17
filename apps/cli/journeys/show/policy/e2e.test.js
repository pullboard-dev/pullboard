/**
 * End to end on real repos, part one: the blind gate bypass and the shared config edit (L3, V4, V16, M3).
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  attackCommit, LIGHT_BRIEF, project,
} = e2e;

test('cli.journeys-show-policy-e2e.the-blind-gate-bypass-repro-refuses: the blind gate-bypass repro refuses submit and accept, and doctor audits pre-merge policy [V4,V16,L3,M3]', async t => {
  const box = project('true');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Append notes', '--specs', 'G1', '--criterion', 'append one note', '--brief', LIGHT_BRIEF, '--check', 'test ! -f web/RED_CHECK').code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const original = JSON.parse((await box.inProcess(box.web, 'show', '1', '--json')).out);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED_CHECK'), 'red');
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.gate = 'true';
  config.lanes.web.owns.push('pullboard.json');
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  const commit = attackCommit(box, box.web);
  const submitted = await box.inProcess(box.web, 'submit', '1', '--json');
  // A red check is never waived by ownership routing (ownership.test.js): the settled gate is red and the builder keeps the claim.
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.equal((await settleSubmit(t, box, JSON.parse(submitted.out))).gate.green, false);
  assert.equal(JSON.parse((await box.inProcess(box.web, 'show', '1', '--json')).out).item_status, 'claimed');
  assert.equal((await box.inProcess(box.web, 'check', '1')).code, 1, 'the original item check stays red');

  // Model a historical unchecked receipt using the low-level engine in this private fixture.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), policyCommit: original.item_claim_head }); }
  finally { store.closeBoard(board); }
  box.git(box.repo, 'update-ref', 'refs/pullboard/items/1/' + commit.slice(0, 12), commit);
  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(fixtureJoin(box.run, review, 'api').code, 0);
  const accepted = await box.inProcess(review, 'verify', '1', 'accept', '--note', 'private repro', '--json');
  assert.equal(accepted.code, 1);
  assert.equal(JSON.parse(accepted.out).error.code, 'CHECK_RED');
  assert.equal(JSON.parse((await box.inProcess(review, 'show', '1', '--json')).out).item_status, 'submitted');

  const history = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { store.verify(history, 1, { agentId: 'api-1', decision: 'ACCEPT', note: 'synthetic historical unchecked verdict', head: commit, digest: original.item_frozen_digest, policy: 'any' }); }
  finally { store.closeBoard(history); }
  box.git(box.repo, 'merge', '--ff-only', '-q', 'web/one');
  assert.equal((await box.inProcess(box.repo, 'merged', '1', commit)).code, 0);
  const file = join(box.repo, '.git/pullboard/board.sqlite');
  const before = readFileSync(file);
  const doctor = await box.inProcess(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 1);
  const problems = JSON.parse(doctor.out).problems;
  assert.equal(problems.some(problem => problem.code === 'OUTSIDE_LANE' && problem.message.includes('pullboard.json')), true,
    'post-merge HEAD cannot retrospectively authorize the malicious policy edit');
  assert.equal(problems.some(problem => problem.code === 'CHECK_RED'), true);
  assert.deepEqual(readFileSync(file), before, 'doctor keeps the historical evidence unchanged');
});

test('cli.journeys-show-policy-e2e.a-shared-config-edit-cannot-replace: a shared config edit cannot replace the gate frozen from the coordinator [V4,V16]', async t => {
  const box = project('test ! -f web/RED');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.shared.push('pullboard.json');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: share fixture config');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Frozen gate', '--specs', 'G1', '--criterion', 'original gate passes').code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED'), 'red');
  config.gate = 'true';
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): fixture config change [G1]');
  const refused = await box.inProcess(box.web, 'submit', '1', '--json');
  assert.equal(refused.code, 0, refused.out + refused.err);
  assert.equal((await settleSubmit(t, box, JSON.parse(refused.out))).gate.green, false, 'the committed original gate executes even though the candidate says true');
});
