/** The board's four shared counts, one function each, that every page reads (#7310) [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsAtWork } from '../../src/logic/counts.js';
import { boardCounts } from '../../src/logic/counts.js';
import { rulingsWaiting } from '../../src/logic/counts.js';
import { runnersReporting } from '../../src/logic/counts.js';
import { sentBackRecent } from '../../src/logic/counts.js';
import { SENT_BACK_KINDS } from '../../src/logic/counts.js';

const now = Date.parse('2026-11-14T06:00:00Z');
const ago = minutes => new Date(now - minutes * 60_000).toISOString();

test('view.x-counts.clause-1-agents-at-work-are-claim: clause 1: agents at work are claim holders and reviewers, and builders of sent-back or in-review work who moved in the last hour [N26]', () => {
  const project = {
    agents: [
      { agent_id: 'view-1', lastMoveAt: ago(300) }, // holds a claim: at work however long ago it moved
      { agent_id: 'view-2', lastMoveAt: ago(200) }, // reviews a submission
      { agent_id: 'view-3', lastMoveAt: ago(10) }, // built a sent-back item, moved 10 minutes ago
      { agent_id: 'view-4', lastMoveAt: ago(120) }, // built a sent-back item, quiet for two hours
      { agent_id: 'view-5', lastMoveAt: ago(1) }, // joined, no work
    ],
    items: [
      { id: 1, status: 'claimed', claim: { by: 'view-1' } },
      { id: 2, status: 'submitted', claim: { by: 'view-2' }, builtBy: 'view-9' },
      { id: 3, status: 'open', builtBy: 'view-3', verdict: { decision: 'REJECT' } },
      { id: 4, status: 'open', builtBy: 'view-4', verdict: { decision: 'REJECT' } },
      { id: 5, status: 'withdrawn', claim: { by: 'view-5' } },
    ],
  };
  assert.deepEqual(agentsAtWork(project, now), ['view-1', 'view-2', 'view-3']);
  assert.deepEqual(agentsAtWork({ agents: [], items: [] }, now), [], 'a fresh board has no agent at work');
});

test('view.x-counts.clause-1-runners-are-the-rows-of: clause 1: runners are the rows of the runner card, 0 when none reports [N26]', () => {
  assert.equal(runnersReporting({ dashboardRunners: { runners: [{ runner: 1 }, { runner: 2 }], runs: [] } }), 2);
  assert.equal(runnersReporting({ dashboardRunners: null }), 0);
  assert.equal(runnersReporting({}), 0);
});

test('view.x-counts.clause-2-rulings-are-the-calls-only: clause 2: rulings are the calls only the person can make, the list the top bar opens [N26]', () => {
  assert.equal(rulingsWaiting({ needs: [{ kind: 'decision' }, { kind: 'draft' }, { kind: 'hold' }] }), 3);
  assert.equal(rulingsWaiting({}), 0);
});

test('view.x-counts.clause-3-sent-back-is-every-reject: clause 3: sent back is every reject or reopen over four hours, and its share of the verdicts [N26]', () => {
  assert.deepEqual(SENT_BACK_KINDS, ['reject', 'reopen']);
  assert.deepEqual(sentBackRecent({ dashboardRecent: { sentBack: 1, accepted: 3 } }), { count: 1, verdicts: 4, share: 0.25, hours: 4 });
  assert.deepEqual(sentBackRecent({ dashboardRecent: { sentBack: 0, accepted: 0 } }), { count: 0, verdicts: 0, share: 0, hours: 4 }, 'no verdict reads 0, never a dash');
  assert.deepEqual(sentBackRecent({}), { count: 0, verdicts: 0, share: 0, hours: 4 });
});

test('view.x-counts.the-board-counts-gather-the-four-functions: the board counts gather the four functions from one state [N26]', () => {
  const project = { agents: [{ agent_id: 'core-1', lastMoveAt: ago(1) }], items: [{ id: 1, status: 'claimed', claim: { by: 'core-1' } }],
    dashboardRunners: { runners: [{ runner: 1 }] }, needs: [{ kind: 'decision' }], dashboardRecent: { sentBack: 2, accepted: 2 } };
  assert.deepEqual(boardCounts(project, now), { agents: 1, agentIds: ['core-1'], joined: 1, runners: 1, rulings: 1, sentBack: { count: 2, verdicts: 4, share: 0.5, hours: 4 },
    landed: { total: 0, last4h: 0, last24h: 0 }, ready: 0, blocked: 0 });
});
