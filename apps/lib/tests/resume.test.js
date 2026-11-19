/** @pullboard-test-loads apps/cli/tests/fixtures/e2e.js */
/**
 * Standalone regression for coordinator resume after a stale verdict is freshly reviewed.
 * Run with PULLBOARD_409_CANDIDATE_ROOT pointing at the source checkout under test.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  watch,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { fixtureAdd } from '../../cli/tests/fixtures/testkit.js';
import { fixtureJoin } from '../../cli/tests/fixtures/testkit.js';

const candidateRoot = process.env.PULLBOARD_409_CANDIDATE_ROOT ?? resolve(import.meta.dirname, '../../..');
assert.ok(candidateRoot, 'set PULLBOARD_409_CANDIDATE_ROOT to the candidate checkout');

const { createE2eHelpers } = await import(pathToFileURL(resolve(candidateRoot, 'apps/cli/tests/fixtures/e2e.js')).href);
const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Commit the fixture's current tree through its real hooks. */
function commit(box, cwd, subject) {
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', subject);
  return box.git(cwd, 'rev-parse', 'HEAD');
}

/** Create one cited row item and claim it from the already joined builder worktree. */
async function addAndClaim(box, title) {
  const brief = 'Files:\n- web/shared.txt\nTest:\n- inspect the reviewed composition\n';
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', title, '--route', 'strong', '--specs', 'G1',
    '--criterion', 'the cited row holds', '--check', 'true', '--brief', brief);
  assert.equal(added.code, 0, added.err || added.out);
  const itemId = Number(/#(\d+)/u.exec(added.out)?.[1]);
  assert.ok(itemId > 0, added.out);
  const claimed = await box.runLocal(box.web, 'claim', String(itemId));
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  return itemId;
}

/** Submit a committed shared-file edit and return its immutable submitted head. */
async function submitShared(box, itemId) {
  writeFileSync(join(box.web, 'web/shared.txt'), 'submitted side\n');
  const submitted = commit(box, box.web, 'feat(web): submit shared change [G1]');
  const result = await box.runLocal(box.web, 'submit', String(itemId));
  assert.equal(result.code, 0, result.err || result.out);
  return submitted;
}

/** Accept the exact submitted commit through the public CLI, then restore the main checkout. */
async function acceptSubmitted(box, itemId, submitted) {
  box.git(box.repo, 'switch', '-q', '--detach', submitted);
  // Under pull the gate settles on the runner, so verify first fails NOT_SUBMITTED; retry on each change in the local runner's folder
  // (a log line per claim and receipt, a heartbeat every 5 s) until the board has applied the receipt [C7,#7283].
  const deadline = Date.now() + 110_000;
  let accepted;
  for (;;) {
    accepted = await box.runLocal(box.repo, 'verify', String(itemId), 'accept', '--as', 'coordinator',
      '--note', 'The submitted change passed its frozen check.');
    if (accepted.code === 0 || !/NOT_SUBMITTED/u.test(accepted.err ?? '') || Date.now() > deadline) break;
    await new Promise(resolve => {
      const watcher = watch(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner'), () => { watcher.close(); resolve(); });
      setTimeout(() => { watcher.close(); resolve(); }, 6000).unref();
    });
  }
  assert.equal(accepted.code, 0, accepted.err || accepted.out);
  box.git(box.repo, 'switch', '-q', 'main');
}

test('lib.resume.coordinator-resume-guides-and-groups-the-checked: coordinator resume guides and groups the checked composition after stale re-review [E8,N19]',
  { timeout: 120_000 }, async () => { // budget: hang ceiling for private Git worktrees and public CLI checks; not a speed target.
    const box = helpers.project();
    box.env.LC_ALL = 'C';
    mkdirSync(join(box.repo, 'web'), { recursive: true });
    writeFileSync(join(box.repo, 'web/shared.txt'), 'base\n');
    commit(box, box.repo, 'chore(web): create shared-file base [G1]');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');

    const itemId = await addAndClaim(box, 'Fresh composition');
    const submitted = await submitShared(box, itemId);
    await acceptSubmitted(box, itemId, submitted);

    writeFileSync(join(box.repo, 'web/shared.txt'), 'main side\n');
    commit(box, box.repo, 'feat(web): update the same line on main [G1]');

    const reviewer = join(box.dir, 'composition-reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
    const joined = await fixtureJoin(box.runLocal, reviewer, 'web', '--route', 'strong');
    assert.equal(joined.code, 0, joined.err || joined.out);

    const conflict = box.tryGit(reviewer, 'merge', '-q', '--no-edit', 'main');
    assert.notEqual(conflict.status, 0, 'the original submitted commit must conflict with the same-line main change');
    assert.match(`${conflict.stdout ?? ''}${conflict.stderr ?? ''}`, /CONFLICT \(content\): Merge conflict in web\/shared\.txt/u,
      'the failure must be the intended content conflict');
    writeFileSync(join(reviewer, 'web/shared.txt'), 'resolved composition\n');
    const checked = commit(box, reviewer, 'fix(web): resolve against current main [G1]');

    assert.notEqual(checked, submitted, 'the resolution is a separate checked composition');
    assert.equal(box.tryGit(reviewer, 'merge-base', '--is-ancestor', 'main', checked).status, 0, 'the checked resolution contains current main');
    const reReview = await box.runLocal(reviewer, 'verify', String(itemId), 'accept', '--note',
      'The exact resolution against current main passed the frozen check.');
    assert.equal(reReview.code, 0, reReview.err || reReview.out);

    // Complete the real first-run view step; no forged receipt can mask the guidance under test.
    const view = await helpers.startView(box, box.repo);
    await view.stop();

    const resumed = await box.runLocal(box.repo, 'resume', '--diagnostics', '--json');
    assert.equal(resumed.code, 0, resumed.err || resumed.out);
    const document = JSON.parse(resumed.out);
    assert.equal(document.setup, null, 'the actual view bind completed setup before merge guidance is judged');
    assert.match(document.next, new RegExp('git merge --no-edit ' + checked.slice(0, 12)), 'resume names the freshly accepted checked resolution');
    assert.equal(document.toMerge.find(item => item.item_id === itemId)?.item_commit, submitted, 'the original submitted identity remains immutable');
    const cleanIds = document.verifiedNotMerged.clean.map(item => item.item_id);
    const conflictIds = document.verifiedNotMerged.conflicts.map(entry => entry.item.item_id);
    const item = document.all.find(entry => entry.item_id === itemId);
    assert.deepEqual({
      stillStale: Boolean(item?.item_verdict_state),
      groupedClean: cleanIds.includes(itemId),
      groupedConflict: conflictIds.includes(itemId),
    }, {
      stillStale: false,
      groupedClean: true,
      groupedConflict: false,
    }, 'resume must group the latest checked composition after fresh re-review');
    box.git(box.repo, 'merge', '--no-edit', checked);
    assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', checked, 'HEAD').status, 0, 'the exact indicated resolution actually merges onto current main');
  });

