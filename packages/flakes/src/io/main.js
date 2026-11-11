/** Typed failure observations preserve evidence separately from person-authorized waivers [C7,D1,H16]. */
import { createHash } from 'node:crypto';
import {
  historyPathMap,
  mappedPath,
} from "../../../codemap/index.js";
import {
  addItem,
  atomic,
  getItem,
  listAgents,
  logEvent,
} from "../../../store/index.js";
import { CI_FLAKE_ENGINE } from "../../../state/light.js";
import { NATIVE_FLAKE_ENGINE } from "../../../state/light.js";
import { LEDGER_QUARANTINE_ENGINE } from "../../../state/light.js";
import { flakeQuarantines } from "./quarantine.js";
import { warmFlakeHistory } from "./quarantine.js";
import { eventHistory } from "./history.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { Refused } from "../../../kernel/index.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const CLASSIFICATIONS = ['flake', 'possible-regression', 'stable-red', 'unclassified'];

/** Require portable artifact names, never a machine's private checkout or home path. */
function receipt(value) {
  if (!value || typeof value.green !== 'boolean' || !DIGEST.test(value.sha256 ?? '')
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || typeof value.artifact !== 'string'
      || !/^flake-evidence\/[a-zA-Z0-9-]+\/[a-zA-Z0-9.-]+$/u.test(value.artifact)
      || value.profileSha256 !== null && !DIGEST.test(value.profileSha256 ?? '')) {
    throw new Refused('FLAKE_EVIDENCE', 'retain the complete original and diagnostic receipts with their digests before recording a flake');
  }
  return { green: value.green, sha256: value.sha256, bytes: value.bytes, artifact: value.artifact, profileSha256: value.profileSha256 };
}

/** Normalize only bounded, structured evidence; a successful diagnostic cannot replace its original red. */
export function flakeObservation(value) {
  const text = (entry, limit) => typeof entry === 'string' && entry.length > 0 && entry.length <= limit && !/[\r\n\0]/u.test(entry);
  if (!value || !text(value.id, 80) || !/^[a-zA-Z0-9-]+$/u.test(value.id) || !SHA.test(value.head ?? '')
      || !SHA.test(value.tree ?? '') || value.main !== null && !SHA.test(value.main ?? '')
      || !['check', 'submit', 'verify', 'land', 'gate', 'ci'].includes(value.kind) || !CLASSIFICATIONS.includes(value.classification)
      || !DIGEST.test(value.commandSha256 ?? '') || !text(value.reason, 2048) || !Number.isFinite(Date.parse(value.at))
      || !Number.isFinite(value.diagnosticMs) || value.diagnosticMs < 0) {
    throw new Refused('FLAKE_EVIDENCE', 'a failure observation needs its pinned source, gate kind, time and complete receipts');
  }
  const file = value.file ?? null, name = value.name ?? null;
  if (file !== null && (!text(file, 4096) || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))
      || name !== null && !text(name, 8192) || (file === null) !== (name === null)
      || value.classification !== 'unclassified' && file === null) {
    throw new Refused('FLAKE_EVIDENCE', 'identify the test with its committed relative file and structured name, or leave it unclassified');
  }
  const original = receipt(value.original);
  const paired = value.paired === null ? null : receipt(value.paired);
  const mainReceipt = value.mainReceipt === null ? null : receipt(value.mainReceipt);
  if (original.green || value.classification === 'flake' && (!paired?.green || value.main !== value.head && (!mainReceipt || mainReceipt.green))
      || value.classification === 'possible-regression' && !mainReceipt?.green
      || value.classification === 'stable-red' && (!paired || paired.green)) {
    throw new Refused('FLAKE_EVIDENCE', 'a flake needs a red original and one green pair; a pinned green main is a possible regression instead');
  }
  // A CI observation names its run, attempts, job, runner and Node version; a hosted runner's load is unknown (#918).
  const ci = value.kind === 'ci' ? ciRecord(value.ci, text) : null;
  if (value.kind !== 'ci' && value.ci !== undefined) throw new Refused('FLAKE_EVIDENCE', 'only a CI observation carries a CI record');
  const load = value.load;
  if (value.kind === 'ci' ? load !== null : !load || !Array.isArray(load.average) || load.average.length !== 3 || load.average.some(number => !Number.isFinite(number) || number < 0)
      || !Number.isSafeInteger(load.cpus) || load.cpus < 1 || !Number.isSafeInteger(load.freeMB) || load.freeMB < 0) {
    throw new Refused('FLAKE_EVIDENCE', 'record observed machine load with this failure');
  }
  return { id: value.id, file, name, head: value.head, tree: value.tree, main: value.main, kind: value.kind,
    classification: value.classification, commandSha256: value.commandSha256, reason: value.reason, at: new Date(value.at).toISOString(),
    diagnosticMs: value.diagnosticMs, load: load === null ? null : { average: [...load.average], cpus: load.cpus, freeMB: load.freeMB },
    ...(ci ? { ci } : {}), original, paired, mainReceipt };
}

/** Check a CI observation's provenance: provider, numeric run id, the red attempt and its later rerun, job, runner, Node version. */
function ciRecord(ci, text) {
  if (!ci || ci.provider !== 'github' || !/^\d{1,20}$/u.test(ci.run ?? '') || !Number.isSafeInteger(ci.attempt) || ci.attempt < 1
      || !Number.isSafeInteger(ci.rerunAttempt) || ci.rerunAttempt <= ci.attempt || !text(ci.job, 200) || !text(ci.runner, 200)
      || !/^v\d+\.\d+\.\d+$/u.test(ci.node ?? '')) {
    throw new Refused('FLAKE_EVIDENCE', 'a CI observation names its provider, run id, failed attempt, rerun attempt, job, runner and Node version');
  }
  return { provider: ci.provider, run: ci.run, attempt: ci.attempt, rerunAttempt: ci.rerunAttempt, job: ci.job, runner: ci.runner, node: ci.node };
}

/** A stable identity follows the actual test, rather than its line number, machine or latest source head. */
function observationKey(value) {
  return createHash('sha256').update(JSON.stringify(value.file === null ? ['unknown', value.commandSha256] : [value.file, value.name])).digest('hex');
}

/** Each native flake observation and repair event parsed once per connection, then only the events after them [C7]. */
export function flakeEvents(board) {
  return eventHistory(board, 'flake', ['flake-observation', 'flake-repair'], event => ({
    event_id: event.event_id, event_at: event.event_at, event_kind: event.event_kind, detail: JSON.parse(event.event_detail) }));
}

/** Read only allocated typed events, preserving every original observation and repair relationship. */
export function flakeLedger(board, { root } = {}) {
  const rows = new Map();
  for (const event of flakeEvents(board)) {
    const detail = event.detail;
    if (detail.engine !== NATIVE_FLAKE_ENGINE) continue;
    if (event.event_kind === 'flake-repair') {
      const row = rows.get(detail.key);
      if (row) row.item = detail.item;
      continue;
    }
    const value = detail.observation;
    const key = observationKey(value);
    let row = rows.get(key);
    if (!row) { row = { key, file: value.file, name: value.name, count: 0, firstSeen: event.event_at, lastSeen: event.event_at, item: null, status: 'unclassified', observations: [] }; rows.set(key, row); }
    row.observations.push(value);
    row.lastSeen = event.event_at;
    row.lastEventId = event.event_id;
    row.classification = value.classification;
    if (value.classification === 'flake') row.count += 1;
    row.status = row.count ? 'active' : value.classification;
  }
  for (const row of rows.values()) if (row.item !== null) {
    const item = getItem(board, row.item);
    const merged = board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE event_kind='merged' AND item_id=?").get(row.item);
    if (item.item_merged_commit && merged.id > row.lastEventId) row.status = 'fixed';
  }
  return root ? mappedLedger([...rows.values()], historyPathMap(root)) : [...rows.values()];
}

/** Join read identities after interpreting the original repair keys, retaining every original observation. */
function mappedLedger(rows, map) {
  if (!map.size) return rows;
  const grouped = new Map();
  for (const row of rows) {
    const file = row.file === null ? null : mappedPath(map, row.file);
    const key = file === null ? row.key : observationKey({ file, name: row.name });
    const previous = grouped.get(key);
    if (!previous) { grouped.set(key, { ...row, key, file, repairs: row.item === null ? [] : [row.item] }); continue; }
    const latest = previous.lastEventId > row.lastEventId ? previous : row;
    grouped.set(key, { ...latest, key, file, count: previous.count + row.count,
      firstSeen: previous.firstSeen < row.firstSeen ? previous.firstSeen : row.firstSeen,
      lastSeen: latest.lastSeen, lastEventId: latest.lastEventId,
      observations: [...previous.observations, ...row.observations],
      repairs: [...new Set([...previous.repairs, ...(row.item === null ? [] : [row.item])])],
      item: latest.item ?? previous.item ?? row.item,
      status: previous.status === 'active' || row.status === 'active' ? 'active' : latest.status });
  }
  return [...grouped.values()];
}

/** Atomically append one observation, drafting ordinary repair work only on a second confirmed sighting. */
export function recordFlakeObservation(board, { agentId, observation, lane }) {
  const needed = observation?.kind === 'ci' ? CI_FLAKE_ENGINE : NATIVE_FLAKE_ENGINE;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < needed) throw new Refused('ENGINE_VERSION', `${observation?.kind === 'ci' ? 'CI ' : ''}flake observations require engine ${needed}; upgrade Pullboard`);
  if (!listAgents(board).some(agent => agent.agent_id === agentId)) throw new Refused('NOT_JOINED', 'join this board before recording a flake observation');
  const value = flakeObservation(observation);
  warmFlakeHistory(board);
  return atomic(board, () => {
    const existing = flakeLedger(board).flatMap(row => row.observations).find(row => row.id === value.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Refused('FLAKE_OBSERVATION_CHANGED', 'an observation id already binds different evidence; preserve the original and use a new id');
      return { observation: existing, duplicate: true };
    }
    const key = observationKey(value);
    logEvent(board, agentId, 'flake-observation', null, { engine: NATIVE_FLAKE_ENGINE, observation: value });
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= LEDGER_QUARANTINE_ENGINE) {
      const filed = quarantineLedgerFlakes(board, agentId, lane);
      return { observation: value, item: flakeLedger(board).find(entry => entry.key === key).item, quarantined: filed };
    }
    const row = flakeLedger(board).find(entry => entry.key === key);
    if (row.count >= 2 && row.item === null) {
      const item = addItem(board, { by: agentId, lane, route: 'strong', title: `Flaky test: ${value.file} :: ${value.name}`.slice(0, 240),
        criterion: `Identify and correct why ${value.file} :: ${value.name} fails intermittently; preserve the original red and paired evidence, prove the correction without retries, and pass the gate.`,
        brief: 'Rigor repair draft from repeated typed flake observations. The original red remains the gate result. No spec or doctrine decision was approved.\n\n'
          + row.observations.map(entry => JSON.stringify({ id: entry.id, head: entry.head, at: entry.at, kind: entry.kind, original: entry.original, paired: entry.paired, main: entry.mainReceipt })).join('\n') });
      logEvent(board, agentId, 'flake-repair', item, { engine: NATIVE_FLAKE_ENGINE, key, item });
      return { observation: value, item };
    }
    return { observation: value, item: row.item };
  });
}

/**
 * File one repair item and one quarantine for every active ledger flake with no active quarantine, oldest rows included.
 * A row whose quarantine was lifted after its last sighting is already released, so it is left alone.
 * Why: a ledger flake proves itself with a red original and a green pair, and the landing ratchet counts it from the
 * first sighting; drafting repairs only on a second sighting, with no quarantine, left nine tests blocking every landing.
 */
function quarantineLedgerFlakes(board, agentId, lane) {
  const quarantines = new Map(flakeQuarantines(board).map(row => [JSON.stringify([row.file, row.name]), row]));
  const filed = [];
  for (const row of flakeLedger(board)) {
    if (row.status !== 'active' || row.count < 1 || row.file === null) continue;
    const prior = quarantines.get(JSON.stringify([row.file, row.name]));
    if (prior?.status === 'quarantined' || prior?.status === 'lifted' && prior.since >= row.lastEventId) continue;
    const open = row.item !== null && !['verified', 'withdrawn'].includes(getItem(board, row.item).item_status);
    const flakes = row.observations.filter(entry => entry.classification === 'flake');
    const item = open ? row.item : addItem(board, { by: agentId, lane, route: 'strong', title: `Flaky test: ${row.file} :: ${row.name}`.slice(0, 240),
      criterion: `Identify and correct why ${row.file} :: ${row.name} fails intermittently; preserve the original red and paired evidence, prove the correction without retries, and pass the gate.`,
      brief: 'Ledger quarantine: a typed flake observation holds a red original and a green pair. The test still runs and reports; a landing no longer stops on it until this item is verified.\n\n'
        + flakes.map(entry => JSON.stringify({ id: entry.id, head: entry.head, at: entry.at, kind: entry.kind, original: entry.original, paired: entry.paired })).join('\n') });
    if (!open) logEvent(board, agentId, 'flake-repair', item, { engine: NATIVE_FLAKE_ENGINE, key: row.key, item });
    logEvent(board, agentId, 'test-quarantine', item, { engine: LEDGER_QUARANTINE_ENGINE, ledger: true,
      file: row.file, name: row.name, tree: flakes.at(-1).tree, runs: flakes.map(entry => entry.id) });
    filed.push({ file: row.file, name: row.name, item });
  }
  return filed;
}
