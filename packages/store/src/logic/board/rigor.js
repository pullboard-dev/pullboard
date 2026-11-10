/**
 * Rigor: how errors become doctrine or specs. The first step is noticing a failure cause that
 * repeats [D1,V1]. A cause key comes only from structured fields, never from free-text notes,
 * because typed reasons almost never repeat word for word while structured causes do.
 */
import { COORDINATOR } from "../../../../config/index.js";
import { Refused } from "../../../../kernel/light.js";
import { HEALTH_SENTINEL_ENGINE } from "./receipts.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { NATIVE_FLAKE_ENGINE } from "../../../../state/light.js";
import {
  historyPathMap,
  mappedCause,
} from "../../../../codemap/index.js";
import {
  conflictCause,
  reopenConflictEvidence,
} from "../../../../items/light.js";

/** The kinds of cause key and their shapes, in the order help and refusals name them. */
export const CAUSE_FORMS = Object.freeze(['test:<file>::<title>', 'refusal:<CODE>', 'row:<id>', 'doctrine:<id>', 'sentinel:<name>', 'conflict:<file>', 'instruction:<kind>']);

const CAUSE = /^(?:test:(?<file>[^\s:][^\r\n:]*)::(?<title>\S[^\r\n]*)|refusal:(?<code>[A-Z][A-Z0-9_]*)|row:(?<row>[A-Z][A-Za-z0-9.]*)|doctrine:(?<doctrine>[A-Z][A-Za-z0-9.]*)|sentinel:(?<sentinel>[a-z0-9][a-z0-9._-]{0,63})|conflict:(?<conflict>[^\r\n\0]+)|instruction:(?:assignment|focus|freeze|merge-main|refreeze|routing))$/u;

/** Refusal codes that name a merge conflict: a collision between branches, never a repeated error. */
const CONFLICT_CODES = new Set(['MERGE_CONFLICT']);

/**
 * The refusal for a malformed cause key, or null when it is well formed or absent.
 *
 * @param {unknown} cause
 * @returns {Refused | null}
 */
export function causeProblem(cause) {
  if (cause === undefined || cause === null) return null;
  if (typeof cause === 'string' && CAUSE.test(cause) && cause === cause.trim()) return null;
  const given = typeof cause === 'string' ? (cause.trim() ? `"${cause}"` : 'an empty key') : `a ${typeof cause}`;
  return new Refused('BAD_CAUSE', `${given} is not a cause key; use one of ${CAUSE_FORMS.join(', ')}, for example --cause "refusal:MERGE_CONFLICT"`);
}

/**
 * Refuse a never-again fact that is not the person's or names no cause. Only the person, from the
 * main checkout's terminal or the view, marks a cause never-again.
 *
 * @param {number} id
 * @param {{ agentId: string, cause: string | null, neverAgain: boolean, asPerson: boolean, channel: string }} fact
 */
export function requireNeverAgain(id, { agentId, cause, neverAgain, asPerson, channel }) {
  const problem = neverAgainProblem(id, { agentId, cause, neverAgain, asPerson, channel });
  if (problem) throw problem;
}

/** The refusal for a never-again fact requireNeverAgain refuses, or null. */
function neverAgainProblem(id, { agentId, cause, neverAgain, asPerson, channel }) {
  if (!neverAgain || !asPerson || agentId !== COORDINATOR) return new Refused('RIGOR_PERSON_ONLY', `only the person marks a cause never-again, from the main checkout: pullboard fact ${id} root-cause "<why>" --cause <key> --never-again --as person`);
  if (!['terminal', 'view'].includes(channel)) return new Refused('B26_PERSON_CHANNEL', 'a never-again is the person’s; record it through the terminal or the view; run pullboard view');
  if (cause === null) return new Refused('BAD_CAUSE', `a never-again names its cause: --cause with one of ${CAUSE_FORMS.join(', ')}`);
  return causeProblem(cause);
}

/**
 * The cause key for one failing test.
 *
 * @param {{ file: string, name: string }} test
 * @returns {string}
 */
export function testCause({ file, name }) {
  return `test:${file}::${String(name).trim()}`;
}

/**
 * True when a cause names a merge conflict. A landing records a conflict as a "test" whose name
 * says so; a reviewer can name the conflict refusal. Either way, two branches touching the same
 * lines is not an error anyone can make a rule against, so rigor never counts it.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isMergeConflict(key) {
  if (key.startsWith('conflict:')) return true;
  const parts = CAUSE.exec(key)?.groups;
  if (!parts) return false;
  if (parts.code) return CONFLICT_CODES.has(parts.code);
  return Boolean(parts.title && /^(?:merge )?conflicts? with\b/iu.test(parts.title));
}

/**
 * How a cause reads: a doctrine row or a refusal is about how the work is done (work), a spec row
 * is about what the product must do (product), and a failing test can be either (both), so the
 * person picks.
 *
 * @param {string} key
 * @returns {'work' | 'product' | 'both'}
 */
export function causeReading(key) {
  if (key.startsWith('doctrine:') || key.startsWith('refusal:')) return 'work';
  if (key.startsWith('row:') || key.startsWith('instruction:')) return 'product';
  return 'both';
}

/**
 * The cause keys a reject, reopen or allocated sentinel failure receipt carries. A move recorded with --cause names its key;
 * a reopen after a red landing names its failing tests in structured fields, so those give keys
 * even for events recorded before cause keys existed. Only exact historical conflict-note syntax
 * is reclassified; original event bytes and workflow authority remain unchanged.
 *
 * @param {{ event_kind: string, event_detail: string, event_by?: string }} event
 * @returns {string[]}
 */
export function eventCauses(event) {
  if (!['reject', 'reopen', 'health-failure', 'sentinel-failure', 'flake-observation'].includes(event.event_kind)) return [];
  const detail = JSON.parse(event.event_detail);
  if (event.event_kind === 'flake-observation') return detail.engine === NATIVE_FLAKE_ENGINE && detail.observation?.classification === 'flake'
    ? [testCause(detail.observation)] : [];
  if (event.event_kind === 'health-failure' && (event.event_by !== 'sentinel' || detail.engine !== HEALTH_SENTINEL_ENGINE)) return [];
  if (event.event_kind === 'sentinel-failure' && (event.event_by !== 'sentinel' || detail.engine !== BOARD_SENTINEL_ENGINE)) return [];
  const conflict = event.event_kind === 'reopen' ? reopenConflictEvidence(detail) : null;
  if (conflict) return conflictCause(conflict.files).causes;
  const keys = [];
  if (typeof detail.cause === 'string' && !causeProblem(detail.cause)) keys.push(detail.cause);
  if (Array.isArray(detail.causes)) for (const cause of detail.causes) {
    if (typeof cause === 'string' && !causeProblem(cause) && !keys.includes(cause)) keys.push(cause);
  }
  const tests = Array.isArray(detail.landingFailure?.tests) ? detail.landingFailure.tests : [];
  for (const test of tests) {
    if (typeof test?.file !== 'string' || typeof test?.name !== 'string' || !test.name.trim()) continue;
    const key = testCause(test);
    if (!causeProblem(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The person's never-again: a fact the person recorded with a cause and marked never-again. It
 * lists at once, without waiting for a second failure.
 *
 * @param {{ event_kind: string, event_by: string, event_detail: string }} event
 * @param {string} person
 * @returns {string | null}
 */
function neverAgainCause(event, person) {
  if (event.event_kind !== 'fact' || event.event_by !== person) return null;
  const detail = JSON.parse(event.event_detail);
  return detail.neverAgain === true && typeof detail.cause === 'string' && !causeProblem(detail.cause) ? detail.cause : null;
}

/**
 * Every cause that repeated: on 2 items, or on 1 item at 2 different commits, or named never-again
 * by the person. Merge conflicts never list. Read-only: it reads the event log and changes nothing.
 *
 * @param {any[]} events - the board's event log, oldest first
 * @param {{ person: string }} who
 * @returns {{ causes: { key: string, reads: string, items: { id: number, commits: string[] }[], occurrences: number, neverAgain: boolean }[], uncaused: number }}
 */
export function rigorReport(events, { person, root }) {
  const map = root ? historyPathMap(root) : new Map();
  const byKey = new Map();
  let uncaused = 0;
  /** The running record for one cause key. */
  const entry = (key) => {
    key = mappedCause(map, key);
    if (!byKey.has(key)) byKey.set(key, { key, reads: causeReading(key), items: new Map(), occurrences: 0, healthOccurrences: 0, flakeOccurrences: 0, neverAgain: false });
    return byKey.get(key);
  };
  for (const event of events) {
    if (event.event_kind === 'health-failure'
      && (event.event_by !== 'sentinel' || JSON.parse(event.event_detail)?.engine !== HEALTH_SENTINEL_ENGINE)) continue;
    if (event.event_kind === 'sentinel-failure'
      && (event.event_by !== 'sentinel' || JSON.parse(event.event_detail)?.engine !== BOARD_SENTINEL_ENGINE)) continue;
    if (event.event_kind === 'flake-observation' && (JSON.parse(event.event_detail)?.engine !== NATIVE_FLAKE_ENGINE
        || JSON.parse(event.event_detail)?.observation?.classification !== 'flake')) continue;
    const never = neverAgainCause(event, person);
    if (never && !isMergeConflict(never)) {
      const found = entry(never);
      found.neverAgain = true;
      if (event.item_id !== null && !found.items.has(event.item_id)) found.items.set(event.item_id, new Set());
      continue;
    }
    if (!['reject', 'reopen', 'health-failure', 'sentinel-failure', 'flake-observation'].includes(event.event_kind)) continue;
    const keys = eventCauses(event);
    if (!keys.length) {
      uncaused += 1;
      continue;
    }
    const commit = JSON.parse(event.event_detail).commit ?? null;
    for (const key of new Set(keys.filter((candidate) => !isMergeConflict(candidate)).map(candidate => mappedCause(map, candidate)))) {
      const found = entry(key);
      found.occurrences += 1;
      if (event.event_kind === 'flake-observation') found.flakeOccurrences += 1;
      if (['health-failure', 'sentinel-failure'].includes(event.event_kind)) found.healthOccurrences += 1;
      if (event.item_id === null) continue;
      const commits = found.items.get(event.item_id) ?? new Set();
      if (commit) commits.add(commit);
      found.items.set(event.item_id, commits);
    }
  }
  const causes = [...byKey.values()]
    .filter(found => found.neverAgain || found.healthOccurrences >= 2 || found.flakeOccurrences >= 2 || found.items.size >= 2 || [...found.items.values()].some(commits => commits.size >= 2))
    .map((found) => ({ key: found.key, reads: found.reads, occurrences: found.occurrences, neverAgain: found.neverAgain,
      items: [...found.items].map(([id, commits]) => ({ id, commits: [...commits] })).sort((a, b) => a.id - b.id) }))
    .sort((a, b) => Number(b.neverAgain) - Number(a.neverAgain) || b.items.length - a.items.length || b.occurrences - a.occurrences || a.key.localeCompare(b.key));
  return { causes, uncaused };
}

/**
 * The report as lines a person reads: one line per repeated cause with its items and how it reads.
 *
 * @param {ReturnType<typeof rigorReport>} report
 * @returns {string[]}
 */
export function rigorLines({ causes, uncaused }) {
  const lines = causes.length
    ? causes.map((cause) => {
      const items = cause.items.map((item) => `#${item.id}${item.commits.length > 1 ? ` (${item.commits.length} commits)` : ''}`).join(', ');
      return `${cause.key}  reads as ${cause.reads}  ${cause.neverAgain ? 'never again (the person)' : `${cause.occurrences} failures`}  items ${items || 'none'}`;
    })
    : ['no failure cause has repeated'];
  // The uncaused count always prints, so a reader sees how much of the history rigor cannot read.
  lines.push(`${uncaused} rejects and reopens carry no cause key; name one with --cause <key> (${CAUSE_FORMS.join(', ')})`);
  return lines;
}
