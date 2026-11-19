/** A worktree under the OS temporary directory is refused only when gate.refuseTempWorktree is on [C7,#8513]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  FIXTURE_MODEL,
  fixtureJoin,
  fixtureSettledMachine,
} from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project } = e2e;

/** A coordinator-joined fixture repo, which the sandbox puts under the OS temporary directory. */
function coordinatorBox() {
  const box = sandbox();
  const { repo } = project('true', box);
  box.env.PULLBOARD_FIXTURE_MODEL = FIXTURE_MODEL;
  const joined = fixtureJoin(box.run, repo, 'coordinator', '--model', FIXTURE_MODEL);
  assert.equal(joined.code, 0, joined.err || joined.out);
  return { box, repo };
}

test('cli.journeys-worktree-temp.a-worktree-request-under-the-os: clause 1: a worktree request under the OS temporary directory is refused naming the persistent default when the setting is on [C7,#8513]', async () => {
  const { box, repo } = coordinatorBox();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { gate: { refuseTempWorktree: true } });
  const before = box.git(repo, 'worktree', 'list', '--porcelain');
  const refused = await box.runLocal(repo, 'worktree', 'web');
  const said = refused.err + refused.out;
  assert.equal(refused.code, 1, refused.err || refused.out);
  assert.match(said, /\[TEMP_WORKTREE\]/u);
  assert.match(said, /temporary directory/u);
  assert.match(said, /persistent default is the "beside" placement/u);
  assert.equal(box.git(repo, 'worktree', 'list', '--porcelain'), before, 'the refused request made no worktree');
});

test('cli.journeys-worktree-temp.the-setting-is-off-by-default: clause 2: the setting is off by default and leaves worktree requests unchanged [C7,#8513]', async () => {
  const { box, repo } = coordinatorBox();
  const made = await box.runLocal(repo, 'worktree', 'web', '--json');
  assert.equal(made.code, 0, made.err || made.out);
  assert.equal(JSON.parse(made.out).lane, 'web');
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { gate: { refuseTempWorktree: false } });
  const again = await box.runLocal(repo, 'worktree', 'web', '--json');
  assert.equal(again.code, 0, again.err || again.out);
});
