/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** @pullboard-test-loads apps/cli/src/io/commands/next.js */
/** @pullboard-test-loads packages/jobs/src/io/test-run-queue.js */
/** A seat's pullboard test queues on the board and returns at once; next hands the result back; --wait blocks [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import {
  FAILS,
  asSeat,
  runnerProject,
} from '../../../../tests/fixtures/runner/queued.js';
import { fixtureAdd } from '../../../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../../../pullboard.js');

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('an item check that runs pullboard test on a red file fails, never a queued pass [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for the check and its nested runner run.
  const box = runnerProject(e2e);
  // The check's file sits in the web lane, so the web seat may build the item whose check names it.
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web', 'red.test.js'), FAILS);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: a red file in the web lane');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Red check', '--specs', 'G1', '--criterion', 'the red file fails its check', '--brief', 'Files: web/page.js. Change: none. Test case: red case.', '--check', `"${process.execPath}" "${BIN}" test web/red.test.js`);
  assert.equal(added.code, 0, `add: ${added.out}${added.err}`);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, `claim: ${claimed.out}${claimed.err}`);
  const checked = asSeat(box, 'check', '--yes');
  assert.notEqual(checked.code, 0, `the red check is red: ${checked.out}${checked.err}`);
  assert.doesNotMatch(checked.out + checked.err, /queued test run/u, 'the check never got the queued answer');
});
