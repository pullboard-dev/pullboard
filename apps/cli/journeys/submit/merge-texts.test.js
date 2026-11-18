/** Resume, verify and ship stop asking a builder to merge main: only a Git conflict does [C7,U159]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { workHelp } from '../../src/logic/help/work.js';
import { shipMain } from '../../src/io/commands/ship.js';
import { trunkMovedAgainText } from '../../src/io/commands/verify.js';
import { trunkMovedOverlapText } from '../../src/io/commands/verify.js';

/** A claimed item with one commit of its own while main has moved on, so its branch is 1 ahead and 1 behind. */
async function behindMain(t, { on }) {
  const box = await pullProject(t, 1);
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'pull' }, ...(on ? { submit: { composeAsObject: true } } : {}) });
  const [id] = box.ids;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal((await box.helpers.commitFile(box, folder, `web/${id}.txt`, `merge-texts ${id}\n`, `feat(web): merge texts ${id} [G1]`)).status, 0);
  assert.equal((await box.helpers.commitFile(box, box.repo, 'web/newer-main.txt', 'newer\n', 'feat(web): main moved on [G1]')).status, 0);
  return { box, folder };
}

/** The item folder of a branch one ahead and one behind main, with the main commit and a git runner that has its own identity. */
async function shippable(t) {
  const { box, folder } = await behindMain(t, { on: false });
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: box.env }).trim();
  git(folder, 'config', 'user.name', 'Merge texts');
  git(folder, 'config', 'user.email', 'merge-texts@example.invalid');
  return { folder, git, main: git(box.repo, 'rev-parse', 'refs/heads/main') };
}

for (const [name, on] of [['on', true], ['off', false]]) {
  test(`cli.journeys-submit-merge-texts.resume-behind-main-${name}: clause 1: pullboard resume on a branch behind main prints ahead and behind without asking for a merge, with submit.composeAsObject ${name} [C7,U159]`, async t => {
    const { box, folder } = await behindMain(t, { on });
    const resumed = await box.runLocal(folder, 'resume');
    assert.equal(resumed.code, 0, resumed.err);
    assert.match(resumed.out, /1 ahead of main, 1 behind/u);
    assert.doesNotMatch(resumed.out, /merge main before you submit/u);
  });
}

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
  const on = await shippable(t);
  const off = await shippable(t);
  const head = on.git(on.folder, 'rev-parse', 'HEAD');
  assert.equal(shipMain(on.folder, on.main, { composeAsObject: true }), false);
  assert.equal(on.git(on.folder, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(on.git(on.folder, 'rev-list', '--merges', 'HEAD'), '', 'the branch gained no merge commit');
  assert.equal(shipMain(off.folder, off.main, { composeAsObject: false }), true);
  assert.equal(off.git(off.folder, 'rev-list', '--merges', 'HEAD').split('\n').length, 1, 'the setting off merges main into the branch');
  off.git(off.folder, 'merge-base', '--is-ancestor', off.main, 'HEAD');
});

test('cli.journeys-submit-merge-texts.ship-help-line-true-either-way: clause 3: the ship line in pullboard help no longer says merge main and is true with the setting on or off [C7,U159]', () => {
  const line = workHelp.split('\n').find(text => /^\s+pullboard ship /u.test(text));
  assert.ok(line, 'help has a ship line');
  assert.doesNotMatch(line, /merge main/u);
  assert.match(line, /commit staged work, submit and wait up to 30 minutes for the verdict/u);
});
