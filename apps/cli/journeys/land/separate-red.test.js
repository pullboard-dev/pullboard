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

/** Build and submit one item; a red one hides its red while it is proved, as a narrower submit would. */
function submitted(box, number, contents) {
  const entry = itemWorktree(box, number);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, entry, contents); } finally { delete box.env.LAND_SUPPRESS_RED; }
  return entry;
}

/** Run one landing cycle and keep its output with its batch log. */
async function cycle(box, outputs) {
  const landed = await box.runLocal(box.repo, 'land', '--json');
  let log = '';
  try { log = readFileSync(JSON.parse(landed.out).batch.logPath, 'utf8'); } catch { log = ''; }
  outputs.push(`${landed.out}${landed.err}\n${log}`);
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

test('clause 1 and clause 2: with landing.publish separate a red item leaves the landing queue within two cycles, parked or returned, and a clean item still lands [C7,#6269]', { timeout: 240_000 }, // budget: two real submits, accepts and at most three landings; hang ceiling only.
async () => {
  const box = separateProject();
  const red = submitted(box, 1, 'RED\n');
  const clean = submitted(box, 2, 'PASS\n');
  acceptItem(box, red);
  moveMainPastSubmit(box);
  const origin = box.git(box.repo, 'rev-parse', 'origin/main');
  const outputs = [];
  for (let count = 0; count < 2 && !leftQueue(await itemRow(box, red.item)); count += 1) await cycle(box, outputs);
  assert.ok(leftQueue(await itemRow(box, red.item)), `the red item is parked or returned by the second cycle: ${outputs.join('\n---\n').slice(-4000)}`);
  // clause 2: the clean item accepted behind it still lands on the local trunk.
  acceptItem(box, clean);
  await cycle(box, outputs);
  const trunk = box.git(box.repo, 'log', '--format=%H', 'main');
  assert.ok(trunk.includes(clean.commit), `the clean item lands on the local trunk: ${outputs.at(-1).slice(-4000)}`);
  assert.ok(!trunk.includes(red.commit), 'the red item never reaches the trunk');
  assert.equal(box.tryGit(box.repo, 'ls-remote', 'origin', 'main').stdout.split(/\s+/u)[0], origin, 'separate landing leaves origin to publish');
});
