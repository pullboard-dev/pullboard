/** Separate landing: a red at landing parks or returns once, and a clean accepted item still lands [C7,#6269]. */
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
const { landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures(e2e);

/** A plain project on init's landing defaults (per-item, no affectedTests) with landing.publish "separate". */
function separateProject() {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  delete config.affectedTests;
  delete config.landing.perItem;
  config.landing.publish = 'separate';
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: separate publication on init defaults');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  return box;
}

/** Build, submit and accept one item; a red one hides its red while it is proved, as a narrower submit would. */
function accepted(box, number, contents) {
  const entry = itemWorktree(box, number);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, entry, contents); acceptItem(box, entry); } finally { delete box.env.LAND_SUPPRESS_RED; }
  return entry;
}

/** The item's board row, read through show --json. */
async function itemRow(box, id) {
  const shown = await box.runLocal(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  const document = JSON.parse(shown.out);
  return document.item ?? document;
}

/** Whether the red item left the landing queue: back to open, or held. */
function leftQueue(row) {
  return (row.item_status ?? row.status) !== 'verified' || Boolean(row.item_hold_at ?? row.hold);
}

test('clause 1 and 2: with landing.publish separate a red item leaves the queue after one landing cycle and a clean item still lands on the local trunk [C7,#6269]', { timeout: 240_000 }, // budget: two real submits, accepts and at most three landings; hang ceiling only.
async () => {
  const box = separateProject();
  const red = accepted(box, 1, 'RED\n');
  const clean = accepted(box, 2, 'PASS\n');
  moveMainPastSubmit(box);
  const origin = box.git(box.repo, 'rev-parse', 'origin/main');
  const outputs = [];
  const first = await box.runLocal(box.repo, 'land', '--json');
  outputs.push(first.out + first.err);
  assert.ok(leftQueue(await itemRow(box, red.item)), `one landing cycle parks or returns the red item: ${outputs.join('\n---\n')}`);
  for (let cycle = 0; cycle < 2 && !box.git(box.repo, 'log', '--format=%H', 'main').includes(clean.commit); cycle += 1) {
    const again = await box.runLocal(box.repo, 'land', '--json');
    outputs.push(again.out + again.err);
  }
  assert.ok(box.git(box.repo, 'log', '--format=%H', 'main').includes(clean.commit), `the clean item lands on the local trunk: ${outputs.join('\n---\n')}`);
  assert.ok(!box.git(box.repo, 'log', '--format=%H', 'main').includes(red.commit), 'the red item never reaches the trunk');
  assert.equal(box.tryGit(box.repo, 'ls-remote', 'origin', 'main').stdout.split(/\s+/u)[0], origin, 'separate landing leaves origin to publish');
});
