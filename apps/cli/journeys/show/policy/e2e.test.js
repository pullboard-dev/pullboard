/**
 * End to end on real repos, part one: the blind gate bypass, shared config, accepted-main merges and
 * foreign changes (L3, V4, V16, M3).
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
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, attackCommit, historicalCheckSubmission, LIGHT_BRIEF,
} = e2e;

/**
 * Assert a green submit routed only foreign paths to their owner: the builder is freed and nothing is submitted (B3,L1,V4).
 *
 * Why: the ownership routing (814a7def2a) replaced the immediate OUTSIDE_LANE refusal for proved foreign paths; the owner decides.
 */
function assertWaitsOnOwner(box, id, submitted, paths, label = '') {
  assert.equal(submitted.code, 0, `${label} ${submitted.out}${submitted.err}`);
  const waiting = JSON.parse(submitted.out).waitingOwner;
  assert.deepEqual(waiting.owners, ['coordinator'], label);
  for (const path of paths) assert.equal(waiting.paths.includes(path), true, `${label} ${path}`);
  const item = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
  assert.equal(item.item_status, 'open', label);
  assert.equal(item.item_commit, null, `${label}: owner waiting is not a submission`);
  assert.match(item.item_hold_reason, /^waiting on ownership /u, label);
}


test('the blind gate-bypass repro refuses submit and accept, and doctor audits pre-merge policy [V4,V16,L3,M3]', () => {
  const box = project('true');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Append notes', '--specs', 'G1', '--criterion', 'append one note', '--brief', LIGHT_BRIEF, '--check', 'test ! -f web/RED_CHECK').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const original = JSON.parse(box.run(box.web, 'show', '1', '--json').out);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED_CHECK'), 'red');
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.gate = 'true';
  config.lanes.web.owns.push('pullboard.json');
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  const commit = attackCommit(box, box.web);
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  // A red check is never waived by ownership routing (ownership.test.js): the red gate refuses and the builder keeps the claim.
  assert.equal(JSON.parse(submitted.out).error.code, 'GATE_RED');
  assert.equal(JSON.parse(box.run(box.web, 'show', '1', '--json').out).item_status, 'claimed');
  assert.equal(box.run(box.web, 'check', '1').code, 1, 'the original item check stays red');

  // Model a historical unchecked receipt using the low-level engine in this private fixture.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), policyCommit: original.item_claim_head }); }
  finally { store.closeBoard(board); }
  box.git(box.repo, 'update-ref', 'refs/pullboard/items/1/' + commit.slice(0, 12), commit);
  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(fixtureJoin(box.run, review, 'api').code, 0);
  const accepted = box.run(review, 'verify', '1', 'accept', '--note', 'private repro', '--json');
  assert.equal(accepted.code, 1);
  assert.equal(JSON.parse(accepted.out).error.code, 'CHECK_RED');
  assert.equal(JSON.parse(box.run(review, 'show', '1', '--json').out).item_status, 'submitted');

  const history = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { store.verify(history, 1, { agentId: 'api-1', decision: 'ACCEPT', note: 'synthetic historical unchecked verdict', head: commit, digest: original.item_frozen_digest, policy: 'any' }); }
  finally { store.closeBoard(history); }
  box.git(box.repo, 'merge', '--ff-only', '-q', 'web/one');
  assert.equal(box.run(box.repo, 'merged', '1', commit).code, 0);
  const file = join(box.repo, '.git/pullboard/board.sqlite');
  const before = readFileSync(file);
  const doctor = box.run(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 1);
  const problems = JSON.parse(doctor.out).problems;
  assert.equal(problems.some(problem => problem.code === 'OUTSIDE_LANE' && problem.message.includes('pullboard.json')), true,
    'post-merge HEAD cannot retrospectively authorize the malicious policy edit');
  assert.equal(problems.some(problem => problem.code === 'CHECK_RED'), true);
  assert.deepEqual(readFileSync(file), before, 'doctor keeps the historical evidence unchanged');
});

test('a shared config edit cannot replace the gate frozen from the coordinator [V4,V16]', () => {
  const box = project('test ! -f web/RED');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.shared.push('pullboard.json');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: share fixture config');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Frozen gate', '--specs', 'G1', '--criterion', 'original gate passes').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED'), 'red');
  config.gate = 'true';
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): fixture config change [G1]');
  const refused = box.run(box.web, 'submit', '1', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'GATE_RED', 'the committed original gate executes even though the candidate says true');
});

test('accepted-main merges carry foreign files without granting permission to alter them [L3,V4]', () => {
  const box = project('true');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Main merge', '--specs', 'G1', '--criterion', 'foreign main object preserved').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  writeFileSync(join(box.repo, 'coordinator.txt'), 'accepted main fixture');
  box.git(box.repo, 'add', 'coordinator.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: coordinator fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'app fixture');
  box.git(box.web, 'add', 'web/index.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): preserve main fixture [G1]');
  assert.equal(box.run(box.web, 'submit', '1').code, 0, 'unchanged accepted-main foreign objects are allowed');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  assert.equal(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'private accepted-main fixture').code, 0);
  assert.equal(box.run(box.repo, 'doctor').code, 0, 'the pre-merge main proof remains available for historical audit');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Alter foreign file', '--specs', 'G1', '--criterion', 'ownership remains enforced').code, 0);
  assert.equal(box.run(box.web, 'claim', '2').code, 0);
  writeFileSync(join(box.web, 'coordinator.txt'), 'unauthorized replacement');
  attackCommit(box, box.web);
  assertWaitsOnOwner(box, 2, box.run(box.web, 'submit', '2', '--json'), ['coordinator.txt']);
});

test('foreign changes before claiming and cross-lane renames cannot hide from submit [L3,V4]', () => {
  for (const mode of ['before-claim', 'rename', 'delete']) {
    const box = project('true');
    writeFileSync(join(box.repo, 'foreign file.txt'), 'coordinator-owned');
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: foreign fixture');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    assert.equal(fixtureAdd(box.run, box.repo, 'web', mode, '--specs', 'G1').code, 0);
    if (mode === 'before-claim') {
      writeFileSync(join(box.web, 'foreign file.txt'), 'unauthorized pre-claim replacement');
      attackCommit(box, box.web);
    }
    assert.equal(box.run(box.web, 'claim', '1').code, 0);
    mkdirSync(join(box.web, 'web'));
    if (mode === 'rename') box.git(box.web, 'mv', 'foreign file.txt', 'web/moved.txt');
    else if (mode === 'delete') box.git(box.web, 'rm', 'foreign file.txt');
    writeFileSync(join(box.web, 'web/index.html'), 'owned');
    attackCommit(box, box.web);
    assertWaitsOnOwner(box, 1, box.run(box.web, 'submit', '1', '--json'), ['foreign file.txt'], mode);
  }
});

test('accept reruns the frozen check at the submission even when the reviewer repaired its HEAD [V4,M3]', () => {
  const box = project('true');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Exact check', '--specs', 'G1', '--criterion', 'the original check passes', '--brief', LIGHT_BRIEF, '--check', 'test ! -f web/RED_CHECK').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED_CHECK'), 'red');
  const commit = attackCommit(box, box.web);
  const blocked = box.run(box.web, 'submit', '1');
  assert.equal(blocked.code, 1, 'current submit refuses the red frozen check even when the project gate passes');
  assert.match(blocked.err, /GATE_RED/);
  historicalCheckSubmission(box, commit); // Legacy receipts must still be independently checked.
  const review = join(box.dir, 'exact-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(fixtureJoin(box.run, review, 'api').code, 0);
  box.git(review, 'rm', 'web/RED_CHECK');
  attackCommit(box, review); // Model the adversarial repair without disabling its lane hook.
  assert.equal(box.run(review, 'check', '1', '--yes').code, 0, 'the reviewer HEAD alone is green');
  const refused = box.run(review, 'verify', '1', 'accept', '--note', 'reviewer repair is not submission proof', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'CHECK_RED');
  assert.equal(JSON.parse(box.run(review, 'show', '1', '--json').out).item_status, 'submitted');
});
