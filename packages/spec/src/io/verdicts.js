/** Recorded outside-parent verdicts for known board-drafted spec rows [S1,V4,H16]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  lintSpec,
  parseSpec,
} from './main.js';
import { Refused } from '../../../kernel/index.js';
import { servesClosure } from '../logic/row/closure.js';
import {
  rowVerificationSource,
  verifiedRowSource,
} from '../logic/format.js';

/** Read immutable recorded parent/session identity without treating an unknown seat as independent. */
function recordedParent(board, id) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_parent_session:${id}`)?.meta_value
    ?? board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${id}`)?.meta_value;
}

/** Current receipts are native replay metadata, not a local projection cache. */
export function rowVerifications(board) {
  const raw = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='row_verifications'").get();
  return raw ? JSON.parse(raw.meta_value) : [];
}

/** Resolve the original exact draft, retaining its author after coordinator materialization. */
function rowAuthor(board, row, { rowDrafts }) {
  const drafts = rowDrafts(board).filter(draft => draft.id === row.id && (draft.target ?? 'spec') === 'spec'
    && !draft.revises && ['text', 'gate', 'tier'].every(key => (draft[key] ?? '') === (row[key] ?? '')));
  const authors = new Set(drafts.map(draft => draft.by));
  if (authors.size !== 1) throw new Refused('ROW_VERIFY_PROVENANCE', `${row.id} lacks one exact board-drafted author; draft the row through pullboard spec draft before verifying it`);
  return [...authors][0];
}

/** Validate real recorded identity on both axes; separate seat names alone never establish independence. */
function outsideParent(board, author, verifier) {
  const authorParent = recordedParent(board, author);
  const verifierParent = recordedParent(board, verifier);
  if (!authorParent || !verifierParent) throw new Refused('ROW_VERIFY_PROVENANCE', 'the row author and verifier need recorded parent sessions; join normally before verifying the row');
  if (authorParent === verifierParent) throw new Refused('ROW_VERIFY_SELF', 'the row verifier shares its author parent session; ask an outside-parent verifier to run pullboard spec verify');
}

/** Record an exact-row receipt under the authenticated operation actor, without writing a file. */
/**
 * Record a verifier's verdict on one spec row. With `cascade` (the spec's rows with their serves) given, which the caller passes only while spec.cascadeReject is on,
 * a rejection also writes one row_needs_review event for each row that serves the rejected one, naming it [C7,#9341].
 * Why events: needs-review is board data, never a SPEC.md status, so the approved status list stays as it is.
 */
export function recordRowVerification(board, { agentId, source, decision, reason, cascade }, { atomic, logEvent, rowDrafts, rowDecisions }) {
  if (typeof source !== 'string' || /[\r\n]/u.test(source) || !['accepted', 'rejected'].includes(decision)
    || typeof reason !== 'string' || !reason.trim() || /[\r\n|]/u.test(reason)) {
    throw new Refused('ROW_VERIFY', 'name one row, accepted or rejected and a one-line reason: pullboard spec verify <id> accepted --reason "why"');
  }
  return atomic(board, () => {
    const base = rowVerificationSource(source);
    const parsed = parseSpec(`## Verification\n${base}\n`);
    if (parsed.problems.length || parsed.rows.length !== 1 || parsed.rows[0].unknown.length || parsed.rows[0].verify !== undefined || lintSpec(parsed).some(finding => finding.level === 'error')) {
      throw new Refused('ROW_VERIFY', 'the verdict needs one exact spec row without malformed fields; run pullboard spec check first');
    }
    const row = parsed.rows[0];
    if (rowDecisions(board).some(record => record.kind === 'spec' && record.id === row.id && !record.applied)) {
      throw new Refused('ROW_VERIFY_PENDING', `${row.id} has a pending person decision; run pullboard spec apply before recording a verifier verdict`);
    }
    const author = rowAuthor(board, row, { rowDrafts });
    outsideParent(board, author, agentId);
    const record = { id: row.id, source: base, decision, reason: reason.trim(), by: agentId, author };
    logEvent(board, agentId, 'row_verification', null, { record });
    const entry = { ...record, event: board.lastEvent.event_id, at: board.lastEvent.event_at };
    const records = [...rowVerifications(board).filter(old => old.id !== row.id), entry];
    board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES ('row_verifications',?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value")
      .run(JSON.stringify(records));
    if (decision === 'rejected' && Array.isArray(cascade)) {
      for (const served of servesClosure({ rows: cascade }, row.id)) logEvent(board, agentId, 'row_needs_review', null, { id: served, because: row.id, verification: entry.event });
    }
    return entry;
  });
}

/** Reject fabricated, stale or same-parent file annotations against the current exact receipt. */
export function rowVerificationFindings(board, parsed, source, { rowDrafts }) {
  const lines = source.split(/\r?\n/u);
  const records = board ? rowVerifications(board) : [];
  return parsed.rows.filter(row => row.verify !== undefined).flatMap(row => {
    const record = records.find(candidate => candidate.id === row.id);
    let message;
    if (!record || lines[row.line - 1] !== verifiedRowSource(record)) message = 'ROW_VERIFY_RECEIPT: no matching exact-row verifier receipt; run pullboard spec verify before applying its verdict';
    else {
      try { outsideParent(board, rowAuthor(board, row, { rowDrafts }), record.by); }
      catch (error) { if (!(error instanceof Refused) || !['ROW_VERIFY_PROVENANCE', 'ROW_VERIFY_SELF'].includes(error.code)) throw error; message = `${error.code}: ${error.message}`; }
    }
    return message ? [{ level: 'error', line: row.line, id: row.id, message }] : [];
  });
}

/** Plan only matching current rows; stale verdicts never overwrite changed requirements or signed decisions. */
export function planRowVerificationApply(root, config, records, decisions) {
  const file = config.spec;
  const before = readFileSync(join(root, file), 'utf8');
  const parsed = parseSpec(before);
  const lines = before.split('\n');
  const applied = [];
  for (const record of records) {
    const rows = parsed.rows.filter(row => row.id === record.id);
    if (rows.length !== 1 || decisions.some(decision => !decision.applied && decision.kind === 'spec' && decision.id === record.id)) continue;
    const row = rows[0];
    const index = row.line - 1;
    const carriage = lines[index].endsWith('\r') ? '\r' : '';
    const current = carriage ? lines[index].slice(0, -1) : lines[index];
    if (rowVerificationSource(current) !== record.source) continue;
    const after = verifiedRowSource(record);
    if (current === after) continue;
    lines[index] = after + carriage;
    applied.push(record.id);
  }
  const after = lines.join('\n');
  return { applied, records: [], files: after === before ? [] : [{ file, before, after }], signoffs: { before: null, receipts: [] } };
}
