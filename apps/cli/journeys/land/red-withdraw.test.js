/** An accepted item the landing cannot take is moved by the coordinator with withdraw, not refused CLOSED [C7,#6469]. */
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
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

/** A plain landing project in the default shape: no affectedTests, per-item landing, no landing.publish, pushed to its origin. */
function defaultProject() {
  const box = landProject();
  // These cases assert the submit's gate running in the command; pinned to controller dispatch until #5821 lands [P7].
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  delete config.affectedTests;
  delete config.landing.perItem;
  delete config.landing.publish;
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: the init default has no affectedTests');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  return box;
}

/** The item's board row, read through show --json. */
async function itemRow(box, id) {
  const shown = await box.runLocal(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  const document = JSON.parse(shown.out);
  return document.item ?? document;
}

test('clause 1: an accepted item whose file is red is moved by the coordinator with withdraw, not refused CLOSED or NOT_SUBMITTED [C7,#6469]', { timeout: 180_000 }, // budget: one real submit and accept; hang ceiling only.
async () => {
  const box = defaultProject();
  const entry = itemWorktree(box, 1);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, entry, 'RED\n'); acceptItem(box, entry); } finally { delete box.env.LAND_SUPPRESS_RED; }
  const before = await itemRow(box, entry.item);
  assert.equal(before.item_status ?? before.status, 'verified', 'the item is accepted and waiting to land');
  const withdrawn = await box.runLocal(box.repo, 'withdraw', String(entry.item), 'cannot land; the coordinator moves it');
  assert.equal(withdrawn.code, 0, withdrawn.out + withdrawn.err);
  assert.doesNotMatch(withdrawn.out + withdrawn.err, /CLOSED|NOT_SUBMITTED/u);
  const moved = await itemRow(box, entry.item);
  assert.equal(moved.item_status ?? moved.status, 'withdrawn');
});
