/** The cached board build, its delta fingerprint and the JSON the API serves from it: moved out of the line-capped main.js, unchanged [A2,N26,C7]. */
import { createHash } from 'node:crypto';
import { WHOLE_STATE_DELTA_FIELDS } from '../logic/fields.js';
import { milestonePace } from '../logic/milestone-pace.js';
import { milestoneWithoutPace } from '../logic/milestone-pace.js';
import { finishedCounts } from './items.js';

/**
 * The two builders that need sibling-cell functions, given them by the caller: one cached board build, and that build with its idle
 * minutes current for an observed time.
 *
 * @param {{ itemSummary: Function, milestoneDeltaEnabled: Function, idleEntry: Function }} ports
 */
export function snapshotBuilders({ itemSummary, milestoneDeltaEnabled, idleEntry }) {
  /** One cached board build: the full state, its item summaries, its delta fingerprint and the lookups that serve them. */
  function snapshotEntry(revision, state, preparedFlow, { inputs = null, itemMeta = new Map(), itemMoveCounts = new Map(), clockWindow = null, comparisonHistory = null } = {}) {
    const summary = { ...state, items: state.items.map(itemSummary), finished: finishedCounts(state.items) };
    const reportValidator = { json: JSON.stringify(state.proofStats?.flow?.report), expiries: [...new Set(preparedFlow.items.flatMap(item =>
      item.state === 'claimed' ? [item.leaseUntil] : item.state === 'submitted' ? [item.reserve?.until] : []).filter(Number.isFinite))].sort((a, b) => a - b) };
    reportValidator.comparisonEvents = [...new Set((comparisonHistory ?? []).map(event => Date.parse(event.event_at)).filter(Number.isFinite))].sort((a, b) => a - b);
    reportValidator.comparisonWindowMs = state.statsComparison?.durationMinutes * 60_000;
    reportValidator.digest = createHash('sha256').update(reportValidator.json ?? 'null').digest('hex');
    return { revision, sequence: state.sequence, state, summary, preparedFlow, comparisonHistory, reportValidator, summaryFields: prepareStateJson(summary), stateJsonFields: null,
      print: fingerprint(summary, milestoneDeltaEnabled()), items: new Map(state.items.map((item) => [item.id, item])), itemMeta, itemMoveCounts, inputs, clockWindow, searchTexts: null };
  }

  /** A cached build with its idle minutes current for the observed time, its summary views derived again only when they changed. */
  const withCurrentIdle = (entry, at) => idleEntry(entry, at, state => { const summary = { ...state, items: state.items.map(itemSummary) };
    return { summary, summaryFields: prepareStateJson(summary), print: fingerprint(summary, milestoneDeltaEnabled()) }; });
  return { snapshotEntry, withCurrentIdle };
}


/** Per-read projections, including observation time, are not part of a cached build fingerprint. */
const DELTA_WHOLE = new Set([...WHOLE_STATE_DELTA_FIELDS, 'claimOverlaps']);
/** The state lists a delta merges entry by entry, and the field that names each entry. */
const DELTA_KEYS = Object.freeze({ items: 'id', shouts: 'shout_id', asked: 'shout_id', events: 'event_id', agents: 'agent_id', spec: 'id', practice: 'id', milestones: 'name' });
/** How many recent builds of each board a server keeps as possible delta bases. */
export const DELTA_BASES = 24;

/** A digest of one value's JSON, which is what a client holds of it. */
function jsonDigest(value) {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('base64');
}

/**
 * Fingerprint a summary build without keeping it: a digest of each field, and for each keyed list
 * its entry order and each entry's digest. A list whose keys repeat or are missing is a whole field.
 */
export function fingerprint(state, derived = false) {
  const fields = new Map();
  const lists = new Map();
  for (const [field, value] of Object.entries(state)) {
    if (DELTA_WHOLE.has(field)) continue;
    const key = Object.hasOwn(DELTA_KEYS, field) ? DELTA_KEYS[field] : null;
    const ids = key && Array.isArray(value) ? value.map((entry) => entry?.[key]) : null;
    if (ids && ids.every((id) => typeof id === 'number' || typeof id === 'string') && new Set(ids).size === ids.length) {
      const own = field === 'milestones' ? (entry) => milestoneWithoutPace(entry, derived) : (entry) => entry;
      lists.set(field, { key, ids, digests: new Map(value.map((entry) => [entry[key], jsonDigest(own(entry))])) });
    } else fields.set(field, jsonDigest(value));
  }
  return { fields, lists, pace: jsonDigest(milestonePace(state.milestones)) };
}

/** Whether two key lists name the same entries in the same order. */
function sameIds(left, right) {
  return left.length === right.length && left.every((id, at) => id === right[at]);
}

/**
 * What changed from each of these bases to the current build. Changed values travel whole, so the
 * delta applied to any one of the bases gives the current state; the request's own fields and the
 * Needs-you lists always come whole. A keyed list sends only its changed entries, and its full key
 * order when entries were added, removed or moved.
 *
 * @param {{ fields: Map<string, string>, lists: Map<string, any> }[]} bases
 * @param {{ fields: Map<string, string>, lists: Map<string, any> }} current
 * @param {any} state The current summary state, projected for this request.
 * @returns {{ replace: object, merge: object, milestonePace?: object, remove?: string[] }}
 */
export function stateDelta(bases, current, state) {
  const replace = {};
  const merge = {};
  for (const [field, value] of Object.entries(state)) {
    if (DELTA_WHOLE.has(field)) { replace[field] = value; continue; }
    const list = current.lists.get(field);
    if (list && bases.every((base) => base.lists.get(field)?.key === list.key)) {
      const set = value.filter((entry) => bases.some((base) => base.lists.get(field).digests.get(entry[list.key]) !== list.digests.get(entry[list.key])));
      const moved = bases.some((base) => !sameIds(base.lists.get(field).ids, list.ids));
      if (set.length || moved) merge[field] = { key: list.key, set, ...(moved ? { ids: list.ids } : {}) };
    } else if (list || bases.some((base) => base.fields.get(field) !== current.fields.get(field))) {
      replace[field] = value;
    }
  }
  const remove = [...new Set(bases.flatMap((base) => [...base.fields.keys(), ...base.lists.keys()]))].filter((field) => !Object.hasOwn(state, field));
  const pace = milestonePace(state.milestones), paced = pace !== undefined && bases.some((base) => base.pace !== current.pace);
  return { replace, merge, ...(paced ? { milestonePace: pace } : {}), ...(remove.length ? { remove } : {}) };
}

/** Cache JSON fragments for state fields whose values stay fixed across a cache hit. */
export function prepareStateJson(state) {
  const fields = Object.entries(state).map(([key, value]) => {
    if (key === 'claimOverlaps' || key === 'unseen' || key === 'observedAt' || key === 'capacityForecast' || key === 'statsComparison' || key === 'dashboardRecent') return { dynamic: key };
    if (key === 'proofStats') {
      const stats = Object.entries(value).filter(([name]) => name !== 'flow').map(([name, entry]) => jsonField(name, entry)).filter(Boolean);
      return { dynamic: key, stats };
    }
    return { static: jsonField(key, value) };
  });
  if (!fields.some((field) => field.dynamic === 'unseen')) fields.push({ dynamic: 'unseen' });
  if (!fields.some((field) => field.dynamic === 'claimOverlaps')) fields.push({ dynamic: 'claimOverlaps' });
  return fields;
}

/** Serialize a state field through JSON.stringify, omitting values JSON would omit. */
function jsonField(key, value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? '' : JSON.stringify(key) + ':' + encoded;
}

/** Count crossed native boundaries without scanning the retained history on every read. */
function crossedBoundaries(values, now) {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= now) low = middle + 1; else high = middle; }
  return low;
}

/** Reuse recorded report material while retaining native leases and sliding-window event membership. */
export function reportValidation(entry, now) {
  const { expiries, comparisonEvents, comparisonWindowMs } = entry.reportValidator;
  let crossed = crossedBoundaries(expiries, now);
  if (Number.isFinite(comparisonWindowMs) && comparisonWindowMs > 0) {
    for (const offset of [0, comparisonWindowMs, 2 * comparisonWindowMs]) crossed += crossedBoundaries(comparisonEvents, now - offset);
  }
  return entry.reportValidator.digest + ':' + crossed;
}

/** Normalize only known elapsed-clock measures; counts, unavailable values and future fields stay material. */
function comparisonForValidation(comparison) {
  if (comparison?.available !== true || !Number.isFinite(comparison.durationMinutes) || comparison.durationMinutes <= 0) return comparison;
  const normalized = { ...comparison };
  for (const name of ['current', 'previous', 'change']) {
    const window = comparison[name];
    if (!window || typeof window !== 'object') continue;
    const value = { ...window };
    for (const field of ['since', 'until']) if (typeof value[field] === 'string') value[field] = null;
    for (const field of ['agentHours', 'idleHours', 'idleShare', 'agentHoursPerLanding', 'unknownStageHours']) {
      if (typeof value[field] === 'number') value[field] = 0;
    }
    for (const field of ['idleReasonHours', 'idleReasons', 'stageHours', 'stageShares']) {
      if (value[field] && typeof value[field] === 'object') value[field] = Object.fromEntries(Object.entries(value[field])
        .map(([key, entry]) => [key, typeof entry === 'number' ? 0 : entry]));
    }
    normalized[name] = value;
  }
  return normalized;
}

/** Reuse static state fragments while encoding request-specific unread and flow data. */
export function serializeState(state, fields, reportJson, validator = false) {
  if (!fields) return JSON.stringify(state);
  const encoded = fields.map((field) => {
    if (field.static !== undefined) return field.static;
    if (field.dynamic === 'statsComparison' && validator) return jsonField(field.dynamic, comparisonForValidation(state.statsComparison));
    // The hero window's since and until move with every read clock (3a91cbbc28, #7964), so a poll's validator blanks them like observedAt.
    if (field.dynamic === 'dashboardRecent' && validator && state.dashboardRecent && typeof state.dashboardRecent === 'object') return jsonField(field.dynamic, { ...state.dashboardRecent, since: null, until: null });
    if (field.dynamic === 'claimOverlaps' || field.dynamic === 'unseen' || field.dynamic === 'observedAt' || field.dynamic === 'capacityForecast' || field.dynamic === 'statsComparison' || field.dynamic === 'dashboardRecent') return jsonField(field.dynamic, state[field.dynamic]);
    if (field.dynamic === 'proofStats') {
      const value = state.proofStats?.flow;
      const flow = reportJson === undefined || !value ? jsonField('flow', value)
        : '"flow":{' + Object.entries(value).map(([key, entry]) => key === 'report'
          ? '"report":' + reportJson : jsonField(key, entry)).filter(Boolean).join(',') + '}';
      return '"proofStats":{' + [...field.stats, flow].filter(Boolean).join(',') + '}';
    }
    return '';
  }).filter(Boolean);
  return '{' + encoded.join(',') + '}';
}
