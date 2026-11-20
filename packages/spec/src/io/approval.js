/** Approval provenance: a status word is not a person's decision [S1,B26,P6]. */
import { fileSystemAdapter } from '../../../fs/index.js';
const disk = fileSystemAdapter();
import { join } from 'node:path';
import {
  gitReadSignature,
  tryGit,
} from '../../../git/index.js';
import { personNeeds } from '../logic/row/replacement.js';
import { Refused } from '../../../kernel/index.js';
import {
  loadSpec,
  readSignoffs,
} from './main.js';
import {
  isVerifiedSignoff,
  verifyRowDecision,
} from './signature.js';

const ORIGIN_CACHE_LIMIT = 32;
const originCache = new Map();

/**
 * Read each line's actual commit and Git author; neither identifies a person approval. Given lines, blame only
 * those lines: a whole-file blame of the spec took over a second on every show [C7].
 */
function rowOrigins(root, file, lines = null) {
  const signature = () => gitReadSignature(root, [file, '.mailmap'], { attribution: true });
  const before = signature();
  const key = before === null ? null : JSON.stringify([root, file, before, lines]);
  if (key !== null && originCache.has(key)) {
    const cached = originCache.get(key);
    originCache.delete(key);
    originCache.set(key, cached);
    return cached;
  }
  const ranges = (lines ?? []).flatMap(line => ['-L', `${line},${line}`]);
  const result = tryGit(root, ['blame', '--line-porcelain', ...ranges, '--', file]);
  const origins = new Map();
  let line;
  let commit;
  let author = '';
  let approvedAt = null;
  for (const text of (result.status === 0 ? result.stdout : '').split('\n')) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/u.exec(text);
    if (header) { commit = /^0+$/u.test(header[1]) ? null : header[1]; line = Number(header[2]); author = ''; approvedAt = null; }
    else if (text.startsWith('author ')) author = text.slice(7);
    else if (text.startsWith('committer-time ') && commit) {
      const date = new Date(Number(text.slice(15)) * 1000);
      approvedAt = Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    else if (text.startsWith('\t') && line) origins.set(line, { commit, approvedAt, agent: author || 'unknown', attribution: 'Git author, seat unknown' });
  }
  // Only origins are reused: live board decisions and signature trust are checked on every projection.
  if (key !== null && result.status === 0 && before === signature()) {
    originCache.set(key, origins);
    while (originCache.size > ORIGIN_CACHE_LIMIT) originCache.delete(originCache.keys().next().value);
  }
  return origins;
}

/** Match the exact current source, not just an id, a status word, or a Git author. */
function matchesApproval(record, current) {
  return record?.kind === 'spec' && record.id === current.row.id && record.file === current.file
    && record.decision === 'approve' && record.text === current.row.text && record.replacement === current.source;
}

/** Read trustworthy receipts; an expected proof refusal leaves rows unconfirmed, never approved. */
function approvalEvidence(root, evidenceErrors) {
  try { return readSignoffs(root).filter(record => record.type === 'row-decision' && isVerifiedSignoff(record)); }
  catch (error) {
    if (!(error instanceof Refused)) throw error;
    evidenceErrors.push({ code: error.code, message: error.message });
    return [];
  }
}

/** Check a board decision against local trust without making invalid proof block flag-mode work. */
function confirmedDecision(root, board, decision, evidenceErrors, verifiedPasskeyRowDecision) {
  if (verifiedPasskeyRowDecision(board, decision)) return true;
  try { verifyRowDecision(root, decision); return true; }
  catch (error) {
    if (!(error instanceof Refused)) throw error;
    evidenceErrors.push({ id: decision.id, code: error.code, message: error.message });
    return false;
  }
}

/** Capture the current approved source before setup commits or a legacy board's first ordered move. */
export function captureSpecApprovalBaseline(root, config) {
  const spec = loadSpec(root, config);
  const source = spec.exists === false ? [] : disk.readFile(join(root, config.spec), 'utf8').split(/\r?\n/u);
  const head = tryGit(root, ['rev-parse', '--verify', 'HEAD']);
  return { version: 1, file: config.spec, anchor: head.status === 0 ? head.stdout.trim() : null,
    rows: spec.rows.filter(row => row.status === 'approved').map(row => ({ id: row.id, text: row.text, source: source[row.line - 1] })) };
}

/**
 * Load one provenance view for a command; no observation here manufactures an approval event. With ids, the view
 * holds only those rows: a command about one item reads its cited rows' origins, never the whole spec's [C7].
 */
export function specApprovalState(root, { board, config, spec = loadSpec(root, config), ids = null }, { store, verifiedPasskeyRowDecision }) {
  const mode = config.specAgentApproval ?? 'flag';
  let baseline;
  let baselineInvalid = false;
  const evidenceErrors = [];
  try { baseline = store.specApprovalBaseline(board); }
  catch (error) {
    if (!(error instanceof Refused)) throw error;
    evidenceErrors.push({ code: error.code, message: error.message });
    baselineInvalid = true;
  }
  if (!baseline && !baselineInvalid) return { mode, baselinePending: true, evidenceErrors, rows: [] };
  if (spec.exists === false) return { mode, baselinePending: false, baselineInvalid, evidenceErrors, rows: [] };
  const source = disk.readFile(join(root, config.spec), 'utf8').split(/\r?\n/u);
  const decisions = store.rowDecisions(board).filter(record => record.kind === 'spec' && record.file === config.spec);
  const signed = approvalEvidence(root, evidenceErrors);
  const wanted = ids ? new Set(ids) : null;
  const unconfirmed = spec.rows.filter(row => row.status === 'approved' && (!wanted || wanted.has(row.id))).filter(row => {
    const current = { row, file: config.spec, source: source[row.line - 1] };
    if (baseline?.file === current.file && baseline.rows.some(old => old.id === row.id && old.text === row.text && old.source === current.source)) return false;
    const decision = decisions.findLast(record => record.id === row.id);
    if (decision) {
      if (!matchesApproval(decision, current)) return true;
      return !confirmedDecision(root, board, decision, evidenceErrors, verifiedPasskeyRowDecision);
    }
    return !matchesApproval(signed.findLast(record => record.kind === 'spec' && record.file === config.spec && record.id === row.id), current);
  });
  const origins = unconfirmed.length ? rowOrigins(root, config.spec, wanted ? unconfirmed.map(row => row.line) : null) : new Map();
  return { mode, baselinePending: false, baselineInvalid, evidenceErrors, rows: unconfirmed.map(row => ({ id: row.id, text: row.text, gate: row.gate,
    status: 'agent-approved', ...(origins.get(row.line) ?? { commit: null, approvedAt: null, agent: 'unknown', attribution: 'Git author, seat unknown' }) })) };
}

/** The spec row ids a raw board item or an API item projection cites. */
export function itemSpecIds(item) {
  return item.specs ?? (item.item_spec_ids ?? '').split(',').filter(Boolean);
}

/** Current unconfirmed citations for a raw board item or an API item projection. */
export function itemAgentApprovals(item, approval) {
  const ids = new Set(itemSpecIds(item));
  return approval.rows.filter(row => ids.has(row.id));
}

/** Qualify engineering verification without suggesting the person's governing judgment was approved. */
export function agentApprovalLine(rows) {
  return rows.length ? `verified against agent-approved ${rows.map(row => row.id).join(', ')}` : '';
}

/** Keep item detail and whole-state approval fields identical without changing compact summaries. */
export function projectItemSpecApprovals(item, approval) {
  const rows = itemAgentApprovals(item, approval);
  return { ...item, agentApproved: rows, approvalQualification: agentApprovalLine(rows) };
}

/** Project current confirmation beside immutable items and their historical receipts. */
export function projectSpecApprovals(state, approval) {
  const byId = new Map(approval.rows.map(row => [row.id, row]));
  const projected = { ...state, specApprovalBaseline: { pending: approval.baselinePending === true, invalid: approval.baselineInvalid === true }, specApprovalEvidenceErrors: approval.evidenceErrors ?? [], spec: state.spec.map(row => ({ ...row, agentApproval: byId.has(row.id) ? { ...byId.get(row.id), mode: approval.mode } : null })),
    items: state.items?.map(item => projectItemSpecApprovals(item, approval)) };
  return { ...projected, needs: personNeeds(projected) };
}

/** An explicit refuse setting blocks unconfirmed citations; flag and allow always keep work moving. */
export function refuseAgentApprovedRows(root, { board, config, item }, ports) {
  if (config.specAgentApproval !== 'refuse') return;
  const rows = itemAgentApprovals(item, specApprovalState(root, { board, config, ids: itemSpecIds(item) }, ports));
  if (rows.length) throw new Refused('AGENT_APPROVAL_REQUIRED', `${rows.map(row => row.id).join(', ')} is agent-approved and spec.agentApproval is refuse; ask the coordinator to arrange confirmation or decline in the Spec view`);
}
