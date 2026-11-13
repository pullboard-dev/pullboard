/** With no trunk remote and no local runner, pullboard land refuses with its next step; no batch runs on the host [C7,#6807]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { landingBatches } from '../../../../../packages/store/index.js';
import { verify } from '../../../../../packages/store/index.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../tests/fixtures/pull.js';
import { serveOnce } from '../../../tests/fixtures/pull.js';
import { submitOne } from '../../../tests/fixtures/pull.js';

test('#6807 clause 1: with no trunk remote and no local runner, land refuses with a next step and runs no batch on the host [C7,#6807]', { timeout: 240_000 }, // budget: one pulled gate, an in-process lander and a land command; hang ceiling only.
async t => {
  const box = await pullProject(t, 1);
  // The fixture project lands by hand (landing.manualOverride), so a plain land reaches the offer, and no trunk remote is named.
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  assert.equal(config.landing?.manualOverride, true);
  assert.equal(config.trunk?.remote, undefined);
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const queue = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  assert.equal((await serveOnce(box, queue.url, 'r-gate')).code, 0);
  verify(queue.board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'fixture acceptance of a gated item', head: commit, digest: getItem(queue.board, id).item_frozen_digest, policy: 'any' });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false } });
  const main = box.git(box.repo, 'rev-parse', 'main');
  const landed = await runCliInProcess(['land', '--json'], { cwd: box.repo, env: { ...box.env } });
  assert.notEqual(landed.code, 0, `${landed.err}\n${landed.out}`);
  assert.match(landed.err + landed.out, /LAND_NO_RUNNER/u);
  assert.match(landed.err + landed.out, /next: set trunk\.remote in pullboard\.json/u, 'the refusal names the next step');
  for (const flag of [['--max', '1'], ['--adopt'], ['--due'], ['--dry-run']]) {
    const retired = await runCliInProcess(['land', ...flag, '--json'], { cwd: box.repo, env: { ...box.env } });
    assert.notEqual(retired.code, 0, `land ${flag.join(' ')} ran: ${retired.out}`);
    assert.match(retired.err + retired.out, /LAND_OFFER_ONLY/u, `land ${flag.join(' ')} offers only the land job`);
  }
  assert.equal(jobsOf(queue.board.db, { kind: 'land' }).length, 0, 'no runner could take a land job, so none was offered');
  assert.equal(landingBatches(queue.board).length, 0, 'no landing batch ran on the board host');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), main, 'nothing on the host merged');
  assert.equal(getItem(queue.board, id).item_status, 'verified', 'the item keeps its accept');
  assert.equal(getItem(queue.board, id).item_merged_commit, null);
});
