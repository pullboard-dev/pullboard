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
import { settleCapacity } from '../../../../packages/stats/index.js';

const HOUR = 3_600_000;

/** Completed native fixture transitions are synthetic model inputs, never claims of executed gate proof. */
function seededProject(t, { messy = false } = {}) {
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
  /** Add one strong web item as the coordinator. */
  const add = (title, fields = {}) => store.addItem(board, { by: 'coordinator', lane: 'web', title, route: 'strong', ...fields });
  /** Build, review and accept one synthetic history item from the current fixture clock. */
  function accept(index) {
    const id = add(`Measured model input ${index}`, { brief: `Files: web/history-${index}.js` });
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
    return { id, commit };
  }
  for (let index = 0; index < 6; index++) {
    clock = now - (60 - index * 4) * HOUR;
    const { id, commit } = accept(index);
    store.merged(board, id, { agentId: 'coordinator', commit });
    adopted.push({ id, commit });
  }
  if (messy) {
    // Synthetic returns after accept: one typed stale reopen (a failed landing) and one with no matching source commit (unclassified).
    clock = now - 34 * HOUR;
    const stale = accept(6);
    store.logEvent(board, 'coordinator', 'reopen', stale.id, { commit: stale.commit, note: 'verdict stale: web/history-6.js changed on main',
      cause: 'refusal:REOPENED', causeDerivation: { kind: 'reopen-category', coarse: true } });
    // A failed landing whose repair was never rebuilt leaves no landing-test build sample: it must not void the board.
    const redLanding = accept(8);
    store.logEvent(board, 'coordinator', 'reopen', redLanding.id, { commit: redLanding.commit, note: 'Synthetic landing gate failure.',
      landingFailure: { tests: [{ file: 'web/history-8.test.js', name: 'red on main' }] } });
    const loose = accept(7);
    store.logEvent(board, 'coordinator', 'reopen', loose.id, { commit: '9'.repeat(40), note: 'Synthetic return naming another commit.' });
  }
  // This is a synthetic coordinator batch observation, not a real landing or proof receipt.
  store.logEvent(board, 'coordinator', 'landing_batch', null, { batch: {
    version: 1, id: 'synthetic-capacity-cycle', state: 'trunk', items: adopted,
    startedAt: new Date(clock - HOUR / 4).toISOString(), updatedAt: new Date(clock).toISOString(),
  } });
  clock = now;
  for (let index = 0; index < 3; index++) add(`Remaining work ${index}`, { brief: `Files: web/remaining-${index}.js` });
  if (messy) {
    add('Remaining work with no files');
    const held = add('Held work', { brief: 'Files: web/held.js' });
    store.holdItem(board, held, { agentId: 'coordinator', reason: 'Waiting for a judgment' });
    add('Blocked work', { brief: 'Files: web/blocked.js', after: [held] });
    add('Person work', { brief: 'Files: web/person.js', specIds: ['N2'] });
  }
  // Live seats come from presence heartbeats, as a seat's own commands record them.
  for (const agentId of [builder, reviewer]) store.heartbeatSeat(board, agentId);
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
  const result = (await box.runLocal(box.repo, 'status', '--json'));
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
  const text = (await box.runLocal(box.repo, 'status'));
  assert.equal(text.code, 0, text.out + text.err);
  assert.match(text.out, /Max useful agents now:/u);
  assert.match(text.out, /Binding:/u);
  assert.match(text.out, /Lever:/u);
  const digest = (await box.runLocal(box.repo, 'digest', '--json'));
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

test('waiting items, file-less items and failed landings still yield a number from live seats [C7]', async t => {
  const box = seededProject(t, { messy: true });
  const result = (await box.runLocal(box.repo, 'status', '--json'));
  assert.equal(result.code, 0, result.out + result.err);
  const planner = JSON.parse(result.out).capacityForecast;
  assert.equal(planner.available, true, planner.unknown.join('; '));
  assert.ok(planner.agents.recommended > 0);
  assert.ok(planner.binding.kind !== 'unknown' && /limits useful concurrency/u.test(planner.binding.text), 'a named binding constraint, not unknown');
  assert.equal(planner.waiting, 3, 'held, person-waiting and blocked items lower supply as waiting work');
  assert.equal(planner.needsYou.length, 1);
  assert.ok(!planner.unknown.some(text => /held|needs a person|dependency|file collision|unmeasured|unclassified|repair build service/u.test(text)), planner.unknown.join('; '));
  assert.equal(planner.staffing.measuredLive, true, 'seats come from presence heartbeats');
  assert.ok(planner.staffing.seats >= 2, 'both heartbeating seats count as live');
  const text = (await box.runLocal(box.repo, 'status'));
  assert.equal(text.code, 0, text.out + text.err);
  assert.match(text.out, /Max useful agents now: \d+ /u);
  assert.match(text.out, /Binding: (?!unknown)[a-zA-Z]+\./u);
  assert.match(text.out, /Live seats: \d+ from presence heartbeats\./u);
});

/** Feed readings `[hours, minutes, value]` after a fixed start and return the applied value at each. */
function settleRun(readings, start = Date.UTC(2026, 10, 13, 0, 10)) {
  let state = null;
  return readings.map(([hours, minutes, value]) => {
    const out = settleCapacity(state, value, start + hours * HOUR + minutes * 60_000 - 10 * 60_000);
    state = out.state;
    return out.applied;
  });
}

test('a computed capacity moves only on a banded change in two consecutive hourly windows [C7]', () => {
  // Under 25% apart never moves, however long it lasts.
  assert.deepEqual(settleRun([[0, 10, 10], [1, 10, 12], [2, 10, 12], [3, 10, 12]]), [10, 10, 10, 10]);
  // A one-window spike, or two windows with a gap between them, never moves.
  assert.deepEqual(settleRun([[0, 10, 10], [1, 10, 20], [2, 10, 10], [3, 10, 10]]), [10, 10, 10, 10]);
  assert.deepEqual(settleRun([[0, 10, 10], [1, 10, 20], [3, 10, 20], [4, 10, 10]]), [10, 10, 10, 10]);
  // Opposite directions are not one sustained change.
  assert.deepEqual(settleRun([[0, 10, 10], [1, 10, 20], [2, 10, 5]]), [10, 10, 10]);
  // Two consecutive hours at least 25% away apply on the second.
  assert.deepEqual(settleRun([[0, 10, 10], [1, 10, 13], [2, 10, 13]]), [10, 10, 13]);
  assert.deepEqual(settleRun([[0, 10, 8], [1, 10, 6], [2, 10, 6]]), [8, 8, 6]);
  // Reading twice in one hour is one window.
  assert.deepEqual(settleRun([[0, 10, 10], [1, 10, 13], [1, 40, 13]]), [10, 10, 10]);
});

test('a changed capacity is held at least two hours before it may change again [C7]', () => {
  // Changed at 02:10; both 03:10 and 04:05 readings want 30, but the hold runs to 04:10.
  assert.deepEqual(settleRun([[0, 10, 10], [1, 10, 13], [2, 10, 13], [3, 10, 30], [4, 5, 30]]), [10, 10, 13, 13, 13]);
  // The next consecutive window after the hold applies it.
  assert.deepEqual(settleRun([[0, 10, 10], [1, 10, 13], [2, 10, 13], [3, 10, 30], [4, 5, 30], [5, 10, 30]]), [10, 10, 13, 13, 13, 30]);
});
