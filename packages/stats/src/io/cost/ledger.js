/** Private attribution checkpoints; only numeric summaries leave this local ledger [N2]. */
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentSessionDigest } from '../../../light.js';
import { pruneCursors } from './cursor.js';
import { sessionSnapshot } from './session.js';
import { sessionSource } from './session.js';
import { missingSessionReason } from './session.js';
import { usageDifference } from './session.js';
import { sharedBefore } from './shared/ledger.js';
import { sharedAfter } from './shared/ledger.js';
import { Refused } from '../../../../kernel/index.js';
import { SPLIT_COUNTS } from './usage.js';
import { unknownInputSplit } from './usage.js';

/** Serialize a short local ledger mutation; never hold this lock while awaiting a relay. */
function change(info, work) {
  const directory = join(info.commonDir, 'pullboard');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'cost-ledger.json');
  const lock = file + '.lock';
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Refused('USAGE_LEDGER', 'the private usage ledger is busy or unwritable; retry a native claim, submit or release after its current writer finishes'); }
  try {
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { active: [], totals: {} };
    const result = work(state);
    const temporary = file + `.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, file);
    return result;
  } finally { closeSync(fd); unlinkSync(lock); }
}

/** A model's cumulative known partial values and visibly unknown totals. */
function empty(model) {
  return { model, ...Object.fromEntries(SPLIT_COUNTS.map(name => [name, 0])), inputTokens: 0, outputTokens: 0, knownInputTokens: 0, knownOutputTokens: 0, wallMs: 0, unknownReasons: [] };
}

/** Add counts without recovering an unknown total by pretending its missing portion was zero. */
function add(row, name, delta) {
  const known = { inputTokens: 'knownInputTokens', outputTokens: 'knownOutputTokens' }[name];
  if (delta === null) { row[name] = null; return; }
  const value = row[known] + delta;
  if (!Number.isSafeInteger(value)) throw new Refused('USAGE_OVERFLOW', 'native usage exceeds safe numeric totals; keep this record unknown rather than rounding it');
  row[known] = value;
  if (row[name] !== null) row[name] += delta;
}

/** Advance one allocation from its verified source anchor and latest checkpoint time. */
function advance(state, entry, now, changed) {
  const key = entry.sharedId ?? `${entry.agent}:${entry.item}`;
  const target = entry.sharedId ? state.sharedTotals : state.totals;
  const total = target[key] ??= entry.sharedId ? { id: entry.sharedId, revision: 0, records: [] } : { agentId: entry.agent, item: entry.item, revision: 0, records: [] };
  if (entry.sharedId) { total.seats = [...entry.seats]; total.allocations = entry.allocations.map((value) => ({ ...value })); }
  else if (entry.ambiguous) total.shared = true;
  /** Keep one numeric row per model without sharing native source references. */
  const modelRow = (model) => {
    let row = total.records.find((value) => value.model === model);
    if (!row) { row = empty(model); total.records.push(row); }
    return row;
  };
  const current = sessionSnapshot(entry.source, entry.snapshot, now, state.cursors ??= {});
  const deltas = entry.ambiguous ? [{ model: entry.model, ...unknownInputSplit(), inputTokens: null, outputTokens: null }]
    : usageDifference(entry.snapshot, current, entry.model);
  for (const delta of deltas) {
    if (delta.inputTokens === 0 && delta.outputTokens === 0 && delta.model !== entry.model) continue;
    const row = modelRow(delta.model);
    add(row, 'inputTokens', delta.inputTokens);
    add(row, 'outputTokens', delta.outputTokens);
    for (const name of SPLIT_COUNTS) {
      const value = row[name] + delta[name];
      row[name] = Number.isSafeInteger(row[name]) && Number.isSafeInteger(delta[name]) && Number.isSafeInteger(value) ? value : null;
    }
    if (delta.inputTokens === null || delta.outputTokens === null) {
      const reason = entry.recovered ? 'missed-claim-anchor' : entry.ambiguous ? 'shared-session'
        : !entry.source ? entry.missing ?? 'native-session-unavailable' : !entry.snapshot ? 'no-native-baseline'
          : !current ? 'native-session-unreadable-or-reset' : 'native-counter-unreadable-or-decreased';
      row.unknownReasons ??= [];
      if (!row.unknownReasons.includes(reason)) row.unknownReasons.push(reason);
    }
  }
  const row = modelRow(entry.model);
  const changedModels = deltas.filter((delta) => delta.inputTokens !== 0 || delta.outputTokens !== 0).map((delta) => delta.model);
  const timeRow = changedModels.some((value) => value !== entry.model) ? modelRow('unknown') : row;
  timeRow.wallMs += Math.max(0, now - entry.at);
  if (!Number.isSafeInteger(timeRow.wallMs)) throw new Refused('USAGE_OVERFLOW', 'elapsed usage time exceeds a safe integer');
  entry.snapshot = current;
  entry.at = now;
  total.observedAt = Math.max(total.observedAt ?? 0, now);
  total.revision++;
  changed.add(key);
}

/** Update lifecycle attribution and return immutable numeric snapshots to send through ordered moves. */
export function usageCheckpoint(info, { agent, item, operation, model, now = Date.now(), environment = process.env, existing = [], existingShared = [], intervals = [], newClaim = false }) {
  const session = agentSessionDigest(environment);
  return change(info, (state) => {
    for (const value of existing) {
      const key = `${value.agentId}:${value.item}`;
      if (!state.totals[key]) state.totals[key] = structuredClone(value);
    }
    const changed = new Set();
    state.cursors ??= {};
    pruneCursors(state.cursors, now);
    sharedBefore(state, session, now, advance, changed);
    state.seenClaims ??= {};
    const closing = ['merged', 'withdraw'].includes(operation);
    for (const interval of intervals) {
      // A closing move carries no session of the seat it closes, so another claim waits for that seat's own checkpoint.
      if (closing && interval.item !== item) continue;
      if (state.seenClaims[interval.key] || state.active.some((entry) => entry.claim === interval.key) || newClaim && interval.item === item && interval.end === null) continue;
      const recorded = state.totals[`${agent}:${interval.item}`];
      const start = Math.max(interval.start, recorded?.observedAt ?? 0);
      const end = interval.end ?? now;
      state.seenClaims[interval.key] = true;
      if (end <= start) continue;
      const recovered = { agent, item: interval.item, claim: interval.key, model: interval.model ?? model ?? 'unknown', session,
        source: null, snapshot: null, at: start, ambiguous: true, recovered: true };
      advance(state, recovered, end, changed);
      if (interval.end === null) {
        recovered.source = sessionSource(environment);
        recovered.missing = missingSessionReason(environment);
        recovered.snapshot = sessionSnapshot(recovered.source, undefined, now, state.cursors);
        state.active.push(recovered);
      }
    }
    // A pulled submit closes its allocation as it offers the gate, while the board's claim stays open until the receipt applies;
    // after a red gate, the resubmit or release that ends that claim continues from the seat's last attributed moment.
    state.offered ??= {};
    const reopen = ['submit', 'release'].includes(operation) && !state.active.some((entry) => entry.agent === agent)
      ? intervals.findLast((value) => value.item === item && value.key === state.offered[`${agent}:${item}`] && (value.end === null || value.endKind === 'release')) : null;
    const at = reopen && Math.max(reopen.start, ...Object.values(state.totals).filter((value) => value.agentId === agent).map((value) => value.observedAt ?? 0));
    if (reopen && at < (reopen.end ?? now)) {
      const source = sessionSource(environment);
      const snapshot = sessionSnapshot(source, undefined, at, state.cursors);
      state.active.push({ agent, item, claim: reopen.key, model: snapshot?.model ?? model ?? 'unknown', session, source, snapshot,
        missing: missingSessionReason(environment), at, ambiguous: state.active.some((entry) => session && entry.session === session) });
    }
    const own = state.active.filter((entry) => entry.agent === agent);
    for (const entry of own) {
      const interval = intervals.find((value) => value.key === entry.claim);
      advance(state, entry, interval?.end ?? now, changed);
    }
    state.active = state.active.filter((entry) => entry.agent !== agent || !intervals.some((value) => value.key === entry.claim && value.end !== null));
    if (operation === 'claim') {
      const current = state.active.find((entry) => entry.agent === agent && entry.item === item && entry.session === session);
      state.active = state.active.filter((entry) => entry.agent !== agent || entry === current);
      if (!current) {
        const peers = state.active.filter((entry) => session && entry.session === session);
        // Another seat publishes its own totals. Mark overlap privately, never impersonate its ordered actor.
        for (const peer of peers) { advance(state, peer, now, changed); peer.ambiguous = true; }
        const source = sessionSource(environment);
        const interval = intervals.findLast((value) => value.item === item && value.end === null);
        const snapshot = sessionSnapshot(source, undefined, interval?.start ?? now, state.cursors);
        const entry = { agent, item, claim: interval?.key, model: snapshot?.model ?? model ?? 'unknown', session, source, snapshot, missing: missingSessionReason(environment),
          at: interval?.start ?? now, ambiguous: peers.length > 0 };
        state.active.push(entry);
        if (interval) state.seenClaims[interval.key] = true;
        advance(state, entry, now, changed);
      }
    } else if (['submit', 'release', 'merged', 'withdraw'].includes(operation)) {
      state.active = state.active.filter((entry) => entry.agent !== agent || entry.item !== item);
    }
    // Remember a close the board has not applied yet (a pulled submit), and forget one whose claim the board has ended.
    const open = operation === 'submit' ? intervals.findLast((value) => value.item === item && value.end === null) : null;
    if (open) state.offered[`${agent}:${item}`] = open.key;
    else delete state.offered[`${agent}:${item}`];
    sharedAfter(state, session, now, advance, changed);
    for (const entry of state.active) entry.ambiguous = Boolean(entry.session && state.active.some((peer) => peer !== entry && peer.session === entry.session));
    return { items: Object.values(state.totals).filter((value) => value.agentId === agent && value.revision > (existing.find((row) => row.item === value.item)?.revision ?? 0)).map((value) => structuredClone(value)),
      sharedSessions: Object.values(state.sharedTotals).filter((value) => value.seats.includes(agent) && value.revision > (existingShared.find((row) => row.id === value.id)?.revision ?? 0)).map((value) => structuredClone(value)) };
  });
}

/** The counter fields of one coordinator usage row. */
const COORDINATOR_FIELDS = ['inputTokens', 'outputTokens', ...SPLIT_COUNTS];

/**
 * The coordinator session's usage since the last acknowledged record, as model rows, or null when nothing grew.
 * Reads only the bytes past the session log's cursor. The board keeps one immutable row per session id, so the first
 * record keeps the session id and each later one is `<session id>.<n>` holding only the growth since the one before [C7,#9685].
 */
export function coordinatorUsagePending(info, { session, source, now }) {
  return change(info, (state) => {
    state.cursors ??= {};
    const snapshot = sessionSnapshot(source, undefined, now, state.cursors);
    if (!snapshot) return null;
    const seen = state.coordinator?.[session] ?? { count: 0, totals: {} };
    const records = [];
    for (const [model, total] of Object.entries(snapshot.totals)) {
      const before = seen.totals[model] ?? Object.fromEntries(COORDINATOR_FIELDS.map(name => [name, 0]));
      const grown = Object.fromEntries(COORDINATOR_FIELDS.map(name => [name,
        total[name] !== null && before[name] !== null && total[name] >= before[name] ? total[name] - before[name] : null]));
      if (COORDINATOR_FIELDS.every(name => grown[name] === 0)) continue;
      const unknown = grown.inputTokens === null || grown.outputTokens === null;
      records.push({ model, ...grown, knownInputTokens: grown.inputTokens ?? 0, knownOutputTokens: grown.outputTokens ?? 0, wallMs: 0,
        unknownReasons: unknown ? ['native-counter-unreadable-or-decreased'] : [] });
    }
    if (!records.length) return null;
    return { id: seen.count === 0 ? session : `${session.slice(0, 120)}.${seen.count}`, records, totals: structuredClone(snapshot.totals) };
  });
}

/** Remember that the board holds the usage `coordinatorUsagePending` named, so the next record carries only newer growth. */
export function coordinatorUsageAcknowledge(info, { session, totals }) {
  return change(info, (state) => {
    state.coordinator ??= {};
    const seen = state.coordinator[session] ?? { count: 0, totals: {} };
    state.coordinator[session] = { count: seen.count + 1, totals };
  });
}
