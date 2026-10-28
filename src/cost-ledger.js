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
import { agentSessionDigest } from './person.js';
import { claudeCostReport } from './cost-provider.js';
import { sessionSnapshot } from './cost-session.js';
import { sameUsageAnchor } from './cost-session.js';
import { sessionSource } from './cost-session.js';
import { usageDifference } from './cost-session.js';
import { sharedBefore } from './cost-shared-ledger.js';
import { sharedAfter } from './cost-shared-ledger.js';
import { Refused } from './refused.js';

/** Serialize a short local ledger mutation; never hold this lock while awaiting a relay. */
function change(info, work) {
  const directory = join(info.commonDir, 'pullboard');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'cost-ledger.json');
  const lock = file + '.lock';
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Refused('USAGE_LEDGER', 'the private usage ledger is busy or unwritable; retry pullboard cost refresh after its current writer finishes'); }
  try {
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { active: [], totals: {}, hooks: {} };
    const result = work(state);
    const temporary = file + `.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, file);
    return result;
  } finally { closeSync(fd); unlinkSync(lock); }
}

/** A model's cumulative known partial values and visibly unknown totals. */
function empty(model) {
  return { model, inputTokens: 0, outputTokens: 0, costUSD: 0, knownInputTokens: 0, knownOutputTokens: 0, knownCostUSD: 0, wallMs: 0 };
}

/** Add counts without recovering an unknown total by pretending its missing portion was zero. */
function add(row, name, delta) {
  const known = { inputTokens: 'knownInputTokens', outputTokens: 'knownOutputTokens', costUSD: 'knownCostUSD' }[name];
  if (delta === null) { row[name] = null; return; }
  const value = row[known] + delta;
  if (!Number.isFinite(value) || name !== 'costUSD' && !Number.isSafeInteger(value)) throw new Refused('USAGE_OVERFLOW', 'native usage exceeds safe numeric totals; keep this record unknown rather than rounding it');
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
  const current = sessionSnapshot(entry.source, entry.snapshot, now);
  const deltas = entry.ambiguous ? [{ model: entry.model, inputTokens: null, outputTokens: null }]
    : usageDifference(entry.snapshot, current, entry.model);
  for (const delta of deltas) {
    if (delta.inputTokens === 0 && delta.outputTokens === 0 && delta.model !== entry.model) continue;
    const row = modelRow(delta.model);
    add(row, 'inputTokens', delta.inputTokens);
    add(row, 'outputTokens', delta.outputTokens);
    // A session-level dollar amount cannot be split across multiple native model deltas.
    if (delta.model !== entry.model) add(row, 'costUSD', null);
  }
  const row = modelRow(entry.model);
  const changedModels = deltas.filter((delta) => delta.inputTokens !== 0 || delta.outputTokens !== 0).map((delta) => delta.model);
  const timeRow = changedModels.some((value) => value !== entry.model) ? modelRow('unknown') : row;
  timeRow.wallMs += Math.max(0, now - entry.at);
  if (!Number.isSafeInteger(timeRow.wallMs)) throw new Refused('USAGE_OVERFLOW', 'elapsed usage time exceeds a safe integer');
  const report = state.hooks[entry.session];
  const hook = report?.costUSD;
  const freshHook = (state.hooks[entry.session]?.revision ?? 0) > (entry.hookRevision ?? 0);
  const dollars = !entry.ambiguous && entry.snapshot && deltas.every((delta) => delta.inputTokens !== null && delta.outputTokens !== null) && sameUsageAnchor(report?.snapshot, current, entry.source) && (freshHook || deltas.every((delta) => delta.inputTokens === 0 && delta.outputTokens === 0)) && deltas.every((delta) => delta.model === entry.model || delta.inputTokens === 0 && delta.outputTokens === 0) && typeof hook === 'number' && typeof entry.dollars === 'number' && hook >= entry.dollars ? hook - entry.dollars : null;
  add(row, 'costUSD', dollars);
  // Unverifiable or shared/model-changing intervals cannot be charged by a later report.
  if (entry.ambiguous || !current || !entry.snapshot || deltas.some((delta) => delta.inputTokens === null || delta.outputTokens === null || delta.model !== entry.model && (delta.inputTokens !== 0 || delta.outputTokens !== 0))) entry.dollars = null;
  // Keep a valid dollar anchor through a delayed report; never adopt a stale baseline.
  if (sameUsageAnchor(report?.snapshot, current, entry.source)) entry.dollars = hook ?? null;
  entry.snapshot = current;
  entry.hookRevision = state.hooks[entry.session]?.revision ?? 0;
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
    sharedBefore(state, session, now, advance, changed);
    state.seenClaims ??= {};
    for (const interval of intervals) {
      if (state.seenClaims[interval.key] || state.active.some((entry) => entry.claim === interval.key) || newClaim && interval.item === item && interval.end === null) continue;
      const recorded = state.totals[`${agent}:${interval.item}`];
      const start = Math.max(interval.start, recorded?.observedAt ?? 0);
      const end = interval.end ?? now;
      state.seenClaims[interval.key] = true;
      if (end <= start) continue;
      const recovered = { agent, item: interval.item, claim: interval.key, model: interval.model ?? model ?? 'unknown', session,
        source: null, snapshot: null, dollars: null, at: start, ambiguous: true };
      advance(state, recovered, end, changed);
      if (interval.end === null) {
        recovered.source = sessionSource(environment);
        recovered.snapshot = sessionSnapshot(recovered.source, undefined, now);
        recovered.dollars = sameUsageAnchor(state.hooks[session]?.snapshot, recovered.snapshot, recovered.source) ? state.hooks[session].costUSD : null;
        recovered.hookRevision = state.hooks[session]?.revision ?? 0;
        state.active.push(recovered);
      }
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
        const snapshot = sessionSnapshot(source, undefined, interval?.start ?? now);
        const entry = { agent, item, claim: interval?.key, model: snapshot?.model ?? model ?? 'unknown', session, source, snapshot,
          dollars: sameUsageAnchor(state.hooks[session]?.snapshot, snapshot, source) ? state.hooks[session].costUSD : null, hookRevision: state.hooks[session]?.revision ?? 0, at: interval?.start ?? now, ambiguous: peers.length > 0 };
        state.active.push(entry);
        if (interval) state.seenClaims[interval.key] = true;
        advance(state, entry, now, changed);
      }
    } else if (['submit', 'release'].includes(operation)) {
      state.active = state.active.filter((entry) => entry.agent !== agent || entry.item !== item);
    }
    sharedAfter(state, session, now, advance, changed);
    for (const entry of state.active) entry.ambiguous = Boolean(entry.session && state.active.some((peer) => peer !== entry && peer.session === entry.session));
    return { items: Object.values(state.totals).filter((value) => value.agentId === agent && value.revision > (existing.find((row) => row.item === value.item)?.revision ?? 0)).map((value) => structuredClone(value)),
      sharedSessions: Object.values(state.sharedTotals).filter((value) => value.seats.includes(agent) && value.revision > (existingShared.find((row) => row.id === value.id)?.revision ?? 0)).map((value) => structuredClone(value)) };
  });
}

/** Store only the documented native statusline cost, privately bound to the caller's session. */
export function recordClaudeCost(info, payload, environment = process.env) {
  if (!environment.CLAUDE_CODE_SESSION_ID || payload?.session_id !== environment.CLAUDE_CODE_SESSION_ID) throw new Refused('USAGE_SESSION', 'the Claude statusline report must belong to this native session');
  const report = claudeCostReport(payload);
  const snapshot = sessionSnapshot(sessionSource(environment));
  return change(info, (state) => { state.hooks[agentSessionDigest(environment)] = { ...report, snapshot, revision: (state.hooks[agentSessionDigest(environment)]?.revision ?? 0) + 1 }; return report; });
}
