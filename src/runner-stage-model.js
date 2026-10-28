/** Windowed runner capacity observations and an advisory placement plan [C7,O5]. */
import { Refused } from './refused.js';

const KINDS = new Set(['local', 'ssh', 'ci', 'elastic']);
const INVALID_NEXT = 'return runner rows with unique IDs, nonnegative current slots within limit, and reported capabilities';

/** Refuse malformed runner-stage input with a safe correction path. */
function invalid(message) {
  throw new Refused('BAD_RUNNER_POOL', message, INVALID_NEXT);
}

/** Return whether a value is a plain record-shaped input. */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a count that must be an exact nonnegative safe integer. */
function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Validate and copy the public runner descriptor, including optional runtime unavailability. */
function normalizedRunner(value, { stage = false } = {}) {
  if (!record(value) || typeof value.id !== 'string' || !value.id.trim() || !KINDS.has(value.kind)
    || !record(value.slots) || !nonnegativeInteger(value.slots.current) || !nonnegativeInteger(value.slots.limit)
    || value.slots.current > value.slots.limit || typeof value.slots.elastic !== 'boolean'
    || !record(value.capabilities)) {
    invalid('runner rows need an ID, supported kind, valid slot bounds and a capabilities object');
  }
  const os = value.capabilities.os ?? null;
  const browser = value.capabilities.browser ?? null;
  const gui = value.capabilities.gui ?? null;
  if (!(typeof os === 'string' && os.trim() || os === null)
    || !(typeof browser === 'boolean' || browser === null)
    || !(typeof gui === 'boolean' || gui === null)) {
    invalid('runner OS, browser and GUI capabilities must be reported values or null when unknown');
  }
  for (const key of ['unavailable', 'draining']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') invalid(`runner ${key} state must be true or false`);
  }
  if (value.browserSlots !== undefined && (!nonnegativeInteger(value.browserSlots) || value.browserSlots > value.slots.current
    || !nonnegativeInteger(value.browserActive) || value.browserActive > value.browserSlots)) {
    invalid('runner browser slots must be within current capacity and browser use must fit those slots');
  }
  if (value.browserSlots === undefined && value.browserActive !== undefined) invalid('runner browser use requires a reported browser-slot capacity');
  if (!nonnegativeInteger(value.active) || value.active > value.slots.current) {
    invalid('runner active slots must be a nonnegative count no greater than current capacity');
  }
  if (stage && (!(value.busyShare === null || Number.isFinite(value.busyShare) && value.busyShare >= 0 && value.busyShare <= 1)
    || !(value.runsServed === null || nonnegativeInteger(value.runsServed)))) {
    invalid('runner stage rows need a bounded busy share or null, and a served count or null');
  }
  const normalized = {
    id: value.id,
    kind: value.kind,
    slots: { current: value.slots.current, limit: value.slots.limit, elastic: value.slots.elastic },
    capabilities: { os, browser, ...(value.capabilities.gui === undefined ? {} : { gui }) },
  };
  normalized.active = value.active;
  if (value.browserSlots !== undefined) Object.assign(normalized, { browserSlots: value.browserSlots, browserActive: value.browserActive });
  if (value.unavailable === true || value.draining === true) {
    normalized.unavailable = value.unavailable === true;
    normalized.draining = value.draining === true;
  }
  if (stage) Object.assign(normalized, { busyShare: value.busyShare, runsServed: value.runsServed });
  return normalized;
}

/** Validate one recorded peer that a timing receipt says was not fenced out. */
function validUnfencedClient(client) {
  return typeof client === 'string' && Boolean(client.trim())
    || record(client) && typeof client.agent === 'string' && Boolean(client.agent.trim())
      && Number.isSafeInteger(client.pid) && client.pid > 0 && timestamp(client.started) !== null;
}

/** Parse an ISO timestamp without treating invalid input as a boundary. */
function timestamp(value) {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** Select the nearest-rank quartile from an already sorted numeric array. */
function quartile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Return the arithmetic median of a sorted numeric array. */
function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Summarize known runner executions over a half-open time window. Old, partial or capacity-mismatched receipts
 * remain unmeasured instead of being converted into an idle share.
 * @param {object[]} runners Current registered runner descriptors.
 * @param {object[]} receipts Retained execution receipts.
 * @param {{from:string,to:string}} window The measured interval, `[from,to)`.
 */
export function runnerStage(runners, receipts, window = {}) {
  if (!Array.isArray(runners) || !Array.isArray(receipts) || !record(window)) invalid('runner, receipt and window inputs must be valid objects or arrays');
  const { from, to } = window;
  const start = timestamp(from);
  const end = timestamp(to);
  if (start === null || end === null || end <= start) invalid('the runner stage window needs valid increasing timestamps');

  const descriptors = runners.map(runner => normalizedRunner(runner));
  const byId = new Map();
  for (const runner of descriptors) {
    if (byId.has(runner.id)) invalid('runner IDs must be unique');
    byId.set(runner.id, { runner, slotMs: 0, unknownShare: runner.slots.current === 0,
      unknownRuns: false, runsServed: 0 });
  }
  const waits = [];
  for (const receipt of receipts) {
    if (!record(receipt) || receipt.inherited === true || receipt.slot?.kind === 'inherited') continue;
    const ongoing = receipt.ongoing === true;
    // A live observation is not a completion and never supplies a completed-run wait sample.
    if (ongoing) {
      const entry = record(receipt.runner) ? byId.get(receipt.runner.id) : null;
      if (!entry) continue;
      const admitted = timestamp(receipt.admittedAt);
      const observed = timestamp(receipt.observedUntil);
      const slots = record(receipt.runner.slots) ? receipt.runner.slots.current : null;
      if (admitted === null || observed === null || observed < admitted || slots !== entry.runner.slots.current
        || !nonnegativeInteger(slots) || receipt.timing !== undefined && typeof receipt.timing !== 'boolean'
        || receipt.timing === true && (receipt.exclusive !== true || !Array.isArray(receipt.unfencedClients) || receipt.unfencedClients.length)) {
        entry.unknownShare = true;
        continue;
      }
      const overlap = Math.min(observed, end) - Math.max(admitted, start);
      if (overlap > 0) entry.slotMs += overlap * (receipt.timing === true ? slots : 1);
      continue;
    }
    const legacyAt = timestamp(receipt.at);
    const legacyIntervalRelevant = timestamp(receipt.admittedAt) !== null && timestamp(receipt.finishedAt) !== null
      && timestamp(receipt.finishedAt) > start && timestamp(receipt.admittedAt) < end;
    const legacyInWindow = (legacyAt !== null && legacyAt >= start && legacyAt < end || legacyIntervalRelevant)
      && (!receipt.runner || !record(receipt.runner) || typeof receipt.runner.id !== 'string'
        || legacyAt !== null && legacyAt >= start && legacyAt < end
          && (timestamp(receipt.admittedAt) === null || timestamp(receipt.finishedAt) === null));
    if (legacyInWindow) {
      for (const entry of byId.values()) {
        entry.unknownShare = true;
        entry.unknownRuns = true;
      }
    }
    const finished = timestamp(receipt.finishedAt);
    const completion = finished ?? (legacyInWindow ? legacyAt : null);
    if (completion !== null && completion >= start && completion < end
      && Number.isFinite(receipt.waitMs) && receipt.waitMs >= 0) waits.push(receipt.waitMs);
    if (!record(receipt.runner) || typeof receipt.runner.id !== 'string') continue;
    const entry = byId.get(receipt.runner.id);
    if (!entry) continue;

    const admitted = timestamp(receipt.admittedAt);
    if (finished !== null && finished >= start && finished < end) {
      entry.runsServed += 1;
    }
    if ((finished !== null && finished < start) || (admitted !== null && admitted >= end)) continue;
    // A matching receipt without both boundaries could overlap the window, so its share is unknown.
    if (admitted === null || finished === null || finished < admitted) {
      entry.unknownShare = true;
      entry.unknownRuns = true;
      continue;
    }
    const overlap = Math.min(finished, end) - Math.max(admitted, start);
    if (overlap <= 0) continue;

    const receiptSlots = record(receipt.runner.slots) ? receipt.runner.slots.current : null;
    if (!nonnegativeInteger(receiptSlots) || receiptSlots !== entry.runner.slots.current
      || receipt.timing !== undefined && typeof receipt.timing !== 'boolean') {
      entry.unknownShare = true;
      continue;
    }
    if (receipt.occupiedSlots !== undefined && (!Number.isSafeInteger(receipt.occupiedSlots)
      || receipt.occupiedSlots < 1 || receipt.occupiedSlots > receiptSlots)) {
      entry.unknownShare = true;
      continue;
    }
    if (receipt.exclusive !== undefined && typeof receipt.exclusive !== 'boolean'
      || receipt.unfencedClients !== undefined && (!Array.isArray(receipt.unfencedClients)
        || receipt.unfencedClients.some(client => !validUnfencedClient(client)))) {
      entry.unknownShare = true;
      continue;
    }
    if (receipt.timing === true && (receipt.exclusive === false || receipt.unfencedClients?.length)) {
      entry.unknownShare = true;
      continue;
    }
    const occupied = receipt.timing === true ? receiptSlots : receipt.occupiedSlots ?? 1;
    entry.slotMs += overlap * occupied;
  }

  const staged = descriptors.map(runner => {
    const entry = byId.get(runner.id);
    const capacityMs = (end - start) * runner.slots.current;
    const busyShare = entry.unknownShare || capacityMs === 0 || entry.slotMs > capacityMs
      ? null : entry.slotMs / capacityMs;
    return { ...runner, busyShare, runsServed: entry.unknownRuns ? null : entry.runsServed };
  });
  waits.sort((left, right) => left - right);
  return { runners: staged,
    slotWait: { fastQuarterMs: quartile(waits, 0.25), medianMs: median(waits),
      slowQuarterMs: quartile(waits, 0.75), worstMs: waits.length ? waits.at(-1) : null, count: waits.length } };
}

/** Compare requested capabilities; false browser or GUI means no corresponding requirement. */
function capabilityMatch(runner, requested) {
  let unknown = false;
  for (const key of ['os', 'browser', 'gui']) {
    if (requested[key] === undefined || requested[key] === null) continue;
    if (['browser', 'gui'].includes(key) && requested[key] === false) continue;
    const actual = runner.capabilities[key] ?? null;
    if (actual === null) unknown = true;
    else if (actual !== requested[key]) return 'no';
  }
  return unknown ? 'unknown' : 'yes';
}

/** Use the same known slot and browser-capacity facts for placement and saturation. */
function availableCapacity(runner, capabilities) {
  if (runner.unavailable || runner.draining || runner.active >= runner.slots.current) return false;
  if (capabilities.browser !== true) return true;
  if (runner.browserSlots !== undefined) return runner.browserActive < runner.browserSlots;
  return runner.active === 0;
}

/** Prefer known-compatible, fixed and less-busy available candidates deterministically. */
function candidateOrder(left, right) {
  return Number(left.match !== 'yes') - Number(right.match !== 'yes')
    || Number(left.runner.slots.elastic) - Number(right.runner.slots.elastic)
    || Number(left.runner.busyShare === null) - Number(right.runner.busyShare === null)
    || (left.runner.busyShare ?? Infinity) - (right.runner.busyShare ?? Infinity)
    || left.runner.id.localeCompare(right.runner.id);
}

/**
 * Return a read-only placement suggestion. It never changes runner capacity or starts a run.
 * @param {{runners:object[],slotWait:object}} stage A value returned by {@link runnerStage}.
 * @param {{capabilities?:{os?:string|null,browser?:boolean|null,gui?:boolean|null},slotWaitTargetMs?:number}} request
 */
export function placeRunner(stage, request = {}) {
  if (!record(request)) invalid('runner placement request must be an object');
  const { capabilities = {}, slotWaitTargetMs = 0 } = request;
  if (!record(stage) || !Array.isArray(stage.runners) || !record(stage.slotWait)
    || !(stage.slotWait.medianMs === null || Number.isFinite(stage.slotWait.medianMs) && stage.slotWait.medianMs >= 0)) {
    invalid('runner placement needs a runner stage with a measured or unknown median wait');
  }
  if (!record(capabilities) || !(capabilities.os === undefined || capabilities.os === null
    || typeof capabilities.os === 'string' && capabilities.os.trim())
    || !(capabilities.browser === undefined || capabilities.browser === null || typeof capabilities.browser === 'boolean')
    || !(capabilities.gui === undefined || capabilities.gui === null || typeof capabilities.gui === 'boolean')
    || !Number.isFinite(slotWaitTargetMs) || slotWaitTargetMs < 0) {
    invalid('placement capabilities must be reported values or null and the wait target nonnegative');
  }

  const rows = stage.runners.map(runner => normalizedRunner(runner, { stage: true }));
  if (new Set(rows.map(runner => runner.id)).size !== rows.length) invalid('runner IDs must be unique');
  const candidates = rows.map(runner => ({ runner, match: capabilityMatch(runner, capabilities) }))
    .filter(candidate => candidate.match !== 'no');
  const available = candidates.filter(({ runner }) => availableCapacity(runner, capabilities)).sort(candidateOrder);
  if (available.length) {
    const best = available[0];
    if (best.match === 'yes') return { action: 'run', runnerId: best.runner.id };
    return { action: 'wait' };
  }
  if (!candidates.length) return { action: 'incompatible' };

  const fixed = candidates.filter(({ runner }) => !runner.slots.elastic && !runner.unavailable && !runner.draining);
  const elastic = candidates.filter(({ runner, match }) => runner.slots.elastic && match === 'yes' && !runner.unavailable && !runner.draining);
  const fixedBusy = fixed.length > 0 && fixed.every(({ runner }) => {
    // Unknown browser use may require waiting, but does not establish measured browser saturation.
    if (capabilities.browser === true && runner.active < runner.slots.current && runner.browserSlots === undefined) return false;
    return !availableCapacity(runner, capabilities);
  });
  const highWait = stage.slotWait.medianMs !== null && stage.slotWait.medianMs > slotWaitTargetMs;
  if (fixedBusy && highWait) {
    const expandable = elastic.filter(({ runner }) => runner.slots.current < runner.slots.limit)
      .sort(candidateOrder)[0];
    if (expandable) return { action: 'scale', runnerId: expandable.runner.id, slots: 1 };
    const possibleElastic = candidates.filter(({ runner, match }) => runner.slots.elastic && match === 'yes'
      && !runner.unavailable && !runner.draining);
    if (elastic.length && possibleElastic.length
      && possibleElastic.every(({ runner }) => runner.slots.current >= runner.slots.limit)) {
      return { action: 'request' };
    }
  }
  return { action: 'wait' };
}
