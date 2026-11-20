/** Branch-name-independent check baselines and lane merge ownership [B34,P2,L3]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  describe,
  test,
} from 'node:test';
import {
  mainPolicy,
  requireTrunkMerge,
} from '../../../../packages/sandbox/index.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
let machineHome = null;
const SPEC = '# Trunk fixture\n\n## G · Goals\n- G1 [approved, must] The fixture works. | gate: true\n';

/**
 * Build an offline CLI fixture with private Git identity and machine settings. Every CLI call goes through runIn: in this process
 * by default, a real process under PULLBOARD_JOURNEY_MODE=process, which the gate's parity check compares (#8266). No case here
 * tests argv, a child's exit code, hooks or child cleanup, so none keeps its own process.
 */
function sandbox() {
  const box = e2e.sandbox();
  // One machine home, so one loopback runner serves every case's repository instead of one runner process per case [C7].
  if (machineHome) box.env.PULLBOARD_MACHINE_HOME = machineHome; else machineHome = box.env.PULLBOARD_MACHINE_HOME;
  // The V6 cases prove the compose the submit command runs itself, which runs only with submit.composeOnRunner off since it became the default (#11423).
  const settings = join(machineHome, 'settings.json');
  let current = {};
  try { current = JSON.parse(readFileSync(settings, 'utf8')); } catch { /* no machine settings yet */ }
  mkdirSync(machineHome, { recursive: true });
  writeFileSync(settings, JSON.stringify({ ...current, submit: { ...current.submit, composeOnRunner: false } }));
  // A submit or accept returns at once: each case waits for its own gate or land receipt with an awaited helper, so the cases run side by side [C7].
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  return { dir: box.dir, env: box.env, git: (cwd, ...args) => box.git(cwd, ...args), go: box.runIn };
}

/** Initialize a committed repo whose primary branch has the supplied name. */
async function project(branch) {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal((await box.go(repo, 'init')).code, 0);
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.gate = 'true';
  config.lanes = { web: { owns: ['web/'], specs: ['G1'] }, review: { owns: [] } };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'result.txt'), 'ready\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize trunk fixture');
  if (branch !== 'main') box.git(repo, 'branch', '-m', branch);
  return { ...box, repo };
}

describe('branch-independent trunk and lane merge cases [B34,P2,L3,V6]', { concurrency: true }, () => {
  for (const branch of ['master', 'trunk']) {
    test(`[B34,P2] add --check captures the ${branch} baseline without a remote`, async () => {
      const box = await project(branch);
      const head = box.git(box.repo, 'rev-parse', 'HEAD');
      assert.equal(mainPolicy(box.repo).commit, head, 'trusted policy resolves the primary checkout rather than a fixed branch name');
      const added = await fixtureAdd(box.go, box.repo, 'web', `baseline on ${branch}`, '--specs', 'G1', '--criterion', 'a real check baseline is recorded', '--check', 'node -e "process.exit(1)"', '--wait', '--json');
      assert.equal(added.code, 0, `${added.out}${added.err}`);
      const item = JSON.parse(added.out).item;
      assert.equal(item.item_check_baseline.main, head, `${branch} baseline points at the primary checkout commit`);
      // Under pull a runner (here the fixture's local one) settles the baseline during `add --wait`, so a failing check is recorded red, not pending [C7].
      assert.equal(item.item_check_baseline.result, 'red', `${branch} baseline settled by a runner instead of being unavailable: ${JSON.stringify(item.item_check_baseline)}`);
      assert.notEqual(item.item_check_baseline.reason, 'no main');
    });
  }

  for (const branch of ['master', 'trunk']) {
    test(`[B34,P2,L3] a lane can resolve an owned conflict while retaining ${branch} files`, async () => {
      const box = await project(branch);
      const web = join(box.dir, 'web-worktree');
      box.git(box.repo, 'worktree', 'add', '-q', web, '-b', 'web/agent');
      assert.equal((await fixtureJoin(box.go, web, 'web', '--model', FIXTURE_MODEL)).code, 0);
      writeFileSync(join(web, 'web', 'result.txt'), `resolved by web lane from ${branch}\n`);
      box.git(web, 'add', 'web/result.txt');
      box.git(web, 'commit', '-q', '-m', 'feat(web): update owned fixture [G1]');
      writeFileSync(join(box.repo, 'web', 'result.txt'), `updated by ${branch}\n`);
      writeFileSync(join(box.repo, 'coordinator.txt'), `owned by ${branch}\n`);
      box.git(box.repo, 'add', 'web/result.txt', 'coordinator.txt');
      box.git(box.repo, 'commit', '-q', '-m', 'chore: update trunk fixture');
      const trunkHead = box.git(box.repo, 'rev-parse', 'HEAD');
      const merged = runFixtureChild('git', ['merge', '--no-ff', '--no-commit', branch], {
        cwd: web, env: box.env, encoding: 'utf8',
      });
      assert.equal(merged.status, 1, `${merged.stdout}${merged.stderr}`);
      assert.equal(box.git(web, 'rev-parse', 'MERGE_HEAD'), trunkHead, 'the merge is against the primary checkout tip');
      assert.ok(box.git(web, 'status', '--porcelain').includes('UU web/result.txt'), 'the primary and lane edits conflict on an owned file');
      writeFileSync(join(web, 'web', 'result.txt'), `resolved by web lane from ${branch}\n`);
      box.git(web, 'add', 'web/result.txt');

      const committed = runFixtureChild('git', ['commit', '-m', `Merge ${branch} into web/agent`], {
        cwd: web, env: box.env, encoding: 'utf8',
      });
      assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
      assert.equal(box.git(web, 'show', 'HEAD:web/result.txt'), `resolved by web lane from ${branch}`);
      assert.equal(box.git(web, 'show', 'HEAD:coordinator.txt'), `owned by ${branch}`);
      assert.equal(box.git(web, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'the lane committed a two-parent merge');
    });
  }

  test('[B34,P2] add --check reports an unavailable baseline for a detached coordinator', async () => {
    const box = await project('master');
    box.git(box.repo, 'checkout', '--detach', '-q', 'HEAD');
    const added = await fixtureAdd(box.go, box.repo, 'web', 'detached baseline', '--specs', 'G1', '--criterion', 'detached baseline is unavailable', '--check', 'true', '--json');
    assert.equal(added.code, 0, `${added.out}${added.err}`);
    const item = JSON.parse(added.out).item;
    assert.deepEqual(item.item_check_baseline, {
      command: 'true', main: null, result: 'unavailable', reason: 'coordinator checkout is detached',
    });
  });

  /** Claim and commit one real lane item while the primary branch remains separate. */
  async function mergeCandidate(branch = 'trunk') {
    const box = await project(branch);
    const web = join(box.dir, 'merge-web');
    box.git(box.repo, 'worktree', 'add', '-q', web, '-b', 'web/merge-candidate');
    assert.equal((await fixtureJoin(box.go, web, 'web', '--family', 'builder-fixture', '--model', FIXTURE_MODEL, '--route', 'strong')).code, 0);
    const added = await fixtureAdd(box.go, box.repo, 'web', 'Merge candidate', '--specs', 'G1', '--criterion', 'merges without touching a checkout', '--json');
    assert.equal(added.code, 0, added.err);
    const id = JSON.parse(added.out).item.item_id;
    { const claimed = await box.go(web, 'claim', String(id)); assert.equal(claimed.code, 0, `${claimed.out}${claimed.err}`); }
    writeFileSync(join(web, 'web/result.txt'), 'builder result\n');
    box.git(web, 'add', 'web/result.txt');
    box.git(web, 'commit', '-q', '-m', 'feat(web): build merge candidate [G1]');
    return { ...box, web, id };
  }

  /** Submit the item's builder and wait for the pulled gate to settle: submit returns once the gate job is queued [C7]. */
  async function submitSettled(box) {
    const submitted = await box.go(box.web, 'submit', String(box.id));
    assert.equal(submitted.code, 0, submitted.err);
    await settledGateJob({ ...box, run: box.go }, box.id);
    return submitted;
  }

  /** Capture the bytes and state a speculative merge must leave alone. */
  function checkoutState(box, cwd) {
    return {
      head: box.git(cwd, 'rev-parse', 'HEAD'),
      index: readFileSync(resolve(cwd, box.git(cwd, 'rev-parse', '--git-path', 'index'))).toString('base64'),
      status: box.git(cwd, 'status', '--porcelain'),
      staged: box.git(cwd, 'diff', '--cached', '--binary'),
      work: box.git(cwd, 'diff', '--binary'),
      result: readFileSync(join(cwd, 'web/result.txt'), 'utf8'),
    };
  }

  /** Move only the fixture's primary branch, optionally making an actual content conflict. */
  function advanceMergeTrunk(box, conflict) {
    const file = conflict ? 'result.txt' : 'trunk.txt';
    writeFileSync(join(box.repo, 'web', file), 'trunk result\n');
    box.git(box.repo, 'add', 'web/' + file);
    box.git(box.repo, 'commit', '-q', '-m', 'feat(web): advance fixture trunk [G1]');
  }

  /** A different fixture agent reviews the submitted commit, never a shared-board item. */
  async function mergeReviewer(box, commit = box.git(box.web, 'rev-parse', 'HEAD')) {
    const review = join(box.dir, 'merge-review');
    box.git(box.repo, 'worktree', 'add', '-q', review, '-b', 'review/merge-candidate', commit);
    assert.equal((await fixtureJoin(box.go, review, 'review', '--family', 'reviewer-fixture', '--model', FIXTURE_MODEL, '--route', 'strong')).code, 0);
    return review;
  }

  test('[B34,V6] clean divergent submit and accept preserve every checkout and index', async () => {
    const box = await mergeCandidate('master');
    advanceMergeTrunk(box, false);
    const before = [checkoutState(box, box.repo), checkoutState(box, box.web)];
    const trunk = box.git(box.repo, 'rev-parse', 'HEAD');
    const submitted = await submitSettled(box);
    // Submit composes clean main as a merge commit that exists only as objects (#2966): no checkout, index or HEAD moves.
    assert.deepEqual(checkoutState(box, box.repo), before[0]);
    const composed = checkoutState(box, box.web);
    assert.equal(composed.head, before[1].head, 'the builder checkout head stays on the builder source');
    const [, composedCommit] = /into the builder source as ([0-9a-f]{12,40})/.exec(`${submitted.out}${submitted.err}`) ?? [];
    assert.ok(composedCommit, `submit names the composed commit: ${submitted.out}${submitted.err}`);
    assert.deepEqual(box.git(box.web, 'show', '-s', '--format=%P', composedCommit).split(' '), [before[1].head, trunk], 'the composed commit merges the builder source with the exact trunk tip');
    assert.deepEqual({ status: composed.status, staged: composed.staged, work: composed.work, result: composed.result },
      { status: before[1].status, staged: before[1].staged, work: before[1].work, result: before[1].result }, 'the composed builder checkout is clean and keeps its content');
    const after = [checkoutState(box, box.repo), composed];
    // The reviewer sits on the composed commit that was submitted, which is what accept verifies; the builder HEAD is not that commit (#2966).
    const review = await mergeReviewer(box, composedCommit);
    const reviewBefore = checkoutState(box, review);
    const accepted = await box.go(review, 'verify', String(box.id), 'accept', '--note', 'Tried divergent trunk changes; merge and checkout bytes are checked by this fixture.');
    assert.equal(accepted.code, 0, accepted.err);
    assert.deepEqual(checkoutState(box, review), reviewBefore);
    assert.deepEqual(checkoutState(box, box.web), after[1], 'accept leaves the builder checkout and index as submitted');
    // Accept only offers a land job under pull; the runner's landing is what advances trunk, so wait for its receipt [C7].
    await settleLand(box, { messages: [accepted.out, accepted.err] });
    // Accept lands the verified source on trunk, so the primary checkout advances cleanly to contain it.
    const landed = checkoutState(box, box.repo);
    assert.equal(box.git(box.repo, 'merge-base', after[1].head, landed.head), after[1].head, 'the primary head contains the verified builder head');
    assert.deepEqual({ status: landed.status, staged: landed.staged, work: landed.work, result: landed.result },
      { status: '', staged: '', work: '', result: after[1].result }, 'the primary checkout is clean and carries the landed content');
  });

  test('[B34,V6] conflicting submit names files and refuses without changing any checkout or index', async () => {
    const box = await mergeCandidate();
    advanceMergeTrunk(box, true);
    const before = [checkoutState(box, box.repo), checkoutState(box, box.web)];
    const refused = await box.go(box.web, 'submit', String(box.id));
    assert.notEqual(refused.code, 0, refused.out + refused.err);
    assert.match(refused.err, /MERGE_CONFLICT/);
    assert.match(refused.err, /web\/result\.txt/);
    assert.match(refused.err, /merge main into your branch.*run the command again/);
    assert.deepEqual([checkoutState(box, box.repo), checkoutState(box, box.web)], before);
    const shown = await box.go(box.web, 'show', String(box.id), '--json');
    assert.equal(JSON.parse(shown.out).item_status, 'claimed', 'refusal leaves the claim available for a resolved new commit');
  });

  test('[B34,V6] accept rechecks the moved trunk and refuses with indexes and checkouts intact', async () => {
    const box = await mergeCandidate();
    await submitSettled(box);
    const review = await mergeReviewer(box);
    advanceMergeTrunk(box, true);
    const before = [box.repo, box.web, review].map(cwd => checkoutState(box, cwd));
    const refused = await box.go(review, 'verify', String(box.id), 'accept', '--note', 'Tried divergent trunk changes; merge and checkout bytes are checked by this fixture.');
    assert.notEqual(refused.code, 0, refused.out + refused.err);
    assert.match(refused.err, /MERGE_CONFLICT/);
    assert.match(refused.err, /web\/result\.txt/);
    assert.match(refused.err, /merge the trunk into your branch.*resubmit/);
    assert.deepEqual([box.repo, box.web, review].map(cwd => checkoutState(box, cwd)), before);
    const shown = await box.go(box.web, 'show', String(box.id), '--json');
    assert.equal(JSON.parse(shown.out).item_status, 'submitted', 'conflict cannot produce an accept receipt');
  });

  test('[B34,V6] a detached coordinator accept checks the retained non-main trunk tip', async () => {
    const box = await mergeCandidate('master');
    await submitSettled(box);
    advanceMergeTrunk(box, true);
    box.git(box.repo, 'switch', '-q', '--detach', box.git(box.web, 'rev-parse', 'HEAD'));
    const before = checkoutState(box, box.repo);
    const refused = await box.go(box.repo, 'verify', String(box.id), 'accept', '--as', 'coordinator', '--note', 'Fixture checks retained branch conflicts.');
    assert.match(refused.err, /MERGE_CONFLICT/);
    assert.match(refused.err, /master/);
    assert.match(refused.err, /web\/result\.txt/);
    assert.deepEqual(checkoutState(box, box.repo), before);
  });

  test('[B34,V6] an unrecorded detached trunk refuses with NO_TRUNK and its repair', async () => {
    const box = await project('trunk');
    const commit = box.git(box.repo, 'rev-parse', 'HEAD');
    const clone = join(box.dir, 'unrecorded-clone');
    box.git(box.repo, 'clone', '-q', box.repo, clone);
    box.git(clone, 'switch', '-q', '--detach', commit);
    const before = checkoutState(box, clone);
    assert.throws(() => requireTrunkMerge(clone, commit), error => error.code === 'NO_TRUNK' && /check out the trunk branch in the main checkout once/.test(error.message));
    assert.deepEqual(checkoutState(box, clone), before);
  });
});
