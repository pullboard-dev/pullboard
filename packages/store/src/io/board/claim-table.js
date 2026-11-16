/** The claim and renew move table run over the live board: the store's claim writer reads the table's answer beside its own guards [C7,#8270]. */
import { randomUUID } from 'node:crypto';
import { runClaimTable } from '../../logic/board/landing/lease.js';
import { awaitingGateOrReview } from '../submit/handoff/records.js';
import { pendingSubmitHandoff } from '../submit/handoff/records.js';
import { lightDiagnosisProblem } from '../../logic/item/diagnosis.js';
import { firstRefusal } from '../../logic/board/item/lookup.js';
import { seatGone } from '../presence.js';
import { itemById } from './query.js';
import { laneHold } from './query.js';

const KINDS = Object.freeze(['add', 'edit', 'claim', 'renew', 'release', 'submit', 'accept', 'reject', 'reopen', 'withdraw', 'merged', 'escalate',
  'hold_item', 'unhold_item', 'refreeze', 'reserve', 'reject_returned', 'submit_handoff_returned', 'submit-handoff']);

/** An event's detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** An item's `after` list as ids. */
const afterOf = (row) => String(row?.item_after ?? '').split(',').filter(Boolean).map(Number).filter(Number.isInteger);

/** What a claim looks like to the table for one item row. */
function itemView(board, row) {
  const outside = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`outside_source:${row.item_id}`)?.meta_value ?? '';
  return { id: row.item_id, status: row.item_status, owner: row.item_owner, leaseUntil: row.item_lease_until, lane: row.item_lane, route: row.item_route,
    after: afterOf(row), parentId: row.item_parent_id, holdReason: row.item_hold_reason ?? null, frozenDigest: row.item_frozen_digest ?? null,
    expectedMinutes: row.item_expected_build_minutes ?? null,
    builtBy: row.item_built_by ?? null, verdict: row.item_verdict ?? null, outside: outside.includes('pull-request') ? 'pull-request' : null,
    gateInFlight: Boolean(pendingSubmitHandoff(board, row)), diagnosed: lightDiagnosisProblem(board, row, 'light') === null, returnedRework: false };
}

/**
 * Run the claim table for a claim or renewal over the board as it stands before any write.
 * Why: the writer's own guards and the table must give one answer, and this is how the writer shows it; the shell inputs the table takes (the freeze, the seat cap, the policy refresh) come from the writer's plan.
 *
 * @param {object} board
 * @param {number} id
 * @param {object} call - The claim options and the writer's plan, `{ options, plan }`.
 * @returns {{ refused?: object, patch?: object, events?: object[], via?: string[] }}
 */
export function claimDecision(board, id, { options, plan }) {
  const { db } = board;
  const { agentId, head = null, reviewSkipped = null, buildBudgetMinutes = 30, gateWaits = null } = options;
  const row = itemById(board, id);
  const seat = db.prepare('SELECT agent_lane, agent_route FROM agent WHERE agent_id=?').get(agentId);
  const waits = detailWaits(db, id);
  const deps = {};
  for (const dep of [...afterOf(row), ...waits]) {
    const found = itemById(board, dep);
    if (found?.item_id !== undefined) deps[dep] = { status: found.item_status, lane: found.item_lane, merged: Boolean(found.item_merged_commit), leaseUntil: found.item_lease_until, gateInFlight: Boolean(pendingSubmitHandoff(board, found)) };
  }
  const now = board.clock.now().toISOString();
  const actorClaims = db.prepare("SELECT * FROM item WHERE item_owner=? AND item_status='claimed' ORDER BY item_id").all(agentId)
    .map(mine => ({ id: mine.item_id, leaseUntil: mine.item_lease_until, parentId: mine.item_parent_id, verdict: mine.item_verdict ?? null, builtBy: mine.item_built_by ?? null,
      awaitingGateOrReview: Array.isArray(gateWaits) ? gateWaits.includes(mine.item_id) : awaitingGateOrReview(board, itemById(board, mine.item_id)) }));
  const history = db.prepare(`SELECT event_id id, event_at at, event_kind kind, event_by by, event_detail d FROM event WHERE item_id=? AND event_kind IN (${KINDS.map(() => '?').join(',')}) ORDER BY event_id`)
    .all(id, ...KINDS).map(e => ({ id: e.id, at: e.at, kind: e.kind, by: e.by, detail: detailOf(e.d) }));
  const hold = laneHold(board, row.item_lane);
  const window = firstRefusal(board, id);
  const frozen = plan.frozen();
  const refresh = plan.policyRefreeze();
  const seatN = plan.seatN();
  const snapshot = { now, actor: { id: agentId, lane: seat?.agent_lane, route: seat?.agent_route ?? null, joined: Boolean(seat) }, item: itemView(board, row), items: deps,
    claimWaiting: waits, laneHold: hold ? { by: hold.hold_by, reason: hold.hold_reason } : null, actorClaims, history, usedExitKeys: [],
    io: { checkoutOwner: null, coordinatorPaths: [], provesNothing: null, reworkWindows: null, exitCeiling: null, ledgerWritable: true, sessionCap: null, foreignBlocker: null,
      builderGone: Boolean(window && !window.otherSeatFirst && window.builder !== agentId && seatGone(board, window.builder)), buildBudgetMinutes,
      policyRefresh: plan.refreshes ? (refresh ? { before: refresh.before, after: refresh.after, changed: refresh.changed } : { unnamed: true }) : null,
      seatCap: seatN === null ? null : { n: seatN, how: 'sealed into the claim' },
      freeze: frozen ?? { text: row.item_frozen, digest: row.item_frozen_digest }, head, autoNextSnapshot: options.autoNextSnapshot ?? null },
    deferred: { barProblem: null, lineCapacity: null, reworkRouting: plan.reworkRouting()?.applies ? { applies: true } : null, exitContinuation: null,
      submitAdmission: plan.admission ?? null, submitOutcome: plan.outcome ?? null } };
  const move = { id, actor: agentId, leaseMs: options.leaseMs, itemFolder: options.itemFolder === true, autoNext: options.autoNext === true, reviewSkipped,
    adoptCorrection: plan.adopts === true, routeCap: options.routeCap ?? null, exitRules: options.exitRules ?? null, exitClaimKey: options.exitClaimKey, factId: randomUUID() };
  return runClaimTable(snapshot, move);
}

/** The ids a released claim still waits on, as the board stored them. */
function detailWaits(db, id) {
  try {
    const waits = JSON.parse(db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`claim_waiting:${id}`)?.meta_value ?? '[]');
    return Array.isArray(waits) ? waits.filter(Number.isInteger) : [];
  } catch { return []; }
}
