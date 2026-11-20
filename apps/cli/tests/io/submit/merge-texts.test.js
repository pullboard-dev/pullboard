/** Resume, verify and ship stop asking a builder to merge main: only a Git conflict does [C7,U159]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { pullProject } from '../../fixtures/pull.js';
import { workHelp } from '../../../src/logic/help/work.js';
import { shipMain } from '../../../src/io/commands/ship.js';
import { trunkMovedAgainText } from '../../../src/io/commands/verify.js';
import { trunkMovedOverlapText } from '../../../src/io/commands/verify.js';

/** A claimed item with one commit of its own while main has moved on, so its branch is 1 ahead and 1 behind. */
async function behindMain(t) {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal((await box.helpers.commitFile(box, folder, `web/${id}.txt`, `merge-texts ${id}\n`, `feat(web): merge texts ${id} [G1]`)).status, 0);
  assert.equal((await box.helpers.commitFile(box, box.repo, 'web/newer-main.txt', 'newer\n', 'feat(web): main moved on [G1]')).status, 0);
  return { box, folder };
}

/** Set submit.composeAsObject as `on` says; every command after this reads it. */
function setComposeAsObject(box, on) {
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'pull' }, ...(on ? { submit: { composeAsObject: true } } : {}) });
}

test('cli.journeys-submit-merge-texts.resume-behind-main-either-setting: clause 1: pullboard resume on a branch behind main prints ahead and behind without asking for a merge, with submit.composeAsObject on or off [C7,U159]', async t => {
  const { box, folder } = await behindMain(t);
  for (const on of [true, false]) {
    setComposeAsObject(box, on);
    const resumed = await box.runLocal(folder, 'resume');
    assert.equal(resumed.code, 0, resumed.err);
    assert.match(resumed.out, /1 ahead of main, 1 behind/u, `setting ${on}`);
    assert.doesNotMatch(resumed.out, /merge main before you submit/u, `setting ${on}`);
  }
});

test('cli.journeys-submit-merge-texts.trunk-moved-asks-for-a-re-review: clause 1: the VERDICT_TRUNK_MOVED refusals ask for a re-review against current main and never tell the builder to merge main [C7,U159]', () => {
  const texts = [trunkMovedOverlapText(['web/a.txt', 'web/b.txt']), trunkMovedAgainText('1'.repeat(12), '2'.repeat(12), []), trunkMovedAgainText('1'.repeat(12), '2'.repeat(12), ['web/a.txt'])];
  for (const text of texts) {
    assert.match(text, /re-review against current main/u);
    assert.doesNotMatch(text, /merge (the latest|current)? ?main/u);
  }
  assert.match(texts[0], /"web\/a\.txt", "web\/b\.txt"/u);
  assert.match(texts[2], /reaching this review through web\/a\.txt/u);
});

test('cli.journeys-submit-merge-texts.ship-merges-only-when-off: clause 2: with submit.composeAsObject on, ship runs no git merge so the branch gains no merge commit, and with it off ship merges main as before [C7,U159]', async t => {
  const { box, folder } = await behindMain(t);
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: box.env }).trim();
  git(folder, 'config', 'user.name', 'Merge texts');
  git(folder, 'config', 'user.email', 'merge-texts@example.invalid');
  const main = git(box.repo, 'rev-parse', 'refs/heads/main');
  const head = git(folder, 'rev-parse', 'HEAD');
  assert.equal(shipMain(folder, main, { composeAsObject: true }), false);
  assert.equal(git(folder, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(git(folder, 'rev-list', '--merges', 'HEAD'), '', 'the branch gained no merge commit');
  git(folder, 'config', 'core.hooksPath', '/dev/null'); // what is tested is whether ship merges; the repository's merge hooks are not (as runFixtureSetupGit does for commits)
  assert.equal(shipMain(folder, main, { composeAsObject: false }), true);
  assert.equal(git(folder, 'rev-list', '--merges', 'HEAD').split('\n').length, 1, 'the setting off merges main into the branch');
  git(folder, 'merge-base', '--is-ancestor', main, 'HEAD');
});

test('cli.journeys-submit-merge-texts.ship-help-line-true-either-way: clause 3: the ship line in pullboard help no longer says merge main and is true with the setting on or off [C7,U159]', () => {
  const line = workHelp.split('\n').find(text => /^\s+pullboard ship /u.test(text));
  assert.ok(line, 'help has a ship line');
  assert.doesNotMatch(line, /merge main/u);
  assert.match(line, /commit staged work, submit and wait up to 30 minutes for the verdict/u);
});
