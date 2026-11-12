/** Under gate.runnerDispatch pull, an item folder's check records its native proof, and a lapsed claim says so instead of PROOF_RUN_UNAVAILABLE [C7,P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pullProject } from '../../tests/fixtures/pull.js';

/** The frozen check: it logs each run in the checkout's Git folder, then passes. */
const CHECK = `import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
appendFileSync(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim() + '/check-runs.log', 'ran\\n');
`;

/** How many times the frozen check ran in this project. */
function runs(box) {
  const file = join(box.repo, '.git', 'check-runs.log');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
}

test('clause 1: a pull-dispatch check from the item folder records its proof, a lapsed claim names the renewal, and submit then queues [C7,P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, two checks and one queued submit.
async t => {
  const box = await pullProject(t, 1, { check: () => 'node bin/check.js', tooling: { 'bin/check.js': CHECK } });
  const [id] = box.ids;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal(box.helpers.commitFile(box, folder, `web/${id}.txt`, 'built\n', `feat(web): build item ${id} [G1]`).status, 0);

  // The night of 12 Nov: the sentinel released the claim, and the check in the item folder ran with no seat behind it.
  const released = await box.runLocal(box.web, 'release', String(id), '--reason', 'BLOCKED', '--note', 'claim lapsed', '--no-next');
  assert.equal(released.code, 0, released.err + released.out);
  const lapsed = await box.runLocal(folder, 'check', String(id), '--yes');
  assert.notEqual(lapsed.code, 0, 'a check with no seat behind it is refused');
  assert.doesNotMatch(lapsed.out + lapsed.err, /PROOF_RUN_UNAVAILABLE/u, 'the lapsed claim is named, not a missing receipt');
  assert.match(lapsed.out + lapsed.err, /NOT_HOLDING/u);
  assert.match(lapsed.out + lapsed.err, new RegExp(`pullboard claim ${id}`, 'u'), 'the refusal names the renewal');

  // Renewed, the same check in the same folder records its native receipt, and submit accepts it.
  const renewed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(renewed.code, 0, renewed.err);
  const before = runs(box);
  const checked = await box.runLocal(folder, 'check', String(id), '--yes');
  assert.equal(checked.code, 0, checked.out + checked.err);
  assert.doesNotMatch(checked.out + checked.err, /PROOF_RUN_UNAVAILABLE/u);
  assert.equal(runs(box), before + 1, 'the frozen check ran once');
  const shown = await box.runLocal(box.repo, 'show', String(id));
  assert.match(shown.out, new RegExp(`receipt [0-9a-f-]{36}: check, item #${id}`, 'u'), 'the board holds the check\'s native receipt');
  const submitted = await box.runLocal(folder, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.doesNotMatch(submitted.out + submitted.err, /PROOF_RUN_UNAVAILABLE/u);
  assert.equal(JSON.parse(submitted.out).queued, true, 'the submit queued its gate as one runner job');
});
