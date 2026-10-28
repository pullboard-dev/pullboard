/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, startFixtureChild as spawn, runFixtureChild as spawnSync } from './fixture-child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseSpec } from '../src/spec.js';
import { checkAtCommit } from '../src/runner-private-check.js';
import {
  dependencySnapshots,
  submissionPaths,
} from '../src/trusted-policy.js';
import * as store from '../src/board.js';

import { createE2eHelpers } from './e2e-helpers.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, historicalCheckSubmission, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('the blind gate-bypass repro refuses submit and accept, and doctor audits pre-merge policy [V4,V16,L3,M3]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Append notes', '--specs', 'G1', '--criterion', 'append one note', '--check', 'test ! -f web/RED_CHECK').code, 0);
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
  assert.equal(JSON.parse(submitted.out).error.code, 'OUTSIDE_LANE');
  assert.equal(JSON.parse(submitted.out).error.message.includes('pullboard.json'), true);
  assert.equal(box.run(box.web, 'check', '1').code, 1, 'the original item check stays red');

  // Model a historical unchecked receipt using the low-level engine in this private fixture.
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), policyCommit: original.item_claim_head }); }
  finally { store.closeBoard(board); }
  box.git(box.repo, 'update-ref', 'refs/pullboard/items/1/' + commit.slice(0, 12), commit);
  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  const accepted = box.run(review, 'verify', '1', 'accept', '--note', 'private repro', '--json');
  assert.equal(accepted.code, 1);
  assert.equal(JSON.parse(accepted.out).error.code, 'CHECK_RED');
  assert.equal(JSON.parse(box.run(review, 'show', '1', '--json').out).item_status, 'submitted');

  const history = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
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
  assert.equal(box.run(box.repo, 'add', 'web', 'Frozen gate', '--specs', 'G1', '--criterion', 'original gate passes').code, 0);
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
  assert.equal(box.run(box.repo, 'add', 'web', 'Main merge', '--specs', 'G1', '--criterion', 'foreign main object preserved').code, 0);
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
  assert.equal(box.run(box.repo, 'add', 'web', 'Alter foreign file', '--specs', 'G1', '--criterion', 'ownership remains enforced').code, 0);
  assert.equal(box.run(box.web, 'claim', '2').code, 0);
  writeFileSync(join(box.web, 'coordinator.txt'), 'unauthorized replacement');
  attackCommit(box, box.web);
  const refused = box.run(box.web, 'submit', '2', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE');
});

test('foreign changes before claiming and cross-lane renames cannot hide from submit [L3,V4]', () => {
  for (const mode of ['before-claim', 'rename', 'delete']) {
    const box = project('true');
    writeFileSync(join(box.repo, 'foreign file.txt'), 'coordinator-owned');
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: foreign fixture');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    assert.equal(box.run(box.repo, 'add', 'web', mode, '--specs', 'G1').code, 0);
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
    const refused = box.run(box.web, 'submit', '1', '--json');
    assert.equal(refused.code, 1, mode);
    assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE', mode);
    assert.equal(JSON.parse(refused.out).error.message.includes('foreign file.txt'), true, mode);
  }
});

test('accept reruns the frozen check at the submission even when the reviewer repaired its HEAD [V4,M3]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Exact check', '--specs', 'G1', '--check', 'test ! -f web/RED_CHECK').code, 0);
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
  assert.equal(box.run(review, 'join', 'api').code, 0);
  box.git(review, 'rm', 'web/RED_CHECK');
  attackCommit(box, review); // Model the adversarial repair without disabling its lane hook.
  assert.equal(box.run(review, 'check', '1', '--yes').code, 0, 'the reviewer HEAD alone is green');
  const refused = box.run(review, 'verify', '1', 'accept', '--note', 'reviewer repair is not submission proof', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'CHECK_RED');
  assert.equal(JSON.parse(box.run(review, 'show', '1', '--json').out).item_status, 'submitted');
});

test('accept independently refuses a historically unchecked foreign submission [L3,M3]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Foreign receipt', '--specs', 'G1', '--check', 'true').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  writeFileSync(join(box.web, 'coordinator.txt'), 'unauthorized');
  const commit = attackCommit(box, box.web);
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') }); }
  finally { store.closeBoard(board); }
  const review = join(box.dir, 'foreign-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  const refused = box.run(review, 'verify', '1', 'accept', '--note', 'a green check cannot authorize this path', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE');
});

test('replacement refs cannot conceal the real submitted foreign paths [L3,V4,M3]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Replacement probe', '--specs', 'G1', '--check', 'true').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  writeFileSync(join(box.web, 'coordinator.txt'), 'underlying unauthorized object');
  const commit = attackCommit(box, box.web);
  box.git(box.web, 'replace', commit, base);
  box.git(box.web, 'reset', '--hard', 'HEAD');
  assert.equal(existsSync(join(box.web, 'coordinator.txt')), false, 'Git normally shows the replacement tree');
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'OUTSIDE_LANE');
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId: 'web-1', commit, tree: 'synthetic unchecked tree' }); }
  finally { store.closeBoard(board); }
  const review = join(box.dir, 'replacement-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  const accepted = box.run(review, 'verify', '1', 'accept', '--note', 'the replacement is not the pinned object', '--json');
  assert.equal(accepted.code, 1);
  assert.equal(JSON.parse(accepted.out).error.code, 'OUTSIDE_LANE');
});

test('replacement refs cannot turn a red committed owned tree into a clean green submission [V4,V16]', () => {
  const box = project('test ! -f web/RED');
  assert.equal(box.run(box.repo, 'add', 'web', 'Exact red tree', '--specs', 'G1').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED'), 'committed red');
  const commit = attackCommit(box, box.web);
  box.git(box.web, 'replace', commit, base);
  box.git(box.web, 'reset', '--hard', 'HEAD');
  assert.equal(existsSync(join(box.web, 'web/RED')), false, 'ordinary Git hides the failing committed file');
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'DIRTY', 'the underlying tree differs from the files the gate would execute');
});

test('a detached coordinator review cannot become a new claim policy [V4,V16]', () => {
  const box = project('test ! -f web/RED');
  assert.equal(box.run(box.repo, 'add', 'web', 'Detached policy', '--specs', 'G1').code, 0);
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.gate = 'true';
  config.lanes.web.owns.push('pullboard.json');
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  const candidate = attackCommit(box, box.web);
  box.git(box.repo, 'switch', '-q', '--detach', candidate);
  const refused = box.run(box.web, 'claim', '1', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'NO_POLICY');
  assert.match(JSON.parse(refused.out).error.message, /return to its main branch/);
  box.git(box.repo, 'switch', '-q', 'main');
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'OUTSIDE_LANE');
});

test("a dependency's own verified dependency admits its files [N16,V4]", () => {
  const box = project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.design = { owns: ['design/'], specs: ['G1'] };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add design fixture lane');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');

  const api = join(box.dir, 'api-1');
  const design = join(box.dir, 'design-1');
  box.git(box.repo, 'worktree', 'add', '-q', api, '-b', 'api/one');
  box.git(box.repo, 'worktree', 'add', '-q', design, '-b', 'design/one');
  assert.equal(box.run(api, 'join', 'api').code, 0);
  assert.equal(box.run(design, 'join', 'design').code, 0);

  let nextId = 1;
  /** Add a fixture item from the coordinator checkout and return its sequential id. */
  const add = (lane, title, after = null) => {
    const args = ['add', lane, title];
    if (after !== null) args.push('--after', String(after));
    const result = box.run(box.repo, ...args);
    assert.equal(result.code, 0, result.err || result.out);
    return nextId++;
  };
  /** Claim, commit, and submit one fixture item through the real CLI lifecycle. */
  const buildAndSubmit = (cwd, lane, id, path, content) => {
    assert.equal(box.run(cwd, 'claim', String(id)).code, 0, `claim #${id}`);
    const spec = lane === 'api' ? 'G2' : 'G1';
    const commit = commitFile(box, cwd, path, content, `feat(${lane}): fixture item [${spec}]`);
    assert.equal(commit.status, 0, commit.stderr || commit.failure || `commit #${id}`);
    const submitted = box.run(cwd, 'submit', String(id), '--json');
    assert.equal(submitted.code, 0, submitted.err || submitted.out);
    return box.git(cwd, 'rev-parse', 'HEAD');
  };
  /** Record a real accepted verdict from the other lane's worktree. */
  const accept = (cwd, id, note) => {
    const result = box.run(cwd, 'verify', String(id), 'accept', '--note', note, '--json');
    assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  };

  const webItem = add('web', 'verified web ancestor');
  const webCommit = buildAndSubmit(box.web, 'web', webItem, 'web/ancestor.txt', 'ancestor bytes\n');
  box.git(api, 'merge', '-q', '--ff-only', 'web/one');
  accept(api, webItem, 'the web ancestor submitted cleanly');

  const apiItem = add('api', 'verified api middle', webItem);
  const apiCommit = buildAndSubmit(api, 'api', apiItem, 'api/middle.txt', 'middle bytes\n');
  box.git(box.web, 'merge', '-q', '--ff-only', 'api/one');
  accept(box.web, apiItem, 'the api middle submitted cleanly');

  const designItem = add('design', 'transitive design target', apiItem);
  assert.equal(box.run(design, 'claim', String(designItem)).code, 0);
  box.git(design, 'merge', '-q', '--ff-only', 'api/one');
  const targetChange = commitFile(box, design, 'design/target.txt', 'target bytes\n', 'feat(design): target fixture [G1]');
  assert.equal(targetChange.status, 0, targetChange.stderr || targetChange.failure || 'target commit');
  const submitted = box.run(design, 'submit', String(designItem), '--json');
  const submitFailure = submitted.out ? JSON.parse(submitted.out).error?.code : submitted.err;
  assert.equal(submitted.code, 0, submitFailure);
  const targetCommit = box.git(design, 'rev-parse', 'HEAD');
  const target = JSON.parse(box.run(design, 'show', String(designItem), '--json').out);
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(webItem), '--json').out).item_commit, webCommit);
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(apiItem), '--json').out).item_commit, apiCommit);

  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const snapshots = dependencySnapshots(board.db, target);
    assert.deepEqual(snapshots.map(snapshot => snapshot.lane), ['api', 'web']);
    assert.deepEqual(dependencySnapshots(board.db, { ...target, item_after: `${apiItem},${apiItem}` }), snapshots,
      'a duplicate dependency is visited only once');
    assert.ok(submissionPaths(box.repo, target, targetCommit, { dependencies: snapshots }).includes('web/ancestor.txt'),
      'the verified dependency chain admits the exact ancestor bytes');

    const unverifiedItem = add('api', 'unverified api middle', webItem);
    const unverifiedCommit = buildAndSubmit(api, 'api', unverifiedItem, 'api/unverified.txt', 'unverified bytes\n');
    assert.equal(JSON.parse(box.run(box.repo, 'show', String(unverifiedItem), '--json').out).item_status, 'submitted');
    const withUnverifiedOnly = { ...target, item_after: String(unverifiedItem) };
    assert.deepEqual(dependencySnapshots(board.db, withUnverifiedOnly), [],
      'an unverified middle item does not expose its verified parent');

    const frozen = JSON.parse(target.item_frozen);
    const isolatedTarget = {
      ...target,
      item_claim_head: targetCommit,
      item_frozen: JSON.stringify({ ...frozen, policy: { ...frozen.policy, commit: targetCommit } }),
    };
    mkdirSync(join(design, 'api'), { recursive: true });
    writeFileSync(join(design, 'api/unverified.txt'), readFileSync(join(api, 'api/unverified.txt')));
    const unverifiedCandidate = attackCommit(box, design);
    assert.ok(unverifiedCommit);
    assert.throws(() => submissionPaths(box.repo, isolatedTarget, unverifiedCandidate, { dependencies: [] }),
      error => error.code === 'OUTSIDE_LANE');

    box.git(design, 'reset', '--hard', '-q', targetCommit);
    writeFileSync(join(design, 'web/ancestor.txt'), 'corrupted ancestor bytes\n');
    const corruptedCandidate = attackCommit(box, design);
    assert.throws(() => submissionPaths(box.repo, isolatedTarget, corruptedCandidate, { dependencies: snapshots }),
      error => error.code === 'OUTSIDE_LANE');

    box.git(design, 'reset', '--hard', '-q', targetCommit);
    writeFileSync(join(design, 'orphan.txt'), 'unrelated foreign bytes\n');
    const unrelatedCandidate = attackCommit(box, design);
    assert.throws(() => submissionPaths(box.repo, isolatedTarget, unrelatedCandidate, { dependencies: snapshots }),
      error => error.code === 'OUTSIDE_LANE');
  } finally {
    store.closeBoard(board);
  }
});
