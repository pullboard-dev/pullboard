/** Identify the frozen requirement a rejection disputes and stop repeated unchanged rounds [V6,R2,B30,H16]. */
import { createHash } from 'node:crypto';
import { Refused } from './refused.js';
import { REJECT_CLAUSE_ENGINE } from './reject-clause-engine.js';
import { REOPEN_FIRST_REFUSAL_ENGINE } from './reopen-first-refusal-engine.js';
import { RIGOR_AUTO_ENGINE } from './rigor-auto-engine.js';
import { SPEC_APPROVAL_ENGINE } from './spec-approval-engine.js';
import { validateKnownLineSetting } from './queue-settings.js';

/** Normalize presentation whitespace without changing the quoted requirement's wording. */
function wording(value) { return String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' '); }

/** Extract semantic bar content, excluding a policy commit that can change during ordinary rebases. */
function frozenBar(item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen); }
  catch { return { criterion: wording(item.item_frozen), rows: [], check: '' }; }
  if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)) {
    return { criterion: wording(item.item_frozen), rows: [], check: '' };
  }
  return { criterion: wording(frozen.criterion), check: wording(frozen.check),
    rows: Array.isArray(frozen.rows) ? frozen.rows.map(row => ({ id: row.id, text: wording(row.text) })) : [] };
}

/** Resolve an unambiguous quotation to its containing requirement, so shorter quotes cannot reset a round. */
function namedClause(bar, quote) {
  const texts = [...new Set([bar.criterion, ...bar.rows.map(row => row.text)]
    .flatMap(text => [text, ...text.split(/(?<=[.!?])\s+/u)])
    .filter(text => text && text.includes(quote)))];
  const clauses = texts.filter(text => !texts.some(other => other !== text && text.includes(other)));
  return clauses.length === 1 ? clauses[0] : null;
}

/** A current reject must quote actual frozen criterion or row wording before any verdict is appended. */
export function rejectionClauseProblem(item, clause, engine) {
  if (engine < REJECT_CLAUSE_ENGINE) return null;
  if (typeof clause !== 'string' || !clause.trim()) return new Refused('BAR_CLAUSE_REQUIRED',
    'a reject names the failing frozen bar clause', 'add --clause "exact wording from the frozen criterion or spec row"');
  const quote = wording(clause);
  const bar = frozenBar(item);
  if (quote.length > 4096 || !namedClause(bar, quote)) {
    return new Refused('BAR_CLAUSE_UNKNOWN', 'the rejection quote does not identify one frozen bar clause',
      `read pullboard show ${item.item_id}, then quote the failing requirement with --clause`);
  }
  return null;
}

/** Bind the quoted clause to semantic frozen content while retaining the verdict's original digest separately. */
export function rejectionClauseDetail(item, clause, engine) {
  if (engine < REJECT_CLAUSE_ENGINE) return {};
  const bar = frozenBar(item);
  return { clause: wording(clause), clauseText: namedClause(bar, wording(clause)),
    barKey: createHash('sha256').update(JSON.stringify(bar)).digest('hex') };
}

/** Read the board's explicit person-routing policy; absent remains coordinator-only. */
function sharpensToPerson(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('line_setting:bar.sharpenToPerson');
  if (!row) return false;
  let value;
  try { value = JSON.parse(row.meta_value); }
  catch { throw new Refused('LINE_SETTING_RANGE', 'bar.sharpenToPerson is malformed; restore its recorded board value'); }
  validateKnownLineSetting('bar.sharpenToPerson', value);
  return value === true;
}

/** Hold the second same-bar, same-clause rejection and issue one durable clarification request atomically. */
export function sharpenRepeatedClause(board, item, detail, { holdItem, shout, logEvent }) {
  if (!detail.clause) return;
  const bar = frozenBar(item);
  const history = board.db.prepare("SELECT event_kind,event_detail FROM event WHERE item_id=? AND event_kind IN ('reject','bar-sharpen') ORDER BY event_id")
    .all(item.item_id).map(event => ({ kind: event.event_kind, ...JSON.parse(event.event_detail) }))
    .filter(event => event.barKey === detail.barKey && namedClause(bar, event.clause ?? '') === detail.clauseText);
  if (history.filter(event => event.kind === 'reject').length !== 2 || history.some(event => event.kind === 'bar-sharpen')) return;
  const to = sharpensToPerson(board) ? 'person' : 'coordinator';
  const reason = `The bar needs sharpening after two rejects of: ${detail.clauseText}`;
  holdItem(board, item.item_id, { agentId: 'coordinator', reason });
  logEvent(board, 'coordinator', 'bar-sharpen', item.item_id, { ...detail, to, digest: item.item_frozen_digest });
  shout(board, { from: to === 'person' ? 'coordinator' : 'sentinel', to, lanes: ['coordinator'], decision: to === 'person',
    text: `#${item.item_id} needs a sharper bar after two rejects of “${detail.clauseText}”. Clarify the criterion, refreeze it, and lift the item hold before another build round.` });
}

/** Complete an authorized verdict inside the caller's atomic boundary, preserving its exact writer/event order. */
export function finishVerdict(board, item, { id, isAccept, engine, reopenFirstRefusalMinutes,
  agentId, code, cause, clauseDetail, companionDigest, note, check, environment, sandbox, newReview,
  review, implies, impliesId, decision }, { firstRefusalDetail, deriveRigorCause, logEvent, holdItem,
  shout, tellFirstRefusal, persistShout, recordRejectedItemRoute, escalate, tellVerdictImplications,
  postRigorNotices, itemHold }) {
  const returnedAt = !isAccept && engine >= REOPEN_FIRST_REFUSAL_ENGINE && reopenFirstRefusalMinutes > 0 && item.item_built_by ? board.clock.now() : undefined;
  const reservation = !isAccept && engine >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusalDetail(board, item, reopenFirstRefusalMinutes, returnedAt) : {};
  const derivedCause = !isAccept && engine >= RIGOR_AUTO_ENGINE
    ? deriveRigorCause(board, item, { cause, reason: code, agentId }) : !isAccept && cause != null ? { cause } : {};
  const detail = { ...reservation, reason: code, commit: item.item_commit, ...derivedCause, ...clauseDetail,
    ...(companionDigest ? { companionDigest } : {}) };
  if (isAccept && engine >= SPEC_APPROVAL_ENGINE) detail.note = note.trim();
  if (isAccept && check !== undefined) detail.check = check;
  if (environment !== undefined) detail.environment = environment;
  if (sandbox !== undefined) detail.sandbox = sandbox;
  if (newReview) detail.review = { commit: review.commit, ...(Object.hasOwn(review, 'head') ? { head: review.head } : {}), trunk: review.trunk, paths: [...review.paths] };
  const trigger = logEvent(board, agentId, verb, id, implies?.length ? { ...detail, implies } : detail, returnedAt);
  if (!isAccept) sharpenRepeatedClause(board, item, clauseDetail, { holdItem, shout, logEvent });
  tellFirstRefusal(board, item, reservation, persistShout);
  if (!isAccept) recordRejectedItemRoute(board, id, engine, item, { escalate, shout, logEvent });
  tellVerdictImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), id, { seed: impliesId, implies });
  if (!isAccept) postRigorNotices(board, trigger);
  return { decision, reason: code, ...(isAccept && check !== undefined ? { check } : {}),
    ...(clauseDetail.clause ? { clause: clauseDetail.clause, held: Boolean(itemHold(board, id)) } : {}) };
}
