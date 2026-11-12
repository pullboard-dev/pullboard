/**
 * End to end on real repos, part three: a dependency's own verified dependency admits its files (N16, V4).
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
import {
  dependencySnapshots,
  submissionPaths,
} from '../../../../../packages/sandbox/index.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

// Claim and submit stay processes: in-process, a later board write by another identity runs the lapsed-claim sweep, which
// returns an api claim that waits on a submitted but unlanded dependency, so submit refuses NOT_YOURS (#6003).
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, commitFile, attackCommit,
} = e2e;

test("a dependency's own verified dependency admits its files [N16,V4]", async () => {
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
  assert.equal((await fixtureJoin(box.runLocal, api, 'api')).code, 0);
  assert.equal((await fixtureJoin(box.runLocal, design, 'design')).code, 0);

  let nextId = 1;
  /** Add a fixture item from the coordinator checkout and return its sequential id. */
  const add = async (lane, title, after = null) => {
    const args = ['add', lane, title];
    if (after !== null) args.push('--after', String(after));
    const result = await box.runLocal(box.repo, ...args);
    assert.equal(result.code, 0, result.err || result.out);
    return nextId++;
  };
  /** Claim, commit, and submit one fixture item through the real CLI lifecycle. */
  const buildAndSubmit = async (cwd, lane, id, path, content) => {
    assert.equal(box.run(cwd, 'claim', String(id)).code, 0, `claim #${id}`);
    const spec = lane === 'api' ? 'G2' : 'G1';
    const commit = commitFile(box, cwd, path, content, `feat(${lane}): fixture item [${spec}]`);
    assert.equal(commit.status, 0, commit.stderr || commit.failure || `commit #${id}`);
    const submitted = box.run(cwd, 'submit', String(id), '--json');
    assert.equal(submitted.code, 0, submitted.err || submitted.out);
    return box.git(cwd, 'rev-parse', 'HEAD');
  };
  /** Record a real accepted verdict from the other lane's worktree. */
  const accept = async (cwd, id, note) => {
    const result = await box.runLocal(cwd, 'verify', String(id), 'accept', '--note', note, '--json');
    assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  };

  const webItem = await add('web', 'verified web ancestor');
  const webCommit = await buildAndSubmit(box.web, 'web', webItem, 'web/ancestor.txt', 'ancestor bytes\n');
  box.git(api, 'merge', '-q', '--ff-only', 'web/one');
  await accept(api, webItem, 'the web ancestor submitted cleanly');

  const apiItem = await add('api', 'verified api middle', webItem);
  const apiCommit = await buildAndSubmit(api, 'api', apiItem, 'api/middle.txt', 'middle bytes\n');
  box.git(box.web, 'merge', '-q', '--ff-only', 'api/one');
  await accept(box.web, apiItem, 'the api middle submitted cleanly');

  const designItem = await add('design', 'transitive design target', apiItem);
  assert.equal(box.run(design, 'claim', String(designItem)).code, 0);
  box.git(design, 'merge', '-q', '--ff-only', 'api/one');
  const targetChange = commitFile(box, design, 'design/target.txt', 'target bytes\n', 'feat(design): target fixture [G1]');
  assert.equal(targetChange.status, 0, targetChange.stderr || targetChange.failure || 'target commit');
  const submitted = box.run(design, 'submit', String(designItem), '--json');
  const submitFailure = submitted.out ? JSON.parse(submitted.out).error?.code : submitted.err;
  assert.equal(submitted.code, 0, submitFailure);
  const targetCommit = box.git(design, 'rev-parse', 'HEAD');
  const target = JSON.parse((await box.runLocal(design, 'show', String(designItem), '--json')).out);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(webItem), '--json')).out).item_commit, webCommit);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(apiItem), '--json')).out).item_commit, apiCommit);

  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const snapshots = dependencySnapshots(board.db, target);
    assert.deepEqual(snapshots.map(snapshot => snapshot.lane), ['api', 'web']);
    assert.deepEqual(dependencySnapshots(board.db, { ...target, item_after: `${apiItem},${apiItem}` }), snapshots,
      'a duplicate dependency is visited only once');
    assert.ok(submissionPaths(box.repo, target, targetCommit, { dependencies: snapshots }).includes('web/ancestor.txt'),
      'the verified dependency chain admits the exact ancestor bytes');

    const unverifiedItem = await add('api', 'unverified api middle', webItem);
    const unverifiedCommit = await buildAndSubmit(api, 'api', unverifiedItem, 'api/unverified.txt', 'unverified bytes\n');
    assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(unverifiedItem), '--json')).out).item_status, 'submitted');
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
