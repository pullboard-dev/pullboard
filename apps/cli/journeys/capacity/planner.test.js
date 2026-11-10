import { viewApiPorts } from '../../../view/index.js';
/** Seeded native history drives the same capacity projection in status and the daily digest [N2,R1,R2]. */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { main } from '../../tests/fixtures/native.js';
import { apiFetch } from '../../tests/fixtures/api.js';
import { rebuildProofCounters } from '../../../../packages/verify/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

const HOUR = 3_600_000;

/** Completed native fixture transitions are synthetic model inputs, never claims of executed gate proof. */
function seededProject(t) {
  const kit = createE2eHelpers();
  t.after(kit.cleanup);
  const box = kit.project('true');
  // @pullboard-board-file journey: the real status, digest and HTTP readers open this seeded project board
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  const now = Date.now();
  let clock = now - 3 * 24 * HOUR;
  board.clock = { now: () => new Date(clock) };
  const builder = store.register(board, { lane: 'web', path: join(box.dir, 'capacity-builder'), route: 'strong' });
  const reviewer = store.register(board, { lane: 'review', path: join(box.dir, 'capacity-reviewer'), route: 'strong' });
  const adopted = [];
  for (let index = 0; index < 6; index++) {
    clock = now - (60 - index * 4) * HOUR;
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Measured model input ${index}`,
      route: 'strong', brief: `Files: web/history-${index}.js` });
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 8 * HOUR,
      freeze: item => ({ text: item.item_title, digest: `synthetic:${item.item_id}` }) });
    clock += HOUR;
    const commit = String(index + 1).repeat(40);
    submitFixture(board, id, { agentId: builder, commit, tree: commit });
    clock += HOUR / 4;
    store.reserveReview(board, id, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
    clock += HOUR / 2;
    const item = store.getItem(board, id);
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', policy: 'any', head: commit,
      digest: item.item_frozen_digest, note: 'Synthetic model history; no executed gate result is claimed.' });
    clock += HOUR / 4;
    store.merged(board, id, { agentId: 'coordinator', commit });
    adopted.push({ id, commit });
  }
  // This is a synthetic coordinator batch observation, not a real landing or proof receipt.
  store.logEvent(board, 'coordinator', 'landing_batch', null, { batch: {
    version: 1, id: 'synthetic-capacity-cycle', state: 'trunk', items: adopted,
    startedAt: new Date(clock - HOUR / 4).toISOString(), updatedAt: new Date(clock).toISOString(),
  } });
  clock = now;
  for (let index = 0; index < 3; index++) store.addItem(board, { by: 'coordinator', lane: 'web',
    title: `Remaining work ${index}`, route: 'strong', brief: `Files: web/remaining-${index}.js` });
  for (const agentId of [builder, reviewer]) store.appendFact(board, adopted[0].id, {
    agentId, kind: 'note', text: 'Synthetic current seat activity for the capacity fixture.',
  });
  // Simulate the ordinary writable capability backfill after installation, before read-only consumers.
  rebuildProofCounters(board);
  store.closeBoard(board);
  return box;
}

test('status shows max useful agents the binding constraint and its lever [N2,R1,R2]', async t => {
  const box = seededProject(t);
  const result = box.run(box.repo, 'status', '--json');
  assert.equal(result.code, 0, result.out + result.err);
  const planner = JSON.parse(result.out).capacityForecast;
  assert.ok(planner && typeof planner === 'object', 'status exposes the board capacity projection');
  assert.equal(planner.available, true);
  assert.ok(planner.source.samples > 0, 'forecast identifies its measured cohort');
  assert.ok(planner.workHours > 0 && planner.tInfinityHours > 0);
  assert.ok(planner.agents.recommended > 0);
  assert.equal(planner.monteCarlo.replicates, 100);
  assert.ok(planner.finishHours.lower > 0 && planner.finishHours.upper >= planner.finishHours.lower);
  assert.ok(planner.binding.kind && planner.binding.text && planner.lever.kind && planner.lever.text);
  const text = box.run(box.repo, 'status');
  assert.equal(text.code, 0, text.out + text.err);
  assert.match(text.out, /Max useful agents now:/u);
  assert.match(text.out, /Binding:/u);
  assert.match(text.out, /Lever:/u);
  const digest = box.run(box.repo, 'digest', '--json');
  assert.equal(digest.code, 0, digest.out + digest.err);
  const morning = JSON.parse(digest.out);
  assert.deepEqual(morning.capacityForecast, planner, 'morning digest uses the identical cached projection');
  assert.match(morning.markdown, /Max useful agents now:/u);
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, runCommand: main, refusalDocument,
    projects: () => [{ root: box.repo, name: 'Capacity fixture', project: '', added: '2026-10-20T00:00:00Z' }] });
  t.after(() => api.close());
  const address = new URL(api.url);
  const client = { origin: address.origin, secret: address.searchParams.get('k') };
  const listing = await apiFetch(client, '/api/v1/boards');
  assert.equal(listing.status, 200);
  const board = (await listing.json()).boards.find(entry => entry.root === box.repo);
  assert.ok(board?.id);
  const response = await apiFetch(client, `/api/v1/boards/${board.id}/state`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).state.capacityForecast, planner, 'real HTTP state exposes the same cached forecast');
  const again = await apiFetch(client, `/api/v1/boards/${board.id}/state`);
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).state.capacityForecast, planner, 'serialized API cache hits preserve the capacity field');
});
