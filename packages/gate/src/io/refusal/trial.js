/**
 * New or changed gate refusals run on trial: a refusal code that was not enforced when the list below was frozen, or
 * one registered as changed, only reports what it would refuse until it has seen enough real gates with no false
 * refusal, then enforces [C7]. Why: on 3 Nov three new gate rules each refused good work for hours once live (#2611).
 */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoInfo } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';

const fs = fileSystemAdapter();

/** Real gates a refusal on trial must see, with no false refusal recorded, before it enforces. */
export const CLEAN_GATES_TO_ENFORCE = 20;

/**
 * The refusal codes enforced on 3 Nov, generated from the source then and committed: any other code is new and starts
 * on trial by itself, with nothing for anyone to remember.
 */
export const ENFORCED_REFUSALS = Object.freeze(new Set(JSON.parse(fs.readFile(new URL('../../logic/refusals.json', import.meta.url), 'utf8')).codes));

/**
 * Enforced codes whose rule changed, mapped to the rule's content or its digest. Each distinct value starts a fresh trial.
 */
export const CHANGED_REFUSALS = Object.freeze({});

/** The machine-local trial ledger of this repository: real gates seen, and where each code's trial started. */
export function refusalTrialFile(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'refusal-trials.json');
}

/** Read the ledger; a missing or damaged one starts every trial over, which only keeps refusals in report mode. */
function readLedger(file) {
  try {
    const value = JSON.parse(fs.readFile(file, 'utf8'));
    return value?.version === 2 && Number.isSafeInteger(value.gates) && value.codes && typeof value.codes === 'object'
      ? value : { version: 2, gates: 0, codes: {} };
  } catch { return { version: 2, gates: 0, codes: {} }; }
}

/** Replace the ledger whole. */
function writeLedger(file, ledger) {
  fs.mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFile(temporary, JSON.stringify(ledger) + '\n', { mode: 0o600 });
  fs.rename(temporary, file);
}

/** Serialize read/replace operations across real gate processes with a private OS-released SQLite lock. */
function updateLedger(file, change) {
  fs.mkdir(dirname(file), { recursive: true });
  const lock = new DatabaseSync(`${file}.guard.sqlite`);
  try {
    lock.exec('PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE');
    const ledger = readLedger(file);
    const result = change(ledger);
    writeLedger(file, ledger);
    lock.exec('COMMIT');
    return result;
  } finally { lock.close(); }
}

/** Whether a code is on trial: changed since the list was frozen, or not on it at all. */
function onTrial(code, { enforced = ENFORCED_REFUSALS, changed = CHANGED_REFUSALS, rule } = {}) {
  return rule !== undefined || Object.hasOwn(changed, code) || !enforced.has(code);
}

/** Bind a trial to the actual changed-rule content supplied by its owner, not merely its refusal code. */
function ruleIdentity(code, { changed = CHANGED_REFUSALS, rule } = {}) {
  const content = rule ?? (Object.hasOwn(changed, code) ? changed[code] : null);
  return createHash('sha256').update(JSON.stringify([code, content])).digest('hex');
}

/**
 * The ledger row a trial lives in: the plain code for a code on trial by itself, the code plus the rule's identity for
 * a rule that supplies its own. Why: two gate rules may raise one code (MAIN_NOT_COMPOSED), and each must keep its own
 * trial instead of resetting the other's.
 */
export function trialLedgerKey(code, options = {}) {
  return options.rule === undefined && !Object.hasOwn(options.changed ?? CHANGED_REFUSALS, code)
    ? code : `${code}@${ruleIdentity(code, options).slice(0, 16)}`;
}

/**
 * A refusal's mode now, and the clean gates its trial has seen: report until CLEAN_GATES_TO_ENFORCE real gates have
 * passed since its trial started (its first appearance or its last false refusal), then enforce.
 */
export function refusalMode(root, code, options = {}) {
  if (!onTrial(code, options)) return { mode: 'enforce', clean: null };
  const ledger = readLedger(options.file ?? refusalTrialFile(root));
  const start = ledger.codes[trialLedgerKey(code, options)]?.start;
  const clean = start === undefined ? 0 : ledger.gates - start;
  return { mode: clean >= CLEAN_GATES_TO_ENFORCE ? 'enforce' : 'report', clean };
}

/**
 * Decide a refusal a gate rule raises: true to refuse now; false when the code is on trial, after writing the
 * "would refuse" line to the gate's output so the case can be judged. A code's trial starts the first time it fires.
 */
export function trialRefusal(root, code, message, say, options = {}) {
  const { mode, clean } = refusalMode(root, code, options);
  if (mode === 'enforce') return true;
  const file = options.file ?? refusalTrialFile(root);
  const identity = ruleIdentity(code, options);
  const key = trialLedgerKey(code, options);
  updateLedger(file, ledger => {
    if (ledger.codes[key]?.identity !== identity) ledger.codes[key] = { code, identity, start: ledger.gates, falseRefusals: 0 };
  });
  say(`would refuse ${code} (report-only, ${clean}/${CLEAN_GATES_TO_ENFORCE} clean gates): ${message}`);
  return false;
}

/**
 * Refuse as a gate rule does, through the trial: an enforced code throws its Refused, and a code on trial writes
 * "would refuse" to the gate's output and lets the gate go on. New gate rules refuse through this.
 */
export function gateRefuse(root, code, message, say, options = {}) {
  if (trialRefusal(root, code, message, say, options)) throw new Refused(code, message);
}

/** Machinery diagnostics are explicit; a test, identity, source or receipt refusal can never enter this adapter. */
const MACHINERY_CODES = Object.freeze({
  selection: new Set(['TEST_SELECTION_INCOMPLETE']),
  placement: new Set(['CELLS_PLAN_UNPLACED']),
  plan: new Set(['CELLS_SUBMIT']),
  doctrine: new Set(['RATCHET_ROSE']),
  composition: new Set(['MAIN_NOT_COMPOSED']),
});

/** Apply the trial only to a source-identified diagnostic from a machinery guard's own boundary. */
export function machineryRefusal(root, { kind, code, message, rule }, say, options = {}) {
  if (!Object.hasOwn(MACHINERY_CODES, kind) || !MACHINERY_CODES[kind].has(code) || typeof rule !== 'string' || !rule) throw new Refused(code, message);
  gateRefuse(root, code, message, say, { ...options, rule: [kind, rule] });
}

/** Keep integrity failures fatal while reporting a completed machinery check's diagnostic. */
export async function runMachineryGuard(root, work, { kind, rule, say, fallback, ...options }) {
  try { return await work(); }
  catch (error) {
    const identity = error?.machineryRule ?? rule;
    if (!(error instanceof Refused) || !Object.hasOwn(MACHINERY_CODES, kind) || !MACHINERY_CODES[kind].has(error.code) || typeof identity !== 'string' || !identity) throw error;
    if (trialRefusal(root, error.code, error.message, say, { ...options, rule: [kind, identity] })) throw error;
    return fallback;
  }
}

/** Count one real gate and return the lines the gate's output records, one per refusal on trial. */
export function countTrialGate(root, { file = refusalTrialFile(root), id } = {}) {
  return updateLedger(file, ledger => {
    const key = typeof id === 'string' && id ? createHash('sha256').update(id).digest('hex') : null;
    ledger.seen ??= {};
    if (key && Object.hasOwn(ledger.seen, key)) return [];
    if (key) ledger.seen[key] = true;
    ledger.gates += 1;
    return Object.entries(ledger.codes).map(([key, row]) => {
      const code = row.code ?? key, clean = ledger.gates - row.start;
      return `refusal trial ${code}: ${clean >= CLEAN_GATES_TO_ENFORCE ? 'enforce' : 'report'} (${Math.min(clean, CLEAN_GATES_TO_ENFORCE)}/${CLEAN_GATES_TO_ENFORCE} clean gates)`;
    });
  });
}

/** Record that a refusal on trial would have refused good work: its trial starts over, so it keeps reporting. */
export function recordFalseRefusal(root, code, { file = refusalTrialFile(root) } = {}) {
  updateLedger(file, ledger => {
    const keys = Object.keys(ledger.codes).filter(key => (ledger.codes[key].code ?? key) === code);
    if (!keys.length) keys.push(code);
    for (const key of keys) {
      const row = ledger.codes[key] ?? { falseRefusals: 0 };
      ledger.codes[key] = { ...row, code, identity: row.identity ?? ruleIdentity(code), start: ledger.gates, falseRefusals: row.falseRefusals + 1 };
    }
  });
}
