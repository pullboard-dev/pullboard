/** pullboard show prints the phases of the landing receipt that merged an item, from the landing fixture's board [C7,#9079]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { claimJob } from '../../../../packages/api/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { pullQueue } from '../../tests/fixtures/pull.js';

/** The phases a land job records for a batch landing, in the order it runs them (packages/landing/src/io/runner/job.js). */
const PHASES = [{ phase: 'merge', ms: 120 }, { phase: 'static checks', ms: 4000 }, { phase: 'cli smoke', ms: 900 }, { phase: 'push', ms: 700 }];

/**
 * An item the landing fixture built and verified, and a poster for the runner job's land receipt.
 * Why a posted receipt: a real runner landing outran the 180 s file budget; the receipt carries the same phases a runner job records [C7].
 */
async function verifiedItem(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const entry = fixtures.itemWorktree(box, 1);
  fixtures.submitItem(box, entry);
  fixtures.acceptItem(box, entry);
  const queue = await pullQueue(t, { ...box, boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite') });
  const land = async phases => {
    const trunk = box.git(box.repo, 'rev-parse', 'main');
    offerJob(queue.board.db, { id: 'land:1:k', kind: 'land', base: trunk, needs: [], payload: { items: [{ id: entry.item }] }, now: 1 });
    const held = claimJob(queue.board.db, { runner: 'r-land', capabilities: [], now: 2 });
    boardJobQueueCall(queue.board, { action: 'receipt', job: 'land:1:k', runner: 'r-land', token: held.token,
      receipt: { kind: 'land', outcome: 'landed', trunk, landed: [entry.item], already: [], ...(phases ? { phases } : {}) } }, { mode: 'pull', now: 3 });
  };
  return { box, entry, land };
}

test('clause 1: show --json for a landed item carries landing.phases as {phase, ms} rows naming merge, static checks, cli smoke and push as the runner job recorded them [C7,#9079]', async t => {
  const { box, entry, land } = await verifiedItem(t);
  await land(PHASES);
  const shown = await box.runLocal(box.repo, 'show', String(entry.item), '--json');
  assert.equal(shown.code, 0, shown.err);
  const document = JSON.parse(shown.out);
  assert.ok(document.item_merged_commit, shown.out);
  assert.deepEqual(document.landing.phases, PHASES);
});

test('clause 2: show prints one line per phase, and an item with no recorded landing phases prints none and no error [C7,#9079]', async t => {
  const { box, entry, land } = await verifiedItem(t);
  // Verified but not yet landed, as an item landed before phases were kept: no phase line, no landing document, no error.
  const plain = await box.runLocal(box.repo, 'show', String(entry.item));
  assert.equal(plain.code, 0, plain.err);
  assert.doesNotMatch(plain.out, /landing phase/u);
  const json = await box.runLocal(box.repo, 'show', String(entry.item), '--json');
  assert.equal(json.code, 0, json.err);
  assert.equal(JSON.parse(json.out).landing, undefined);
  await land(PHASES);
  const shown = await box.runLocal(box.repo, 'show', String(entry.item));
  assert.equal(shown.code, 0, shown.err);
  assert.deepEqual(shown.out.split('\n').filter(line => line.startsWith('landing phase ')),
    ['landing phase merge: 120 ms', 'landing phase static checks: 4000 ms', 'landing phase cli smoke: 900 ms', 'landing phase push: 700 ms']);
});
