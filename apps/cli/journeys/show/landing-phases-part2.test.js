/** pullboard show prints the exact-tree record beside the landing, from the landing fixture's board [V16,V38]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { claimJob } from '../../../../packages/api/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';

/** The phases a land job records for a batch landing, in the order it runs them (packages/landing/src/io/runner/job.js). */
const PHASES = [{ phase: 'merge', ms: 120 }, { phase: 'static checks', ms: 4000 }, { phase: 'cli smoke', ms: 900 }, { phase: 'push', ms: 700 }];

/**
 * An item the landing fixture built and verified, and a poster for the runner job's land receipt.
 * Why a posted receipt: a real runner landing outran the 180 s file budget; the receipt carries the same phases a runner job records [C7].
 * Why the Local helpers: the commit (with test.inProcessHooks on), submit and accept run in this process, not as a node start-up each [C7,#10457].
 */
async function verifiedItem(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true } });
  const entry = await fixtures.itemWorktreeLocal(box, 1);
  await fixtures.commitItemLocal(box, entry);
  await fixtures.submitItemLocal(box, entry);
  await fixtures.acceptItemLocal(box, entry);
  const queue = await pullQueue(t, { ...box, boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite') });
  const land = async phases => {
    const trunk = box.git(box.repo, 'rev-parse', 'main');
    offerJob(queue.board.db, { id: 'land:1:k', kind: 'land', base: trunk, needs: [], payload: { items: [{ id: entry.item }] }, now: 1 });
    const held = claimJob(queue.board.db, { runner: 'r-land', capabilities: [], now: 2 });
    boardJobQueueCall(queue.board, { action: 'receipt', job: 'land:1:k', runner: 'r-land', token: held.token,
      receipt: { kind: 'land', outcome: 'landed', trunk, landed: [entry.item], already: [], ...(phases ? { phases } : {}) } }, { mode: 'pull', now: 3 });
  };
  /** Record the landed batch snapshot that carried the item, as the lander writes it, with the exact-tree record the test names. */
  const record = exactTree => logEvent(queue.board, 'coordinator', 'landing_batch', null,
    { batch: { id: 'b1', state: 'landed', items: [{ id: entry.item }], ...(exactTree ? { exactTree } : {}) } });
  return { box, entry, land, record };
}

const TREE = 'a'.repeat(40);
const PROOF = { tree: TREE, pin: 'b'.repeat(40), cells: ['apps/cli', 'packages/landing'], result: 'green' };

test('cli.journeys-show-landing-phases.show-prints-one-line-beside-the: clause 1: show prints one line beside the landing with the tree id, the tooling commit, the cells run and the result, and --json carries the record [V16,V38]', async t => {
  const { box, entry, land, record } = await verifiedItem(t);
  await land(PHASES);
  record(PROOF);
  const shown = await box.runLocal(box.repo, 'show', String(entry.item));
  assert.equal(shown.code, 0, shown.err);
  assert.deepEqual(shown.out.split('\n').filter(line => line.startsWith('landing exact tree ')),
    [`landing exact tree ${TREE.slice(0, 12)}: tooling ${PROOF.pin.slice(0, 12)}, green, cells apps/cli, packages/landing`]);
  const json = await box.runLocal(box.repo, 'show', String(entry.item), '--json');
  assert.deepEqual(JSON.parse(json.out).landing.exactTree, PROOF);
});

test('cli.journeys-show-landing-phases.an-item-landed-before-the-record: clause 2: an item landed before the record existed prints no exact-tree line and no error [V16,V38]', async t => {
  const { box, entry, land, record } = await verifiedItem(t);
  await land(PHASES);
  record(undefined);
  const shown = await box.runLocal(box.repo, 'show', String(entry.item));
  assert.equal(shown.code, 0, shown.err);
  assert.doesNotMatch(shown.out, /landing exact tree/u);
  const json = await box.runLocal(box.repo, 'show', String(entry.item), '--json');
  assert.equal(json.code, 0, json.err);
  assert.equal(JSON.parse(json.out).landing.exactTree, undefined);
});
