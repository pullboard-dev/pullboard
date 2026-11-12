/** Native per-claim exit progress and atomic handoffs; no private transcript data is shared [B3,C7,N2]. */
import { createHash } from 'node:crypto';
import {
  atomic,
  logEvent,
} from "../../../io/board/event/log.js";
import { appendFact } from "../../../io/board/fact.js";
import { itemById } from "../../../io/board/query.js";
import { seatFamily } from "../../../../../items/index.js";
import {
  exitSessionIdentity,
  exitedSession,
  exitedSessionIdentity,
} from "./continuation.js";
export { exitedSession, exitContinuationSummary } from "./continuation.js";
import { exitRulesDecision } from "../../../../../stats/index.js";
import { exitRulesConfigProblems } from "../../../../../config/index.js";
import { EXIT_RULES_ENGINE } from "../../../../../state/index.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { Refused } from "../../../../../kernel/index.js";

/** Read one exact claim's immutable policy; renewals never grant a fresh budget. */
export function exitClaim(board, id, actor) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < EXIT_RULES_ENGINE) return null;
  const row = board.db.prepare("SELECT event_id,event_at,event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' ORDER BY event_id DESC LIMIT 1").get(id, actor);
  if (!row) return null;
  const detail = JSON.parse(row.event_detail), policy = detail.exitRules;
  return policy?.enabled === true ? { id: row.event_id, key: detail.exitClaimKey, at: row.event_at, policy } : null;
}

/** Read only shared numeric progress that the authenticated seat recorded for this exact claim. */
function progress(board, claim) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`exit-progress:${claim}`);
  return row ? JSON.parse(row.meta_value) : { tokens: null, calls: null };
}

/** Native callers publish known counters or explicit unknown; stale claim IDs can never buy a fresh budget. */
export function recordExitProgress(board, request) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < EXIT_RULES_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade every writer before recording exit-rule progress');
  const { agentId, item, claim, tokens, calls } = request ?? {};
  if (!request || Object.keys(request).some(key => !['agentId', 'item', 'claim', 'tokens', 'calls'].includes(key))
    || !Number.isSafeInteger(item) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(claim ?? '')
    || [tokens, calls].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0)))
    throw new Refused('EXIT_USAGE', 'exit progress requires exact claim identity and known numeric counters or explicit null');
  return atomic(board, () => {
    const held = itemById(board, item), current = exitClaim(board, item, agentId);
    if (held.item_status !== 'claimed' || held.item_owner !== agentId || current?.key !== claim)
      throw new Refused('NOT_YOURS', 'record exit progress only for your current native claim');
    const old = progress(board, claim);
    // Native capture precedes the checkout/board lock: a valid older capture may commit last.
    // Retain each proven high-water separately, while an unknown observation remains explicitly unknown.
    const highWater = Object.fromEntries(['tokens', 'calls'].map(key => {
      const prior = old.highWater?.[key] ?? old[key];
      const known = Number.isSafeInteger(prior) && prior >= 0 ? prior : null;
      return [key, request[key] === null ? known : known === null ? request[key] : Math.max(known, request[key])];
    }));
    const value = { tokens: tokens === null ? null : highWater.tokens,
      calls: calls === null ? null : highWater.calls, highWater };
    const decision = exitRulesDecision(current.policy, value);
    if (decision) board.db.prepare('INSERT OR IGNORE INTO board_meta(meta_key,meta_value) VALUES(?,?)')
      .run(`exit-stop:${claim}`, JSON.stringify(decision));
    if (JSON.stringify(old) === JSON.stringify(value)) return value;
    board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(`exit-progress:${claim}`, JSON.stringify(value));
    logEvent(board, agentId, 'exit-progress', item, { claim, ...value });
    return value;
  });
}

/** Exact consecutive native receipts after the claim, including intervening green receipts, govern repeat stops. */
export function exitClaimDecision(board, id, actor) {
  const claim = exitClaim(board, id, actor);
  if (!claim) return null;
  const stopped = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`exit-stop:${claim.key}`);
  if (stopped) return { ...JSON.parse(stopped.meta_value), item: id, claim: claim.key };
  const receipts = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind='proof-run' AND event_id>? ORDER BY event_id").all(id, actor, claim.id)
    .map(row => JSON.parse(row.event_detail).receipt).filter(Boolean);
  const decision = exitRulesDecision(claim.policy, progress(board, claim.key), receipts);
  return decision ? { ...decision, item: id, claim: claim.key } : null;
}

/** Validate a short structured summary, preserving source custody in the same transaction as release. */
export function releaseExitClaim(board, id, actor, note) {
  const decision = exitClaimDecision(board, id, actor);
  if (!decision) return null;
  const identity = exitSessionIdentity(board, actor), family = seatFamily(board, actor);
  if (!identity || !family) throw new Refused('EXIT_CONTINUATION', 'restore your native session and honest family binding before handing off this claim');
  const summary = typeof note === 'string' ? /^Done:\s*(.+?);\s*Failed:\s*(.+?);\s*Next:\s*(.+)$/isu.exec(note) : null;
  if (!summary || note.length > 4096 || summary.slice(1).some(value => !value.trim()))
    throw new Refused('EXIT_SUMMARY', 'release with --reason OTHER --note "Done: <work>; Failed: <case or none>; Next: <next step>" to retain the complete handoff');
  const item = itemById(board, id);
  if (item.item_status !== 'claimed' || item.item_owner !== actor) throw new Refused('NOT_YOURS', 'release only your current exit-rule claim');
  const at = board.clock.now().toISOString();
  const handoff = { agent: actor, session: identity, family, at, summary: note, ...decision };
  const put = board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES(?,?)');
  put.run(`exit-handoff:${id}`, JSON.stringify(handoff));
  put.run(`exit-session:${identity}`, JSON.stringify(handoff));
  appendFact(board, id, { agentId: actor, kind: 'note', text: note,
    factId: createHash('sha256').update(`${decision.claim}:${at}`).digest('hex') });
  return handoff;
}

/** Claim capture freezes only fully validated enabled policy, never mutable reader-local defaults. */
export function capturedExitRules(value) {
  if (value === undefined) return null;
  if (exitRulesConfigProblems(value).length) throw new Refused('BAD_CONFIG', 'restore valid exitRules enabled/tokens/calls configuration');
  return value.enabled ? { enabled: true, tokens: value.tokens, calls: value.calls } : null;
}

/** Every authenticated writer observes the same session fence and current claim counters. */
export function requireExitActive(board, actor, operation, args = []) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= EXIT_RULES_ENGINE && operation === 'register') {
    const stopped = exitedSessionIdentity(board, args[0]?.sessionDigest);
    if (stopped) throw new Refused(stopped.code, 'this native session already handed off its work; start a fresh same-family session instead of joining another seat');
  }
  if (!actor || (board.executionEngineVersion ?? ENGINE_VERSION) < EXIT_RULES_ENGINE
    || ['recordExitProgress', 'recordUsage', 'recordUsageBatch', 'release'].includes(operation)) return;
  const stopped = exitedSession(board, actor);
  if (stopped) throw new Refused(stopped.code, `this native session handed off #${stopped.item}; stop and let a fresh same-family seat continue`);
  const items = board.db.prepare("SELECT item_id FROM item WHERE item_status='claimed' AND item_owner=?").all(actor);
  for (const item of items) {
    const decision = exitClaimDecision(board, item.item_id, actor);
    if (decision) throw new Refused(decision.code,
      `session exit rule reached for #${item.item_id}; stop and release with --reason OTHER --note "Done: <work>; Failed: <case or none>; Next: <next step>"`);
  }
}
