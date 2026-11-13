/** Independently schedule the real red landing bisection; stale proof and unverified stacks have their own files so each fits its limit under pull [B3,R3,E8]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { drainOwnedProcesses } from '../../tests/fixtures/land/drain.js';
import {
  calls,
  json,
} from '../../tests/fixtures/land/board.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

const mark = stage => console.log(`# bisect stage ${stage} ${Date.now()}`);
test('land bisects a real red: the culprit goes back named by the receipt and the green item lands [B3,R3,E8]', async () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  mark('start');
  const entries = [itemWorktree(box, 1, FILES[0]), itemWorktree(box, 3, FILES[2])];
  submitItem(box, entries[0], 'PASS\n');
  submitItem(box, entries[1], 'RED\n');
  for (const entry of entries) acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  mark('accepted');
  const base = box.git(box.repo, 'rev-parse', 'main');
  await drainOwnedProcesses(box.dir); // A submit's finishing gate writes its event on its own clock, so count only after it ends.
  const beforeCalls = calls(box).length;
  mark('draining done');
  const result = await settleLand(box, json(box, box.repo, 'land'));
  mark('landed');
  assert.deepEqual(result.landed, [entries[0].item]);
  assert.deepEqual(result.returned.map(row => [row.id, row.reason]), [[entries[1].item, 'red']], 'the red item is the culprit, named by the receipt');
  assert.ok(String(result.landJob.receipt.returned[0].detail).includes(FILES[2]), 'the receipt names the failing file');
  assert.ok(json(box, box.repo, 'show', String(entries[1].item)).thread.some((entry) => entry.type === 'fact' && entry.text.includes(FILES[2])));
  assert.ok(calls(box).length > beforeCalls, 'the lander ran its gate');
  assert.equal(json(box, box.repo, 'show', String(entries[0].item)).item_merged_commit, result.batch.tip);
  assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_merged_commit, null);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  assert.notEqual(result.batch.tip, base);
  await drainOwnedProcesses(box.dir);
  const afterCalls = calls(box).length;
  mark('second land');
  await box.runLocal(box.repo, 'land', '--json');
  mark('second land done');
  assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_status, 'open', 'the known red is returned to its builder and is no longer a verified landing candidate');
  assert.equal(calls(box).length, afterCalls, 'known unchanged red is not retried');
  await drainOwnedProcesses(box.dir); // Nothing may still write into the fixture when cleanup removes it.
});
