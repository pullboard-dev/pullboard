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
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureOpenBoard } from '../../tests/fixtures/testkit.js';

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
  // @pullboard-board-file journey: reads the board the HTTP API serves
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

/** ISO time on the seeded day. */
const iso = (time) => `2026-10-12T${time}Z`;

/** Seed claim, submit, release and merged events for two seats and one coordinator landing. */
function seedSeats(db) {
  const insert = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  const put = (at, by, kind, item) => insert.run(at, by, kind, item, '{}');
  put('2026-10-11T08:00:00.000Z', 'core-2', 'claim', 5);
  put(iso('09:10:00.000'), 'core-1', 'claim', 1);
  put(iso('09:20:00.000'), 'core-1', 'claim', 2);
  put(iso('09:30:00.000'), 'core-2', 'claim', 4);
  put(iso('09:40:00.000'), 'core-2', 'submit', 5);
  put(iso('09:45:00.000'), 'coordinator', 'merged', 5);
  put(iso('09:50:00.000'), 'core-1', 'submit', 1);
  put(iso('10:00:00.000'), 'coordinator', 'merged', 1);
  put(iso('10:05:00.000'), 'core-1', 'submit', 2);
  put(iso('10:30:00.000'), 'core-1', 'claim', 3);
  put(iso('10:40:00.000'), 'core-1', 'release', 3);
  put(iso('11:10:00.000'), 'coordinator', 'merged', 2);
  put(iso('11:20:00.000'), 'coordinator', 'merged', 99);
  put(iso('12:30:00.000'), 'core-1', 'claim', 7);
}

test('stats agents: seeded claims, submits and merges give exact per-seat counts, rates and most held [C7,#6136]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite'), web: box.repo });
  try { seedSeats(board.db); } finally { closeBoard(board); }
  const result = await box.runLocal(box.web, 'stats', 'agents', '--window', '24h', '--until', '2026-10-12T12:00:00Z', '--json');
  assert.equal(result.code, 0, result.stderr);
  const { agents } = JSON.parse(result.stdout);
  assert.deepEqual(agents, {
    window: { from: '2026-10-11T12:00:00.000Z', until: iso('12:00:00.000'), hours: 24 },
    seats: [
      { seat: 'core-1', claims: 3, submits: 2, landings: 2, claimsPerHour: 0.13, submitsPerHour: 0.08, landingsPerHour: 0.08, maxHeld: 2,
        hours: [
          { hour: iso('09:00:00.000'), claims: 2, submits: 1, landings: 0 },
          { hour: iso('10:00:00.000'), claims: 1, submits: 1, landings: 1 },
          { hour: iso('11:00:00.000'), claims: 0, submits: 0, landings: 1 },
        ] },
      { seat: 'core-2', claims: 1, submits: 1, landings: 1, claimsPerHour: 0.04, submitsPerHour: 0.04, landingsPerHour: 0.04, maxHeld: 2,
        hours: [{ hour: iso('09:00:00.000'), claims: 1, submits: 1, landings: 1 }] },
    ],
    unattributedLandings: 1,
  });
  const text = await box.runLocal(box.web, 'stats', 'agents', '--until', '2026-10-12T12:00:00Z');
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /core-1: claimed 3 \(0\.13\/h\), submitted 2 \(0\.08\/h\), landed 2 \(0\.08\/h\), most held 2/u);
});
