/** The ruling-effect vocabulary and its validation: pure, so a read that projects decisions loads no spec shell [D1,N26,C7]. */
import { Refused } from '../../../kernel/browser.js';

const ROW_ID = /^(?:doctrine:)?[A-Za-z][A-Za-z0-9._-]{0,79}$/u;
const STATUSES = new Set(['approved', 'draft', 'pending', 'fact', 'wont', 'retired']);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PRIORITY = { agent: 0, coordinator: 1, person: 2 };

/** Closed public vocabulary; each concrete target is validated before a request can be routed. */
export const RULING_EFFECT_OPERATIONS = Object.freeze([
  'implement-row', 'revise-row', 'approve-row',
  'withdraw', 'merged', 'applyRowDecisions',
  'recordLandingWaiver',
]);

/** Refuse an incomplete declaration with a concrete step, without echoing supplied values. */
function invalid(message) {
  throw new Refused('RULING_EFFECT', message + '; name a supported operation and its exact target');
}

/** Accept data records only, including prototype-free JSON decoders; never invoke field getters. */
function record(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => Object.hasOwn(field, 'value')));
}

/** A target identifier names an existing native numeric identity, not a free-form description. */
function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Check exact own fields; caller-supplied owner, status, actor and mode aliases are not accepted. */
function fields(effect, required, optional = []) {
  if (required.some(key => !Object.hasOwn(effect, key))
    || Reflect.ownKeys(effect).some(key => ![...required, ...optional].includes(key))) {
    invalid('the effect has missing or unsupported fields');
  }
}

/** Read each qualified row once; the native caller remains responsible for snapshot consistency. */
function resolveRow(reference, readRow, cache) {
  if (typeof reference !== 'string' || !ROW_ID.test(reference)) invalid('the effect needs one exact spec or doctrine row id');
  if (cache.has(reference)) return cache.get(reference);
  // A missing reader is an integration error, never permission to trust an input status.
  if (typeof readRow !== 'function') throw new TypeError('rulingOwner needs the native readRow callback for row effects');
  const row = readRow(reference);
  const bare = reference.replace(/^doctrine:/u, '');
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.id !== bare || !STATUSES.has(row.status)) {
    throw new Refused('RULING_ROW', 'the referenced row is unavailable or has an unsupported status; reload the authoritative spec and doctrine');
  }
  const observed = { id: reference, status: row.status };
  cache.set(reference, observed);
  return observed;
}

/** Normalize one specific effect and compute its minimum routing owner, without executing its operation. */
function effectOwner(effect, readRow, cache, normalizeOnly = false) {
  if (!record(effect) || !RULING_EFFECT_OPERATIONS.includes(effect.op)) invalid('the effect needs a supported operation');
  const op = effect.op;
  if (['implement-row', 'revise-row', 'approve-row'].includes(op)) {
    fields(effect, ['op', 'row']);
    if (typeof effect.row !== 'string' || !ROW_ID.test(effect.row)) invalid('the effect needs one exact spec or doctrine row id');
    if (normalizeOnly) return { effect: { op, row: effect.row } };
    const row = resolveRow(effect.row, readRow, cache);
    if (op === 'implement-row' && row.status !== 'approved') {
      throw new Refused('RULING_ROW', 'implement-row needs an unchanged approved row; declare approve-row or revise-row when its governing decision must change');
    }
    return { effect: { op, row: row.id }, owner: op === 'implement-row' ? 'agent' : 'person',
      reason: op === 'implement-row' ? 'implements an approved row without revising it' : 'changes or approves a governing row' };
  }
  if (['withdraw', 'merged'].includes(op)) {
    fields(effect, op === 'merged' ? ['op', 'item', 'commit'] : ['op', 'item']);
    if (!positiveId(effect.item) || op === 'merged' && (typeof effect.commit !== 'string' || !SHA.test(effect.commit))) {
      invalid('the effect needs an exact item id and, for merged, its full commit id');
    }
    return { effect: { op, item: effect.item, ...(op === 'merged' ? { commit: effect.commit } : {}) },
      owner: 'coordinator', reason: 'requires the existing coordinator item move' };
  }
  if (op === 'applyRowDecisions') {
    fields(effect, ['op', 'events']);
    if (!Array.isArray(effect.events) || !effect.events.length || effect.events.length > 64 || effect.events.some(event => !positiveId(event))
      || new Set(effect.events).size !== effect.events.length) invalid('applyRowDecisions needs distinct decision event ids');
    return { effect: { op, events: [...effect.events] }, owner: 'coordinator',
      reason: 'applies already-recorded person decisions; it is not a new row approval' };
  }
  fields(effect, ['op', 'test']); // The only remaining supported operation is recordLandingWaiver.
  if (typeof effect.test !== 'string' || !effect.test.trim() || effect.test.trim() !== effect.test
    || effect.test.length > 4096 || /[\r\n\0]/u.test(effect.test) || effect.test.startsWith('/')
    || effect.test.includes('\\') || effect.test.split('/').some(part => !part || part === '.' || part === '..')) {
    invalid('recordLandingWaiver needs an exact test name or repository-relative test path');
  }
  return { effect: { op, test: effect.test }, owner: 'person', reason: 'requests an existing person-only landing waiver' };
}

/** Normalize declarations without manufacturing a row status; live ownership is computed separately. */
export function normalizeRulingEffects(effects) {
  return decisionsFor(effects, { normalizeOnly: true }).map(entry => entry.effect);
}

/** Validate a bounded closed declaration and reject duplicate or nonspecific outcomes. */
function decisionsFor(effects, { readRow, normalizeOnly = false } = {}) {
  if (!Array.isArray(effects) || !effects.length || effects.length > 64) {
    throw new Refused('RULING_EFFECTS', 'declare one to 64 specific row or supported move effects; an empty declaration does not establish agent authority');
  }
  const rows = new Map(), seen = new Set();
  return Array.from(effects, effect => {
    const decision = effectOwner(effect, readRow, rows, normalizeOnly);
    const key = JSON.stringify(decision.effect);
    if (seen.has(key)) invalid('the same effect is declared more than once');
    seen.add(key);
    return decision;
  });
}

/** Compute person > coordinator > agent using one trusted current row snapshot, never caller statuses. */
export function rulingOwner(effects, { readRow } = {}) {
  const decisions = decisionsFor(effects, { readRow });
  const owner = decisions.reduce((selected, decision) => PRIORITY[decision.owner] > PRIORITY[selected] ? decision.owner : selected, 'agent');
  return { owner, effects: decisions };
}
