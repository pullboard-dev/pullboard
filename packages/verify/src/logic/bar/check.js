/** Claim-scoped bar check notes and reviewer answers [B29,B30,B31,H16]. */
import { validateKnownLineSetting } from '../../../../queue/light.js';
import { Refused } from '../../../../kernel/light.js';

const SETTING = 'bar.check';

/** Read the board's default-off bar.check line setting. */
export function barCheckEnabled(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`line_setting:${SETTING}`);
  if (!row) return false;
  let value;
  try { value = JSON.parse(row.meta_value); }
  catch { throw new Refused('LINE_SETTING_RANGE', 'the stored bar.check setting is malformed; restore its recorded board value before changing policy'); }
  validateKnownLineSetting(SETTING, value);
  return value === true;
}

/** Return the latest active claim, preserving its identity through lease renewals. */
function latestClaim(board, id) {
  return board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_kind='claim' ORDER BY event_id DESC LIMIT 1").get(id) ?? null;
}

/** Read facts only after the current claim and extract their typed payloads. */
function claimFacts(board, id, claimId) {
  if (!claimId) return [];
  return board.db.prepare("SELECT event_id,event_detail FROM event WHERE item_id=? AND event_kind='fact' AND event_id>? ORDER BY event_id")
    .all(id, claimId).map(event => ({ eventId: event.event_id, ...JSON.parse(event.event_detail) }));
}

/** Determine whether this item needs a bar check and whether its latest note has a peer answer. */
export function barCheckState(board, item) {
  const claim = latestClaim(board, item.item_id);
  const facts = claimFacts(board, item.item_id, claim?.event_id ?? null);
  const note = facts.filter(fact => fact.kind === 'bar-check' && fact.claimId === claim?.event_id).at(-1) ?? null;
  const answer = note ? facts.find(fact => fact.kind === 'bar-answer' && fact.claimId === claim.event_id && fact.answers === note.id) ?? null : null;
  const sentBack = Boolean(board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='reject' LIMIT 1").get(item.item_id));
  const required = Boolean(claim) && barCheckEnabled(board) && (['mid', 'strong'].includes(item.item_route) || sentBack);
  return { required, claimId: claim?.event_id ?? null, note, answer };
}

/** Describe the one-line submit warning when the current claim has no reviewer answer. */
export function barCheckWarning(board, item) {
  const state = barCheckState(board, item);
  if (!state.required || state.answer) return null;
  if (!state.note) return `bar.check for claim ${state.claimId ?? 'unknown'} has no builder note`;
  return `bar.check note ${state.note.id} has no reviewer answer`;
}

/** Parse the three labeled parts required in a builder's bar-check note. */
function validBarNote(text) {
  const sections = new Set();
  for (const line of String(text).split(/\r?\n/u)) {
    const label = /^\s*(bar|edge cases|test):\s*(.*)$/iu.exec(line);
    if (label && label[2].trim()) sections.add(label[1].toLowerCase());
  }
  return ['bar', 'edge cases', 'test'].every(section => sections.has(section));
}

/** Capture the current claim on builder notes and validate one cross-session answer to the latest note. */
export function barCheckFactFields(board, item, { agentId, kind, text, answers, supersedes }) {
  if (!['bar-check', 'bar-answer'].includes(kind)) {
    if (answers !== null) throw new Refused('USAGE', '--answers is only for bar-answer facts', 'use --answers only with pullboard fact <id> bar-answer "yes or what was missed" --answers <bar-check-fact-id>');
    return {};
  }
  if (supersedes !== null) throw new Refused('USAGE', 'bar-check notes and answers are append-only and do not supersede other facts', 'post a new bar-check note and answer that note with --answers <fact-id>');
  const claim = latestClaim(board, item.item_id);
  if (!claim || item.item_status !== 'claimed' || (item.item_lease_until ?? '') <= board.clock.now().toISOString()) {
    throw new Refused('NOT_YOURS', `#${item.item_id} needs a live claim before a bar check note or answer can be posted`, `claim #${item.item_id}, then post the bar-check note or answer`);
  }
  const facts = claimFacts(board, item.item_id, claim.event_id);
  const latestNote = facts.filter(fact => fact.kind === 'bar-check' && fact.claimId === claim.event_id).at(-1) ?? null;
  if (kind === 'bar-check') {
    if (item.item_owner !== agentId) throw new Refused('NOT_YOURS', `only the live builder ${item.item_owner} can post the bar-check note for #${item.item_id}`, `the live builder posts it with pullboard fact ${item.item_id} bar-check "bar: …\\nedge cases: …\\ntest: …"`);
    if (!validBarNote(text)) throw new Refused('USAGE', 'a bar-check note needs labeled nonempty parts: bar:, edge cases:, and test:', `post pullboard fact ${item.item_id} bar-check "bar: …\\nedge cases: …\\ntest: …"`);
    return { claimId: claim.event_id };
  }
  if (typeof answers !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(answers) || !latestNote || latestNote.id !== answers) {
    throw new Refused('NO_FACT', `answer the latest bar-check note for claim ${claim.event_id}; read pullboard show ${item.item_id} --history`, `read the latest bar-check note with pullboard show ${item.item_id} --history, then name its id with --answers <fact-id>`);
  }
  const existing = facts.find(fact => fact.kind === 'bar-answer' && fact.claimId === claim.event_id && fact.answers === answers);
  if (existing) throw new Refused('FACT_JUDGEMENT', `bar-check note ${answers} already has its one reviewer answer`, `the builder can post a new bar-check note if the bar changed`);
  if (typeof text !== 'string' || !text.trim()) throw new Refused('EMPTY_FACT', 'a bar-check answer needs “yes” or what the bar check missed');
  const builderSession = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${item.item_owner}`)?.meta_value;
  const reviewerSession = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${agentId}`)?.meta_value;
  if (!builderSession || !reviewerSession) throw new Refused('BAR_PARENT_UNKNOWN', 'bar-check authors need registered runtime session identities; join from each real session before posting', 'join from each real runtime session, then retry the bar-check answer');
  if (builderSession === reviewerSession) throw new Refused('BAR_SELF_SIGN', 'the builder and reviewer must be different runtime sessions', 'ask a reviewer from another runtime session to answer the bar-check note');
  return { claimId: claim.event_id, answers };
}
