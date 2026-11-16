/** Pipelined publish order: the batch that started first publishes first [C7,#8973]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publish } from '../../src/io/step/publish.js';
import { requirePublishTurn } from '../../src/io/step/publish.js';

const SHA = 'a'.repeat(40);

/** A hand-built batch record: only the fields the publish order reads. */
function record(id, startedAt, state = 'gating') {
  return { version: 1, id, state, startedAt, branch: 'refs/heads/main', base: SHA, tip: SHA, items: [], owner: 'coordinator' };
}

/** A state whose board answers landingBatches with these records, so publish reads them as the board would. */
function stateFor(batch, others, pipeline) {
  const rows = [batch, ...others].map(entry => ({ event_detail: JSON.stringify({ batch: entry }) }));
  return { batch, config: { landing: { pipeline } }, board: { db: { prepare: () => ({ all: () => rows }) } } };
}

const earlier = record('first', '2026-11-16T10:00:00.000Z');
const later = record('second', '2026-11-16T10:05:00.000Z');

test('clause 1: with landing.pipeline on and two batches in flight, the earlier-started batch publishes first [C7]', async () => {
  const state = stateFor(earlier, [later], true);
  assert.doesNotThrow(() => requirePublishTurn(state, earlier), 'the earlier batch has no earlier batch in flight');
  // publish passes the order check and fails later, on its own missing envelope, never with the order refusal.
  await assert.rejects(publish(state), error => !/still in flight/u.test(error.message));
});

test('clause 2: with landing.pipeline on, the later batch never publishes while the earlier one is in flight [C7]', async () => {
  for (const flying of ['merging', 'gating', 'ready', 'pushed']) {
    const state = stateFor(later, [record('first', earlier.startedAt, flying)], true);
    await assert.rejects(publish(state), error => error.code === 'LAND_MOVED' && /first started before second and is still in flight/u.test(error.message), flying);
  }
  const done = stateFor(later, [record('first', earlier.startedAt, 'landed')], true);
  assert.doesNotThrow(() => requirePublishTurn(done, later), 'once the earlier batch landed, the later one may publish');
});

test('clause 3: with landing.pipeline off the publish path is unchanged from main [C7]', async () => {
  const state = stateFor(later, [earlier], false);
  assert.doesNotThrow(() => requirePublishTurn(state, later), 'the order check does nothing with the pipeline off');
  await assert.rejects(publish(state), error => !/still in flight/u.test(error.message));
  const unset = stateFor(later, [earlier], undefined);
  assert.doesNotThrow(() => requirePublishTurn(unset, later), 'and nothing changes while the setting is unset');
});
