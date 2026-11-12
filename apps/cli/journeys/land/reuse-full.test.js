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
const { commitFile } = e2e;

/** A plain landing project with its landing config changed by `edit` and committed on main. */
function shapedProject(edit) {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  edit(config);
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '--allow-empty', '-am', 'chore: landing shape for the reuse journey');
  // Two tests already on main, so an item that edits one submits on a narrower selection than the whole suite.
  for (const file of ['web/land-1.test.js', 'web/land-2.test.js']) assert.equal(commitFile(box, box.repo, file, 'PASS\n', `test(web): seed ${file} [G1]`).status, 0);
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  return box;
}

/** The fixture gate's recorded runs: whole-suite ones (no --alone) and focused ones. */
function traced(box) {
  let rows = [];
  try { rows = readFileSync(box.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { rows = []; }
  return { full: rows.filter(row => !row.alone).length, alone: rows.filter(row => row.alone).length };
}

/** Submit and accept one green item, then land it; returns the whole-suite runs its submit and its landing started. */
async function landOne(box) {
  const entry = itemWorktree(box, 1);
  const start = traced(box);
  submitItem(box, entry, 'PASS again\n');
  acceptItem(box, entry);
  const before = traced(box);
  const landed = await box.runLocal(box.repo, 'land', '--json');
  const output = landed.out + landed.err;
  assert.equal(landed.code, 0, output);
  return { entry, output, submitFull: before.full - start.full, landingFull: traced(box).full - before.full };
}

test('clause 1: in the default shape a narrower submit proof is not reused; the landing runs the full gate on the merged tree and pushes it [C7,#6271]', { timeout: 120_000 }, // budget: one real submit, accept and landing; hang ceiling only.
async () => {
  const box = shapedProject(config => { delete config.landing.publish; });
  const { entry, output, submitFull, landingFull } = await landOne(box);
  assert.equal(submitFull, 0, 'the submit proved a narrower selection, not the whole suite');
  assert.equal(landingFull, 1, `the landing ran the whole configured gate once: ${output}`);
  assert.equal(box.git(box.repo, 'rev-parse', 'origin/main'), box.git(box.repo, 'rev-parse', 'main'), 'the whole-suite tree reached origin');
  assert.ok(box.git(box.repo, 'log', '--format=%H', 'origin/main').includes(entry.commit));
});

test('clause 1: in the default shape a whole-suite submit receipt for the identical tree is reused with no test run [C7,#6271]', { timeout: 120_000 }, // budget: one real submit, accept and landing; hang ceiling only.
async () => {
  const box = shapedProject(config => { delete config.landing.publish; delete config.affectedTests; });
  const { output, submitFull, landingFull } = await landOne(box);
  assert.ok(submitFull >= 1, 'the submit ran the whole suite');
  assert.equal(landingFull, 0, `the whole-suite receipt stood for the identical tree: ${output}`);
});

test('clause 2: with landing.publish "separate" a narrower submit receipt is reused as before [C7,#6271]', { timeout: 120_000 }, // budget: one real submit, accept and landing; hang ceiling only.
async () => {
  const box = shapedProject(config => { config.landing.publish = 'separate'; });
  const { output, submitFull, landingFull } = await landOne(box);
  assert.equal(submitFull, 0, 'the submit proved a narrower selection, not the whole suite');
  assert.equal(landingFull, 0, `the separate landing reused the narrower receipt: ${output}`);
});
