/** Exact person row decisions and coordinator file application [B26,S18,S19]. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadDoctrine } from './doctrine.js';
import { loadSpec, SIGNOFFS_FILE } from './spec.js';
import { defaultPrincipal, hasSignerFile, signRowDecision, verifyRowDecision } from './signature.js';
import { Refused } from './refused.js';

/** Resolve qualified doctrine ids while bare ids continue to name the spec. */
function decisionRows(root, config, ids) {
  const spec = loadSpec(root, config);
  const doctrine = loadDoctrine(root, config);
  return ids.map((reference) => {
    const kind = reference.startsWith('doctrine:') ? 'doctrine' : 'spec';
    const id = kind === 'doctrine' ? reference.slice('doctrine:'.length) : reference;
    const parsed = kind === 'doctrine' ? doctrine.repo : spec;
    const matches = parsed.rows.filter((row) => row.id === id);
    if (matches.length !== 1) throw new Refused('NO_ROW', `${reference} names ${matches.length} repo rows; use one id from ${parsed.name}`);
    const file = kind === 'doctrine' ? doctrine.name : config.spec;
    const source = readFileSync(join(root, file), 'utf8').split(/\r?\n/u)[matches[0].line - 1];
    return { kind, file, row: matches[0], source };
  });
}

/** Capture all source text and signatures before recording any decision on the board. */
export function prepareRowDecisions(root, config, { ids, decision, reason = '', text: proposedText, by, on, commit = '' }) {
  if (!ids.length) throw new Refused('USAGE', 'name rows: pullboard spec approve <ids> or spec decline <ids> --reason "why"');
  if (!['approve', 'decline'].includes(decision)) throw new Refused('ROW_DECISION', 'use pullboard spec approve or decline');
  if (decision === 'decline' && (!reason.trim() || /[\r\n|]/u.test(reason))) throw new Refused('ROW_DECISION', 'a decline needs a one-line reason without a field separator; use --reason "why"');
  if (proposedText !== undefined && (decision !== 'approve' || ids.length !== 1 || !proposedText.trim() || /[\r\n|]/u.test(proposedText))) throw new Refused('ROW_DECISION', 'approve one row with --text "exact one-line text", without a field separator');
  const signed = decision === 'approve' && hasSignerFile(root);
  const principal = by ?? (signed ? defaultPrincipal(root) : 'person');
  return decisionRows(root, config, ids).map(({ kind, file, row, source }) => {
    const status = decision === 'approve' ? 'approved' : 'wont';
    const text = decision === 'approve' ? proposedText?.trim() ?? row.text : reason.trim();
    const replacement = source.replace(/\[([a-z]+)(,\s*[a-z]+)?\]/u, (_, old, tier = '') => `[${status}${tier}]`)
      .replace(/(\]\s+)([^|]*)(?=\s*\||$)/u, (_, prefix, old) => `${prefix}${text}${old.match(/\s+$/u)?.[0] ?? ''}`);
    const record = { version: 1, type: 'row-decision', kind, file, id: row.id, source, replacement, text, decision, reason: decision === 'decline' ? reason.trim() : '', by: principal, on, commit, note: '' };
    return signed ? signRowDecision(root, record) : record;
  });
}

/** Compare a decision with the current row, excluding inherited standard rows from file edits. */
export function pendingRowDecision(records, row, kind) {
  return records.find((record) => record.kind === kind && record.id === row.id && !record.applied
    && (row.text === record.text || row.text === record.source.match(/\]\s+([^|]*)(?:\||$)/u)?.[1]?.trim()));
}

/** Add pending status to existing rows without replacing their current file-backed status. */
export function decisionProjection(records, row, kind) {
  const decision = pendingRowDecision(records, row, kind);
  return decision ? { ...row, decision, stage: `${decision.decision === 'approve' ? 'approved' : 'declined'}, pending apply` } : row;
}

/** Decorate the shared API state so the cockpit receives the same pending decisions as spec show. */
export function projectRowDecisions(records, state) {
  return { ...state,
    spec: state.spec.map((row) => decisionProjection(records, row, 'spec')),
    practice: state.practice.map((row) => row.origin === 'standard' ? row : decisionProjection(records, row, 'doctrine')),
  };
}

/** Remove local index metadata while retaining the one canonical person receipt verbatim. */
function decisionReceipt({ event, at, applied, appliedAt, ...record }) { return record; }

/** Preflight every file and signature before an apply writes even its first byte. */
export function planRowApply(root, config, records) {
  const pending = records.filter((record) => !record.applied);
  const files = new Map();
  for (const record of pending) {
    verifyRowDecision(root, record);
    const file = record.kind === 'spec' ? config.spec : loadDoctrine(root, config).name;
    const aliases = new Set(['DOCTRINE.md', 'PRACTICE.md']);
    if (file !== record.file && !(record.kind === 'doctrine' && aliases.has(file) && aliases.has(record.file))) throw new Refused('STALE_ROW_DECISION', `${record.id}'s file changed; ask the person to approve its current row again`);
    if (!files.has(file)) files.set(file, { file, before: readFileSync(join(root, file), 'utf8') });
    const change = files.get(file);
    const lines = (change.after ?? change.before).split('\n');
    const parsed = loadSpec(root, { ...config, spec: file });
    const matches = parsed.rows.filter((row) => row.id === record.id);
    const index = matches.length === 1 ? matches[0].line - 1 : -1;
    const source = index < 0 ? '' : lines[index].replace(/\r$/u, '');
    if (source !== record.source && source !== record.replacement) throw new Refused('STALE_ROW_DECISION', `${record.id}'s exact row changed after the person's decision; ask the person to approve its current text again`);
    lines[index] = `${record.replacement}${lines[index].endsWith('\r') ? '\r' : ''}`;
    change.after = lines.join('\n');
  }
  const signoffPath = join(root, SIGNOFFS_FILE);
  const before = existsSync(signoffPath) ? readFileSync(signoffPath, 'utf8') : null;
  const previous = before?.split('\n').filter(Boolean).map(JSON.parse) ?? [];
  const receipts = pending.filter((record) => record.signature).map(decisionReceipt)
    .filter((record) => !previous.some((old) => old.signature === record.signature));
  return { records: pending, files: [...files.values()].filter((file) => file.after !== file.before), signoffs: { before, receipts } };
}

/** Apply preflighted file changes, restoring earlier writes if a later filesystem write fails. */
export function writeRowApply(root, plan) {
  const written = [];
  try {
    for (const file of plan.files) {
      writeFileSync(join(root, file.file), file.after);
      written.push(file);
    }
    if (plan.signoffs.receipts.length) {
      const file = join(root, SIGNOFFS_FILE);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${plan.signoffs.before && !plan.signoffs.before.endsWith('\n') ? '\n' : ''}${plan.signoffs.receipts.map((record) => JSON.stringify(record)).join('\n')}\n`);
    }
  } catch (error) {
    restoreRowApply(root, { ...plan, files: written });
    throw error;
  }
}

/** Undo this apply's file writes when its board move or a later filesystem operation refuses. */
export function restoreRowApply(root, plan) {
  for (const file of [...plan.files].reverse()) writeFileSync(join(root, file.file), file.before);
  if (!plan.signoffs.receipts.length) return;
  const file = join(root, SIGNOFFS_FILE);
  if (plan.signoffs.before === null) rmSync(file, { force: true });
  else writeFileSync(file, plan.signoffs.before);
}
