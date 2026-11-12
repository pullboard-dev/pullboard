/** A landing that pushes reuses only a whole-suite submit receipt for the same tree [C7,#6271]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

/** A plain landing project with its landing config changed by `edit` and committed on main. */
function shapedProject(edit) {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  edit(config);
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: landing shape for the reuse journey');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  return box;
}

/** The whole-suite runs the fixture gate recorded (runs without --alone). */
function fullRuns(box) {
  try { return readFileSync(box.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => !row.alone).length; }
  catch { return 0; }
}

/** Submit and accept one green item, then land it and return the landing's output and the whole-suite runs it started. */
async function landOne(box) {
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  const before = fullRuns(box);
  const landed = await box.runLocal(box.repo, 'land', '--json');
  return { entry, landed, output: landed.out + landed.err, runs: fullRuns(box) - before };
}

test('clause 1: in the default shape a narrower submit proof is not reused; the landing runs the full gate on the merged tree and pushes it [C7,#6271]', { timeout: 120_000 }, // budget: one real submit, accept and landing; hang ceiling only.
async () => {
  const box = shapedProject(config => { delete config.landing.publish; });
  const { entry, landed, output, runs } = await landOne(box);
  assert.equal(landed.code, 0, output);
  assert.doesNotMatch(output, /no test run started/u, 'a narrower receipt never stands in for the whole suite');
  assert.ok(runs >= 1, `the landing ran the whole configured gate: ${output}`);
  assert.equal(box.git(box.repo, 'rev-parse', 'origin/main'), box.git(box.repo, 'rev-parse', 'main'), 'the whole-suite tree reached origin');
  assert.ok(box.git(box.repo, 'log', '--format=%H', 'origin/main').includes(entry.commit));
});

test('clause 1: in the default shape a whole-suite submit receipt for the identical tree is reused with no test run [C7,#6271]', { timeout: 120_000 }, // budget: one real submit, accept and landing; hang ceiling only.
async () => {
  const box = shapedProject(config => { delete config.landing.publish; delete config.affectedTests; });
  const { landed, output, runs } = await landOne(box);
  assert.equal(landed.code, 0, output);
  assert.match(output, /reused #\d+'s submit receipt for tree [0-9a-f]{12}; no test run started/u, output);
  assert.equal(runs, 0, output);
});

test('clause 2: with landing.publish "separate" a narrower submit receipt is reused as before [C7,#6271]', { timeout: 120_000 }, // budget: one real submit, accept and landing; hang ceiling only.
async () => {
  const box = shapedProject(config => { config.landing.publish = 'separate'; });
  const { landed, output, runs } = await landOne(box);
  assert.equal(landed.code, 0, output);
  assert.match(output, /reused #\d+'s submit receipt for tree [0-9a-f]{12}; no test run started/u, output);
  assert.equal(runs, 0, output);
});
