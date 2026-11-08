/** Synthetic commits exercise the rejected-work event format, never gate execution [A5,B13]. */
import assert from 'node:assert/strict';
import * as store from '../src/board.js';
import { submitFixture } from './board-submit-fixture.js';

/** Record a real native inactive-return event with an aged fixture heartbeat and the complete observation fields. */
export function exerciseRejectedWorkFormat(board, { coordinator, reviewer }) {
  const builder = store.register(board, { lane: 'docs', path: '/unattended-format-builder' });
  const clock = board.clock;
  const now = new Date(clock.now().getTime() + 31 * 60_000);
  board.clock = { now: () => now };
  try {
    const id = store.addItem(board, { by: coordinator, lane: 'docs', title: 'Unattended reject format example' });
    store.claim(board, id, { agentId: builder, lane: 'docs', leaseMs: 60_000,
      freeze: () => ({ text: 'format-return', digest: 'format-return' }) });
    const commit = '9'.repeat(40);
    submitFixture(board, id, { agentId: builder, commit, tree: '8'.repeat(40) });
    store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', clause: 'format-return',
      note: 'The format example keeps the reviewer note.', head: commit, digest: 'format-return', policy: 'agents' });
    const rejection = store.events(board, { itemId: id }).findLast(event => event.event_kind === 'reject');
    const seat = store.listAgents(board).find(agent => agent.agent_id === builder);
    assert.notEqual(seat.presence, 'live', 'the fixture clock ages the heartbeat before this new rejection');
    const finding = { key: `REWORK_UNCLAIMED:item:${id}`, cause: 'REWORK_UNCLAIMED', item: id,
      subject: `#${id}`, title: 'rejected work needs another builder', since: rejection.event_at,
      why: 'the format example records its inactive builder', next: 'pullboard sentinel run --health-only',
      owner: { who: coordinator }, detail: { move: 'reject', rejection: rejection.event_id, builder, commit,
        reason: 'inactive', presence: seat.presence, heartbeatAt: seat.heartbeatAt, observedAt: now.toISOString() } };
    store.recordHealthFindings(board, { agentId: coordinator,
      observedRevision: store.events(board).at(-1).event_id, findings: [finding], returnRejected: true });
    const returned = store.events(board, { itemId: id }).findLast(event => event.event_kind === 'reject_returned');
    assert.equal(JSON.parse(returned.event_detail).reason, 'inactive');
    return builder;
  } finally { board.clock = clock; }
}
