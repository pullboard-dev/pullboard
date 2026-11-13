/** @pullboard-world-pin: the docs clause reads the committed docs/api.md, where the Cost data's byModel and byLane rows are documented. */
/** The Cost data reports agent time by model and by lane, and its item rows carry item_lane, as docs/api.md says [#6871]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { costItems } from '../../../../packages/store/index.js';
import { costAnalytics } from '../../../../packages/stats/index.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

const ALPHA = FIXTURE_MODEL, BETA = FIXTURE_MODEL + ' two';
const presentation = model => ({ key: model.toLowerCase(), name: model, vendor: 'Fixture' });

test('[N26] clause 1: costAnalytics carries byModel and byLane agent-time totals, and its item rows carry item_lane [#6871]', t => {
  const dir = privateFixtureFiles('pullboard-cost-lanes-').root;
  const board = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  const coordinator = store.register(board, { lane: 'coordinator', path: dir });
  const alpha = store.register(board, { lane: 'core', path: join(dir, 'alpha'), model: ALPHA });
  const beta = store.register(board, { lane: 'view', path: join(dir, 'beta'), model: BETA });
  const verifier = store.register(board, { lane: 'review', path: join(dir, 'verifier'), model: ALPHA });
  const at = new Date('2026-10-30T12:00:00Z');
  const ids = [];
  // Two core items by Alpha (4 s and 2 s, the second sent back once), one view item by Beta (3 s).
  for (const [lane, builder, model, wallMs, returned] of [['core', alpha, ALPHA, 4000, false], ['core', alpha, ALPHA, 2000, true], ['view', beta, BETA, 3000, false]]) {
    const id = store.addItem(board, { by: coordinator, lane, title: `Lane ${ids.length}` });
    ids.push(id);
    logEvent(board, builder, 'submit', id, {}, at);
    if (returned) { logEvent(board, verifier, 'reject', id, {}, at); logEvent(board, builder, 'submit', id, {}, at); }
    logEvent(board, verifier, 'accept', id, {}, at);
    logEvent(board, builder, 'usage', null, { item: id, revision: 1, records: [{ model, wallMs, inputTokens: 10 }] }, at);
    logEvent(board, coordinator, 'merged', id, {}, at);
  }
  const rows = costItems(board, ids);
  assert.deepEqual(rows.map(row => row.item_lane).sort(), ['core', 'core', 'view'], 'the item rows the Cost read loads carry item_lane');
  const result = costAnalytics({ items: rows, agents: store.listAgents(board), events: store.events(board), window: 'today', now: new Date('2026-10-30T14:00:00Z'), timeZone: 'UTC', modelPresentation: presentation });
  assert.equal(result.totals.agentMs, 9000);
  assert.deepEqual(result.byLane.map(({ key, agentMs, sentBackMs, items, share }) => ({ key, agentMs, sentBackMs, items, share })), [
    { key: 'core', agentMs: 6000, sentBackMs: 2000, items: 2, share: 6000 / 9000 },
    { key: 'view', agentMs: 3000, sentBackMs: 0, items: 1, share: 3000 / 9000 },
  ]);
  assert.deepEqual(result.byModel.map(({ key, label, agentMs, sentBackMs, items }) => ({ key, label, agentMs, sentBackMs, items })), [
    { key: ALPHA.toLowerCase(), label: ALPHA, agentMs: 6000, sentBackMs: 2000, items: 2 },
    { key: BETA.toLowerCase(), label: BETA, agentMs: 3000, sentBackMs: 0, items: 1 },
  ]);
  assert.equal(result.byLane[0].sentBackShare, 2000 / 6000);
});

test('[N26] clause 1: docs/api.md documents byModel and byLane in the Cost data [#6871]', () => {
  const docs = readFileSync(new URL('../../../../docs/api.md', import.meta.url), 'utf8');
  const cost = docs.split('\n').find(line => line.includes('`costAnalytics`'));
  assert.ok(cost?.includes('`byModel`') && cost.includes('`byLane`'), 'the Cost paragraph names both rows');
});

// fixture-subject: addItem (cost analytics over items seeded through an in-memory board)
