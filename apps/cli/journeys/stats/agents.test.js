/** Proof counts and active flow include registered agent seats, not board actors [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { openBoard } from '../../../lib/index.js';
import {
  closeBoard,
  events,
  register,
} from '../../../../packages/store/index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import {
  counterProofStats,
  rebuildProofCounters,
} from '../../../../packages/verify/index.js';
import { apiHttpBox } from '../../tests/fixtures/api.js';

test('rigor drafts and sentinel runs do not count as agent seats [N26]', t => {
  const at = '2026-10-28T12:00:00.000Z';
  const board = openBoard(':memory:', { now: () => new Date(at) });
  t.after(() => closeBoard(board));
  register(board, { lane: 'coordinator', path: '/stats/coordinator' });
  register(board, { lane: 'core', path: '/stats/core', family: 'codex' });
  register(board, { lane: 'sentinel', path: '/stats/sentinel-seat', family: 'codex' });
  const read = (cached, since) => proofStats(board, { now: Date.parse(at), since }, { events, counterProofStats: cached ? counterProofStats : () => null });
  rebuildProofCounters(board);
  const baseline = read(true);
  assert.equal(baseline.agentCount, 2);
  assert.equal(baseline.flow.activeAgents.total, 2);
  const insert = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  insert.run(at, 'rigor', 'draft', null, '{}');
  insert.run(at, 'sentinel', 'health-failure', null, '{}');
  rebuildProofCounters(board);
  for (const cached of [false, true]) {
    const actual = read(cached);
    assert.equal(actual.agentCount, baseline.agentCount);
    assert.deepEqual(actual.agents.map(agent => agent.id), ['core-1', 'sentinel-1']);
    assert.equal(actual.flow.activeAgents.total, baseline.flow.activeAgents.total);
    assert.deepEqual(actual.flow.activeAgents.agents.map(agent => agent.id), ['core-1', 'sentinel-1']);
    assert.deepEqual(actual.families, baseline.families);
    assert.equal(read(cached, '2026-10-28').agentCount, 2);
  }
});

test('API cached flow does not count board actors as active agents [N26]', async t => {
  const box = await apiHttpBox(t);
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    register(board, { lane: 'app', path: join(box.root, 'agent'), family: 'codex' });
    register(board, { lane: 'sentinel', path: join(box.root, 'sentinel-seat'), family: 'codex' });
    const insert = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
    const at = new Date().toISOString();
    insert.run(at, 'rigor', 'draft', null, '{}');
    insert.run(at, 'sentinel', 'health-failure', null, '{}');
    rebuildProofCounters(board);
  } finally { closeBoard(board); }
  for (let i = 0; i < 2; i++) {
    const result = await box.call(box.path + '/state');
    assert.equal(result.status, 200);
    const stats = result.document.state.proofStats;
    assert.equal(stats.agentCount, 2);
    assert.equal(stats.flow.activeAgents.total, 2);
    assert.deepEqual(stats.flow.activeAgents.agents.map(agent => agent.id), ['app-1', 'sentinel-1']);
  }
});
