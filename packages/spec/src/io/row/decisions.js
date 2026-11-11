/** Exact person row decisions and coordinator file application [B26,S18,S19]. */
import { answerFromText } from '../main.js';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import {
  loadSpec,
  parseSpec,
  SIGNOFFS_FILE,
} from '../main.js';
import {
  defaultPrincipal,
  hasSignerFile,
  signRowDecision,
  verifyRowDecision,
  verifySignedRecords,
  readRawRecords,
} from '../signature.js';
import { Refused } from '../../../../kernel/index.js';
import { rowDecisionReplacement } from '../../logic/row/replacement.js';
import { rowDecisionContext } from './stale.js';
import { staleRowDecision } from './stale.js';

/** Resolve qualified doctrine ids while bare ids continue to name the spec. */
function decisionRows(root, config, ids, { loadDoctrine }) {
  const spec = loadSpec(root, config);
  const doctrine = loadDoctrine(root, config);
  const lines = new Map();
  return ids.map((reference) => {
    const kind = reference.startsWith('doctrine:') ? 'doctrine' : 'spec';
    const id = kind === 'doctrine' ? reference.slice('doctrine:'.length) : reference;
    const parsed = kind === 'doctrine' ? doctrine.repo : spec;
    const matches = parsed.rows.filter((row) => row.id === id);
    if (matches.length !== 1) throw new Refused('NO_ROW', `${reference} names ${matches.length} repo rows; use one id from ${parsed.name}`);
    const file = kind === 'doctrine' ? doctrine.name : config.spec;
    if (!lines.has(file)) lines.set(file, readFileSync(join(root, file), 'utf8').split(/\r?\n/u));
    const source = lines.get(file)[matches[0].line - 1];
    return { kind, file, row: matches[0], source };
  });
}

/** Capture the complete original source row a passkey confirms, including gate and required SSH signer fields. */
export function shownDecisionRows(root, config, ids, { loadDoctrine }) {
  return decisionRows(root, config, ids, { loadDoctrine }).map(({ kind, row, source }) => ({ id: kind === 'doctrine' ? `doctrine:${row.id}` : row.id, text: row.text, source }));
}

/**
 * Capture all source text and signatures before recording any decision on the board. An answer to
 * a pending question is an approval of its answered text and carries no separate answer field: the
 * answer shown is read back from the signed source and text by decisionAnswer.
 */
export function prepareRowDecisions(root, config, { ids, decision, reason = '', text: proposedText, by, on, commit = '', note = '', sshSign = true, passkeyRequest }, { loadDoctrine }) {
  if (!ids.length) throw new Refused('USAGE', 'name rows: pullboard spec approve <ids> or spec decline <ids> --reason "why"');
  if (!['approve', 'decline'].includes(decision)) throw new Refused('ROW_DECISION', 'use pullboard spec approve or decline');
  if (decision === 'decline' && (!reason.trim() || /[\r\n|]/u.test(reason))) throw new Refused('ROW_DECISION', 'a decline needs a one-line reason without a field separator; use --reason "why"');
  if (proposedText !== undefined && (decision !== 'approve' || ids.length !== 1 || !proposedText.trim() || /[\r\n|]/u.test(proposedText))) throw new Refused('ROW_DECISION', 'approve one row with --text "exact one-line text", without a field separator');
  const signed = sshSign && decision === 'approve' && hasSignerFile(root);
  const principal = by ?? (signed ? defaultPrincipal(root) : 'person');
  return decisionRows(root, config, ids, { loadDoctrine }).map(({ kind, file, row, source }) => {
    const status = decision === 'approve' ? 'approved' : 'wont';
    const text = decision === 'approve' ? proposedText?.trim() ?? row.text : row.text;
    const replacement = rowDecisionReplacement(source, decision, text);
    const record = { ...(passkeyRequest ? { passkeyRequest } : {}), version: 1, type: 'row-decision', kind, file, id: row.id, source, replacement, text, decision, reason: decision === 'decline' ? reason.trim() : '', by: principal, on, commit, note };
    return signed ? signRowDecision(root, record) : record;
  });
}

/**
 * The pending answers the named spec rows carry, by id: each answer's signed text and the answer
 * read back from it. Why: an approve without --text approves the answered text, so a person who
 * answers a question and then approves it keeps their answer instead of the original default [S1,P6].
 *
 * @param {string} root
 * @param {any} config
 * @param {string[]} ids - The ids named to approve; doctrine ids carry no answer.
 * @param {any[]} records - The board's current row decisions.
 * @returns {Map<string, { text: string, answer: string }>}
 */
export function pendingAnswers(root, config, ids, records) {
  const { rows } = loadSpec(root, config);
  const context = rowDecisionContext(root, config);
  return new Map(ids.filter((id) => !id.startsWith('doctrine:')).flatMap((id) => {
    const matches = rows.filter((row) => row.id === id);
    const record = matches.length === 1 ? pendingRowDecision(records, matches[0], 'spec', context) : undefined;
    const answer = record ? decisionAnswer(record) : null;
    return answer === null ? [] : [[id, { text: record.text, answer }]];
  }));
}

/** Compare a decision with the current row, excluding inherited standard rows from file edits. */
export function pendingRowDecision(records, row, kind, context) {
  return records.find((record) => record.kind === kind && record.id === row.id && !record.applied
    && !staleRowDecision(record, context));
}

/**
 * The answer a decision gives a pending question, read back from the signed source row and the
 * signed text, or null for any other decision. A record's other fields, such as an unsigned
 * "answer" written into the board by hand, are never read [S19,P6].
 *
 * @param {any} record
 * @returns {string | null}
 */
export function decisionAnswer(record) {
  if (record.decision !== 'approve' || record.kind !== 'spec') return null;
  const [pending] = parseSpec(`## Decision\n${record.source}\n`).rows;
  return pending?.status === 'pending' ? answerFromText(pending.text, record.text) : null;
}

/** Name a pending decision: the answer it gives, or approved or declined. */
function decisionStage(record) {
  const answer = decisionAnswer(record);
  return answer !== null ? `answered ${answer}` : record.decision === 'approve' ? 'approved' : 'declined';
}

/** Add pending status to existing rows without replacing their current file-backed status. */
export function decisionProjection(records, input, kind, context) {
  const { decision: previous, staleDecision: oldStale, stage: oldStage, ...plain } = input;
  const row = previous || oldStale ? plain : input;
  const decision = pendingRowDecision(records, row, kind, context);
  if (decision) return {
    ...row,
    decision,
    stage: `${decisionStage(decision)}, pending apply`,
    ...(decision.decision === 'decline' ? { reason: decision.reason } : {}),
  };
  const pending = records.find(record => record.kind === kind && record.id === row.id && !record.applied);
  const stale = pending && staleRowDecision(pending, context);
  if (stale) return { ...row, staleDecision: stale, stage: `${stale.why}; ${stale.next}` };
  const appliedDecline = records.find((record) => record.kind === kind && record.id === row.id && record.applied
    && record.decision === 'decline' && row.status === 'wont' && row.text === record.text);
  return appliedDecline ? { ...row, reason: appliedDecline.reason } : row;
}

/** Decorate the shared API state so the cockpit receives the same pending decisions as spec show. */
export function projectRowDecisions(records, state) {
  if (!records.length) return state;
  const context = rowDecisionContext(state.root);
  return { ...state,
    spec: state.spec.map((row) => decisionProjection(records, row, 'spec', context)),
    practice: state.practice.map((row) => row.origin === 'standard' ? row : decisionProjection(records, row, 'doctrine', context)),
  };
}

/** Preserve parsed page metadata while projecting both file-backed row lists. */
export function rowDecisionView(root, config, records, spec, practice) {
  const context = rowDecisionContext(root, config);
  return { spec: { ...spec, rows: spec.rows.map(row => decisionProjection(records, row, 'spec', context)) },
    practice: { ...practice, rows: practice.rows.map(row => row.origin === 'standard' ? row : decisionProjection(records, row, 'doctrine', context)) } };
}

/**
 * The ids of blueprint questions answered by a hand edit to SPEC.md: a row that was pending with
 * its ". Choices: " list at the trunk tip and now differs in status or text, with no person row
 * decision for that exact status and text. The answer is the person's move alone (P6), so an
 * agent that edits the row instead is caught by spec check, the gate's first step.
 *
 * @param {any[]} before - The trunk tip's parsed SPEC.md rows.
 * @param {any[]} after - The working file's parsed rows.
 * @param {() => any[]} readDecisions - The board's row decisions, read only when a question changed.
 * @returns {string[]}
 */
export function handAnsweredQuestions(before, after, readDecisions) {
  const changed = before.filter((old) => old.status === 'pending' && old.text.includes('. Choices: ')).flatMap((old) => {
    const now = after.filter((row) => row.id === old.id);
    return now.length === 1 && (now[0].status !== old.status || now[0].text !== old.text) ? [now[0]] : [];
  });
  if (!changed.length) return [];
  const records = readDecisions();
  return changed.filter((row) => !records.some((record) => record.kind === 'spec' && record.id === row.id
    && record.text === row.text && row.status === (record.decision === 'approve' ? 'approved' : 'wont'))).map((row) => row.id);
}

/** Remove local index metadata while retaining the one canonical person receipt verbatim. */
function decisionReceipt({ event, at, applied, appliedAt, ...record }) { return record; }

/** Preflight every file and signature before an apply writes even its first byte. */
export function planRowApply(root, config, records, { passkeyDecision = () => false } = {}, { loadDoctrine }) {
  const pending = records.filter((record) => !record.applied);
  const files = new Map();
  for (const record of pending) {
    const verifiedPasskey = passkeyDecision(record);
    if (verifiedPasskey) verifySignedRecords(root, readRawRecords(root));
    else verifyRowDecision(root, record);
    const file = record.kind === 'spec' ? config.spec : loadDoctrine(root, config).name;
    const aliases = new Set(['DOCTRINE.md', 'PRACTICE.md']);
    if (file !== record.file && !(record.kind === 'doctrine' && aliases.has(file) && aliases.has(record.file))) throw new Refused('STALE_ROW_DECISION', `${record.id}'s file changed; ask the person to approve its current row again`);
    if (!files.has(file)) files.set(file, { file, before: readFileSync(join(root, file), 'utf8') });
    const change = files.get(file);
    const lines = (change.after ?? change.before).split('\n');
    const parsed = loadSpec(root, { ...config, spec: file });
    const matches = parsed.rows.filter((row) => row.id === record.id);
    if (verifiedPasskey && matches[0]?.signers?.length) throw new Refused('PERSON_SIGNER_REQUIRED', `${record.id} names its SSH signers ${matches[0].signers.join(', ')}`, 'a passkey does not claim any named SSH identity');
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
