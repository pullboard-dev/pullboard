/** The verify move table run over the live board: the store's verify writer reads the verdict event and its automatic follow-ups from it [C7,#8272]. */
import { causeProblem } from "../../logic/board/rigor.js";
import { runVerifyTable } from "../../logic/board/landing/lease.js";
import { ACCEPT_REASON } from "../board.js";
import { REJECT_REASONS } from "../board.js";
import { itemPace } from "./sprint-pace.js";

/** The event kinds the table's rules read, as the history reader of the replay reads them. */
const KINDS = Object.freeze(['add', 'edit', 'claim', 'renew', 'release', 'submit', 'accept', 'reject', 'reopen', 'withdraw', 'merged', 'escalate',
  'hold_item', 'unhold_item', 'refreeze', 'reserve', 'bar-sharpen', 'strong-rejection-notice', 'fact']);

/** The id the board's next row in a table will take: its autoincrement sequence, which never reuses a deleted row's id. */
function nextId(db, table, column) {
  const sequence = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq;
  return (sequence ?? db.prepare(`SELECT COALESCE(MAX(${column}),0) m FROM ${table}`).get().m) + 1;
}

/** An event's detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

/**
 * Read what the verify table needs from the board for one item and actor: the item history, its verdicts, the actor seat's route and flake
 * observations, the sharpen setting and the next ids. Returns null when a record is damaged or the history and verdicts do not line up.
 * Why: these reads depend on no write of this verdict, so the command takes them before the write lock and the writer only decides [#10868].
 *
 * @returns {object | null} The facts, with the cheap guard value that says whether they are still current.
 */
export function readVerifyFacts(board, item, agentId, deps) {
  const { db } = board;
  const id = item.item_id;
  let sharpenToPerson = false;
  const setting = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('line_setting:bar.sharpenToPerson');
  if (setting) { try { sharpenToPerson = JSON.parse(setting.meta_value) === true; } catch { return null; } }
  const guard = factsGuard(board, id, agentId);
  const history = db.prepare(`SELECT event_id id, event_kind kind, event_by by, event_detail d FROM event WHERE item_id=? AND event_kind IN (${KINDS.map(() => '?').join(',')}) ORDER BY event_id`)
    .all(id, ...KINDS).map(e => ({ id: e.id, kind: e.kind, by: e.by, detail: detailOf(e.d) }));
  const verdicts = db.prepare('SELECT * FROM verdict WHERE item_id=? ORDER BY verdict_id').all(id).map(v => ({ id: v.verdict_id, item: v.item_id, by: v.verdict_by, decision: v.verdict_decision,
    reason: v.verdict_reason, note: v.verdict_note, commit: v.verdict_commit, digest: v.verdict_digest, head: v.verdict_head, family: v.verdict_verifier_family ?? null, at: v.verdict_at }));
  // The table pairs each accept or reject event with its verdict row in order; a board where they do not line up keeps the original rules.
  if (history.filter(e => e.kind === 'accept' || e.kind === 'reject').length !== verdicts.length) return null;
  const seat = db.prepare('SELECT agent_route FROM agent WHERE agent_id=?').get(agentId);
  const flakes = db.prepare("SELECT event_id id, event_detail d FROM event WHERE event_kind='flake-observation' AND event_by=? ORDER BY event_id").all(agentId).map(e => ({ id: e.id, detail: detailOf(e.d) }));
  return { itemId: id, agentId, guard, sharpenToPerson, history, verdicts, route: seat?.agent_route ?? 'strong', flakes, family: deps.seatFamily(board, agentId) ?? null,
    nextEventId: nextId(db, 'event', 'event_id'), nextVerdictId: nextId(db, 'verdict', 'verdict_id') };
}

/** The few values that change when anything the facts read changes: the item's newest event, the verdict sequence, the actor's newest flake, its route and the setting. */
function factsGuard(board, id, agentId) {
  const { db } = board;
  return JSON.stringify([db.prepare('SELECT MAX(event_id) m FROM event WHERE item_id=?').get(id).m,
    db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('verdict')?.seq ?? null,
    db.prepare("SELECT MAX(event_id) m FROM event WHERE event_kind='flake-observation' AND event_by=?").get(agentId).m,
    db.prepare('SELECT agent_route FROM agent WHERE agent_id=?').get(agentId)?.agent_route ?? null,
    db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('line_setting:bar.sharpenToPerson')?.meta_value ?? null]);
}

/**
 * The snapshot the verify table reads for one verdict: the item row, the facts read before the write lock, and the shell facts that hold once the writer's own checks pass.
 * A sprint item's snapshot carries `pace: 'sprint'`, read from the item row already loaded, so the table runs its sprint rows; a steady or strict item's carries no pace key.
 *
 * @param {any} board
 * @param {any} item - The item row before the move.
 * @param {object} call
 * @param {object} facts - From readVerifyFacts.
 * @param {object} deps
 * @returns {object}
 */
export function verifySnapshot(board, item, call, facts, deps) {
  const { sharpenToPerson, history, verdicts, flakes } = facts;
  const main = call.agentId === 'coordinator';
  const id = item.item_id;
  return { now: board.clock.now().toISOString(),
    actor: { id: call.agentId, joined: true, route: facts.route, family: facts.family },
    item: { id, status: item.item_status, merged: Boolean(item.item_merged_commit), commit: item.item_commit, frozenDigest: item.item_frozen_digest, frozen: item.item_frozen,
      route: item.item_route, lane: item.item_lane, builtBy: item.item_built_by, owner: item.item_owner, reviewBy: item.item_review_by ?? null, reviewUntil: item.item_review_until ?? null,
      effectiveHead: call.sourceAdvanceHead ?? null, outside: null },
    history, verdicts, knownItems: call.implies ?? [], actorFlakeObservations: flakes, nativeFlakeEngine: deps.nativeFlakeEngine, lineSettings: { sharpenToPerson },
    nextEventId: facts.nextEventId, nextVerdictId: facts.nextVerdictId,
    // The writer's own checks have all passed by now, so the command-side and board-side facts the table takes from the shell all hold.
    io: { isMain: main, mainRefusal: null, selfSession: false, staleAcceptance: item.item_status === 'verified', policyRefused: null, commitInHead: true, root: '/repo',
      missingCompanions: null, checkRefused: null, selectorGap: false, reviewHolderFresh: false },
    deferred: { environmentProblem: null, knownMainProblem: null, quarantineProblem: null, gateReceipt: null, companionWindow: null, authorProblem: null, requiredFamily: null,
      familyProblem: null, patchProblem: null, sandboxProblem: null, relaxation: call.relaxation ?? null, assurance: null, impliedFacts: null },
    // A sprint item runs the table under sprint, so its sprint rows apply; steady and strict carry no pace key, as before paces were read here.
    ...(itemPace(item) === 'sprint' ? { pace: 'sprint' } : {}) };
}

/**
 * Decide a verdict's events with the verify table, over the board as it stands before the move writes anything.
 * Why: one table decides the verdict event and its automatic hold, sharpen, escalation or notice, so the writer carries no second copy of those rules.
 * Returns null when the table does not model this call (an older engine, a damaged record, or a refusal the writer's own checks already ruled out):
 * the writer then keeps its original rules, so behaviour never changes.
 * `prepared` is the reads the command took before the write lock; it is used only while its guard still matches the board, else the reads run again here.
 *
 * @param {any} board
 * @param {any} item - The item row before the move.
 * @param {object} call - What the writer was handed, with `note` as given (before a relaxation line) and `relaxation` that line, if any.
 * @param {object} deps
 * @param {object} [prepared] - Facts from readVerifyFacts.
 * @returns {{ events: object[] } | null}
 */
export function verifyDecision(board, item, call, deps, prepared) {
  const at = board.executionEngineVersion;
  if (at === undefined || at < deps.from || at < board.enginePorts.pipelineCauseEngines().pipeline) return null;
  const id = item.item_id;
  const review = call.review;
  if (!review || typeof review.head !== 'string' || !item.item_built_by) return null;
  const current = prepared && prepared.itemId === id && prepared.agentId === call.agentId && prepared.guard === factsGuard(board, id, call.agentId);
  const facts = current ? prepared : readVerifyFacts(board, item, call.agentId, deps);
  if (!facts) return null;
  const snapshot = verifySnapshot(board, item, call, facts, deps);
  const main = call.agentId === 'coordinator';
  const accept = call.decision === 'ACCEPT';
  const move = { id, actor: call.agentId, decision: call.decision, ...(main ? { as: 'coordinator' } : {}), ...(accept ? {} : { reason: call.reason }), note: call.note,
    ...(call.cause !== undefined ? { cause: call.cause } : {}), ...(accept ? {} : { clause: call.clause }), head: call.head, digest: call.digest, review, sourceAdvanceHead: call.sourceAdvanceHead,
    ...(call.companionDigest ? { companionDigest: call.companionDigest } : {}), ...(call.environment !== undefined ? { environment: call.environment } : {}),
    ...(call.check !== undefined ? { check: call.check } : {}), ...(call.knownMainFailures !== undefined ? { knownMainFailures: call.knownMainFailures } : {}),
    ...(call.quarantineProofId !== undefined ? { quarantineProofId: call.quarantineProofId } : {}), ...(call.sandbox !== undefined ? { sandbox: call.sandbox } : {}),
    ...(call.implies ? { implies: call.implies } : {}) };
  const build = () => ({ acceptReason: ACCEPT_REASON, rejectReasons: REJECT_REASONS, wording: deps.wording, causeProblem, pipelineCause: deps.pipelineCause,
    frozenBar: (frozenText) => deps.frozenBar({ item_frozen: frozenText }), namedClause: (bar, quote) => deps.namedClause(bar, quote, true), strongNoticeEngine: deps.strongNoticeEngine });
  const answer = runVerifyTable(build, structuredClone(snapshot), structuredClone(move));
  return answer.refused ? null : { events: answer.events };
}

/**
 * Write what the table decided, in the order the table lists it, through the board's own writers.
 *
 * @returns {object} The verdict event the writer logged, which later steps read.
 */
export function applyVerdict(board, id, events, { logEvent, holdItem, shout, escalate }) {
  let trigger;
  for (const event of events) {
    const { kind, by, detail } = event;
    if (kind === 'accept' || kind === 'reject') trigger = logEvent(board, by, kind, id, detail);
    else if (kind === 'hold_item') holdItem(board, id, { agentId: by, reason: detail.reason });
    else if (kind === 'escalate') escalate(board, id, { agentId: by, note: detail.note, ...(detail.rejections ? { rejections: detail.rejections } : {}) });
    else if (kind === 'shout') shout(board, { from: by, to: detail.to, lanes: detail.lanes, ...(Object.hasOwn(detail, 'decision') ? { decision: detail.decision } : {}), text: detail.text });
    else logEvent(board, by, kind, id, detail);
  }
  return trigger;
}
