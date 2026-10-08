/** Read-only projection of older native snapshots; new uploads carry the actual API state [H5]. */
import { Refused } from '../src/refused.js';

/** Validate an authenticated snapshot and preserve its importable native tables. */
export function snapshotState(document, boardId) {
  const identity = document?.tables?.board_meta?.find(row => row.meta_key === 'board_id')?.meta_value;
  if (document?.version !== 1 || identity !== boardId) throw new Refused('RELAY_SNAPSHOT', 'This snapshot belongs to another board or version. Pair again from a linked machine.');
  if (document.presentation) return presentationState(document.presentation, boardId);
  const tables = document.tables;
  for (const name of ['item', 'agent', 'event', 'shout', 'verdict']) if (!Array.isArray(tables[name])) {
    throw new Refused('RELAY_SNAPSHOT', 'The board snapshot is incomplete. Refresh it from a linked machine.');
  }
  const log = tables.event;
  /** Map a native verdict to the local view's public presentation. */
  const verdict = row => ({ decision: row.verdict_decision, reason: row.verdict_reason, note: row.verdict_note, by: row.verdict_by, at: row.verdict_at, commit: row.verdict_commit });
  const statuses = new Map(tables.item.map(item => [item.item_id, item.item_status]));
  const shouts = tables.shout.slice(-40).reverse();
  const answered = new Set(tables.shout.filter(row => row.shout_answers !== null).map(row => row.shout_answers));
  const decisions = tables.shout.filter(row => row.shout_decision && !answered.has(row.shout_id));
  return {
    root: boardId, lanes: [...new Set(tables.agent.map(row => row.agent_lane))],
    owning: [...new Set(tables.item.map(row => row.item_lane))],
    items: tables.item.map(item => {
      const verdicts = tables.verdict.filter(row => row.item_id === item.item_id).map(verdict);
      return {
        id: item.item_id, title: item.item_title, lane: item.item_lane, status: item.item_status,
        route: item.item_route, owner: item.item_owner, reviewer: item.item_review_by,
        reviewUntil: item.item_review_until, builtBy: item.item_built_by, verifiedBy: item.item_verified_by,
        specs: item.item_spec_ids ? item.item_spec_ids.split(',') : [], criterion: item.item_criterion,
        brief: item.item_brief, commit: item.item_commit, merged: item.item_merged_commit,
        blockedBy: (item.item_after ? item.item_after.split(',').map(Number) : []).filter(id => statuses.get(id) !== 'verified'),
        updatedAt: item.item_updated_at, verdict: verdicts.at(-1) ?? null, verdicts,
        history: log.filter(event => event.item_id === item.item_id).map(event => ({ kind: event.event_kind, by: event.event_by, at: event.event_at })),
      };
    }),
    agents: tables.agent.map(agent => ({ ...agent, lastMoveAt: log.filter(event => event.event_by === agent.agent_id).at(-1)?.event_at ?? null })),
    shouts, decisions: decisions.filter(row => row.shout_to === 'person'), asked: decisions.filter(row => row.shout_to !== 'person'),
    events: log.slice(-80).reverse(), holds: tables.lane_hold ?? [], spec: [], practice: [], products: [], unseen: null,
  };
}

/** Accept only a complete API presentation, then use a board identity for device routing. */
export function presentationState(document, boardId) {
  const state = document?.state;
  if (document?.version !== 1 || !state || !['items', 'agents', 'shouts', 'decisions', 'asked', 'events', 'holds', 'spec', 'practice', 'lanes', 'owning'].every(key => Array.isArray(state[key]))) {
    throw new Refused('RELAY_PRESENTATION', 'This board presentation is unsupported. Refresh it from a linked machine.');
  }
  return { ...structuredClone(state), root: boardId };
}
