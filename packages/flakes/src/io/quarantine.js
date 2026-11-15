import { randomUUID } from 'node:crypto';
import { legacyFlakeObservations } from '../logic/ratchet.js';
import { flakeRatchet } from '../logic/ratchet.js';
import { pairedFlakeObservations } from '../logic/ratchet.js';
import { ratchetBoundary } from './boundary.js';
import { warmRatchetBoundary } from './boundary.js';
import { repairedAt } from './boundary.js';
import { backfillPairs } from './boundary.js';
import { eventHistory } from './history.js';
import { quarantinesAt } from '../logic/ratchet.js';
import { AUTO_SUBMIT_QUARANTINE_ENGINE } from "../../../state/light.js";
import { proofReceipts } from "../../../store/index.js";
import { nativeProofBlockingGreen } from "../../../verify/index.js";
import { landingGateRecords } from "../../../verify/index.js";
import { MAIN_AUDIT_ENGINE } from "../../../state/light.js";
import { landingBatches } from "../../../landing/index.js";
/**
 * Gate runs and flake quarantine [C7,D1]. Every real gate run leaves its tree, its failing test ids and the host load on
 * the board, as the receipt its gate wrote. When one tree has been both red and green for the same test, that is proof
 * of a flake: the board files one repair item for the test and quarantines it. A quarantined test still runs and still
 * reports, but a landing no longer stops on it until its repair item is verified; after that it blocks again, and a new
 * proof starts a new quarantine. Quarantine is the coordinator's opt-in; with it off, runs and items are still recorded.
 */
import {
  addItem,
  atomic,
  getItem,
  logEvent,
} from "../../../store/index.js";
import { GATE_RUN_ENGINE } from "../../../state/light.js";
import { LANDING_ENVIRONMENT_ENGINE } from "../../../state/light.js";
import { RUN_TIMING_ENGINE } from "../../../state/light.js";
import { SHADOW_TIER1_ENGINE } from "../../../state/light.js";
import {
  boardReceiptStore,
  receiptBinds,
  receiptFields,
} from "../../../gate/index.js";
import { COORDINATOR } from "../../../config/index.js";
import { flakeLedger } from "./main.js";
import { flakeEvents } from "./main.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { Refused } from "../../../kernel/index.js";
import { QUARANTINE_CORE_ENGINE } from "../../../state/light.js";
import { QUARANTINE_VERDICT_ENGINE } from "../../../state/light.js";
import { quarantineVerdictFields } from "../../../verify/index.js";

const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

/** Quarantine is the coordinator's opt-in: the board reads it from accepted main's pullboard.json, never from a branch. */
export function quarantineOn(board) {
  try { return board.quarantineEnabled?.() === true; } catch { return false; }
}

/** The one identity of a test across runs: its committed file and its structured name. */
function testKey(file, name) { return JSON.stringify([file, name]); }

/** Each gate-run event parsed once per connection: its run, and whether it was an automatic Submit quarantine run. */
function gateRunEvents(board) {
  return eventHistory(board, 'gate-run', ['gate-run'], row => {
    const detail = JSON.parse(row.event_detail);
    return { run: { eventId: row.event_id, by: row.event_by, ...detail.run },
      autoSubmit: detail.engine >= AUTO_SUBMIT_QUARANTINE_ENGINE && detail.autoSubmit === true };
  });
}

/**
 * Every recorded gate run, oldest first, with the event that carries it and the seat that recorded it. The runs are
 * frozen and shared: read once per connection, then only the runs after them, so a write that warmed them before its
 * lock reads only the new runs inside it [C7].
 */
export function gateRuns(board) {
  return gateRunEvents(board).map(entry => entry.run);
}

/**
 * Where a test's quarantine stands. Quarantined means its repair item is still being fixed; lifted means that item was
 * verified (or, for legacy events, withdrawn), or its native clean streak reaches 20. Only newer runs count after release.
 */
export function flakeQuarantines(board) {
  const latest = new Map();
  for (const row of board.db.prepare("SELECT event_id, item_id, event_detail FROM event WHERE event_kind = 'test-quarantine' ORDER BY event_id").all()) {
    const detail = JSON.parse(row.event_detail);
    latest.set(testKey(detail.file, detail.name), { file: detail.file, name: detail.name, item: row.item_id, tree: detail.tree, runs: detail.runs, eventId: row.event_id,
      ...(detail.engine >= QUARANTINE_CORE_ENGINE ? { nativeCore: true } : {}), ...(detail.ledger === true ? { ledger: true } : {}),
      ...(detail.engine >= AUTO_SUBMIT_QUARANTINE_ENGINE && detail.autoSubmit === true ? { autoSubmit: true } : {}) });
  }
  const index = [...latest.values()].some(entry => entry.nativeCore) ? indexOutcomes(board, gateRuns(board)) : new Map();
  return [...latest.values()].map(entry => {
    const item = getItem(board, entry.item);
    const state = item.item_status;
    const clean = entry.nativeCore && !entry.autoSubmit ? cleanRunRelease(index, entry) : null;
    const lifted = entry.autoSubmit ? Boolean(item.item_merged_commit) : state === 'verified' || (!entry.nativeCore || entry.ledger) && state === 'withdrawn' || clean?.releasedAt !== null && clean?.releasedAt !== undefined;
    const closing = lifted ? (entry.autoSubmit
      ? board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE item_id = ? AND event_kind='merged'")
      : board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE item_id = ? AND event_kind IN ('accept','withdraw')")).get(entry.item).id : null;
    return { ...entry, ...(entry.nativeCore ? { cleanRuns: clean?.count ?? 0 } : {}),
      status: lifted ? 'lifted' : 'quarantined', since: Math.max(entry.eventId, closing ?? 0, clean?.releasedAt ?? 0) };
  });
}

/**
 * Capture the current ratchet against the last landed batch from one consistent read snapshot [C7].
 *
 * Why: the capture reads runs, the ledger and quarantines in several queries. Outside a transaction a
 * concurrent write could land between them, and refusing on that left a busy board unable to land at
 * all. One read transaction pins every query to the same snapshot, so other writers never disturb it;
 * a caller already inside a transaction has pinned it for us.
 */
export function landingFlakeRatchet(board, ports = {}) {
  let own = false;
  try { board.db.exec('BEGIN'); own = true; } catch { /* The caller's open transaction already holds one snapshot. */ }
  try {
    const result = captureFlakeRatchet(board, ports);
    if (own) board.db.exec('COMMIT');
    own = false;
    return result;
  } finally {
    if (own) board.db.exec('ROLLBACK');
  }
}

/** Compute the ratchet from the board as one snapshot shows it, reconstructing the last batch's boundary once. */
function captureFlakeRatchet(board, { readQuarantines = flakeQuarantines, readLedger = flakeLedger, readRuns = gateRuns } = {}) {
  const eventId = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
  const boundary = ratchetBoundary(board), row = boundary.row;
  const runs = readRuns(board).filter(run => run.eventId <= eventId);
  let previous = boundary.previous;
  if (row) {
    if (!previous) {
      const events = board.db.prepare(`SELECT event_id, event_kind, item_id, event_detail FROM event
        WHERE event_id<=? AND event_kind IN ('test-quarantine','accept','reject','reopen','claim','submit','withdraw','merged') ORDER BY event_id`).all(row.event_id);
      const active = quarantinesAt(events, runs, { throughEvent: row.event_id,
        quarantineCoreEngine: QUARANTINE_CORE_ENGINE, autoSubmitEngine: AUTO_SUBMIT_QUARANTINE_ENGINE }).filter(entry => entry.status === 'quarantined');
      previous = { version: 1, eventId: row.event_id, count: active.length, quarantines: active.map(({ file, name, item }) => ({ file, name, item })) };
    }
  }
  const quarantines = readQuarantines(board);
  const latest = new Map(quarantines.map(row => [testKey(row.file, row.name), row]));
  const ledger = readLedger(board);
  const repaired = repairedAt(board, ledger);
  const pairs = [...pairedFlakeObservations(runs, { afterEvent: previous?.eventId ?? 0 }),
    ...legacyFlakeObservations(runs, { afterEvent: previous?.eventId ?? 0 })].filter(row => {
    const quarantine = latest.get(testKey(row.file, row.name));
    return !(repaired.get(testKey(row.file, row.name)) > row.lastEventId)
      && (quarantine?.status !== 'lifted' || !(quarantine.since >= row.lastEventId));
  });
  // A ledger row released after its last sighting is protected like a released pair; a new sighting reopens it.
  const released = row => latest.get(testKey(row.file, row.name))?.status === 'lifted' && latest.get(testKey(row.file, row.name)).since >= row.lastEventId;
  const current = ledger.filter(row => !released(row));
  const observations = [...current, ...pairs].sort((a, b) => (a.lastEventId ?? 0) - (b.lastEventId ?? 0));
  const result = flakeRatchet({ previous, eventId, observations, quarantines });
  // The snapshot hides other connections' writes; a write through this connection mid-capture would mix two boundaries.
  if (board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id !== eventId) {
    throw new Refused('BOARD_BUSY', 'the board changed while capturing the flake ratchet; retry from its current state');
  }
  return result;
}

/** Only executed, source-bound native per-test observations can advance the new quarantine core. */
function structuredRun(run) {
  return !['suite', 'main-red'].includes(run.kind) && Array.isArray(run.testOutcomes) && (run.version === 1 || run.version === 2
    && run.proof?.sourceClean === true && [0, 1].includes(run.proof?.exitCode));
}

/** A Submit diagnostic belongs to its admission, so the general quarantine path cannot count it as a separate run. */
function submitDiagnostic(run) {
  return run.kind === 'check' && run.proof?.submitPhase === 'diagnostic' && run.proof.frozenDigest === null;
}

const OUTCOME_INDEXES = new WeakMap();

/**
 * Index every structured run's per-test outcomes by test identity, so each quarantine reads only the runs that name its
 * test. The index is kept per connection and extended by the runs since: a run is frozen, so a kept prefix never
 * changes, and a prefix whose last run is no longer the same object (a rollback, a refold) is indexed again [C7].
 * Why: each quarantine scanned every run and searched its outcomes, 125 ms per read on 10,000 runs.
 */
function indexOutcomes(board, runs) {
  const known = OUTCOME_INDEXES.get(board.db);
  const reuse = known && known.count <= runs.length && (known.count === 0 || runs[known.count - 1] === known.last);
  const kept = reuse ? known : { count: 0, last: null, byTest: new Map() };
  for (const run of runs.slice(kept.count)) {
    if (!structuredRun(run)) continue;
    const first = new Set();
    for (const row of run.testOutcomes) {
      const key = testKey(row.file, row.name);
      if (first.has(key)) continue;
      first.add(key);
      let list = kept.byTest.get(key);
      if (!list) kept.byTest.set(key, list = []);
      list.push({ eventId: run.eventId, id: run.id, outcome: row });
    }
  }
  kept.count = runs.length;
  kept.last = runs.at(-1) ?? null;
  OUTCOME_INDEXES.set(board.db, kept);
  return kept.byTest;
}

/** Count one identity's actual consecutive verdicts; missing, skipped and duplicate runs add nothing. */
function cleanRunRelease(index, entry) {
  let count = 0;
  const seen = new Set();
  for (const { eventId, id, outcome } of index.get(testKey(entry.file, entry.name)) ?? []) {
    if (eventId <= entry.eventId || seen.has(id)) continue;
    seen.add(id);
    if (outcome.skipped) continue;
    count = outcome.passed ? count + 1 : 0;
    if (count === 20) return { count, releasedAt: eventId };
  }
  return { count, releasedAt: null };
}

/**
 * The quarantines as landing exceptions: the same shape as a person's waiver, but naming both the file and the test, so
 * a same-named test elsewhere is never covered, and living only while the repair item is open. A quarantine waives
 * nothing here unless every run that proved it is a receipt this machine's own gate wrote: a run that reached the board
 * any other way may still file its item, but it never lifts a landing block on this machine.
 */
export function quarantineWaivers(board) {
  if (!quarantineOn(board)) return [];
  const store = boardReceiptStore(board);
  const runs = new Map(gateRuns(board).map(({ eventId, by, ...run }) => [run.id, run]));
  return flakeQuarantines(board).filter(entry => !entry.nativeCore && entry.status === 'quarantined' && entry.runs.every(id => runs.has(id) && receiptBinds(store, runs.get(id))))
    .map(entry => ({ id: `quarantine-${entry.item}`, test: entry.name, kind: 'name', until: FAR_FUTURE, by: 'quarantine', channel: 'board',
      reason: `flaky test, repair #${entry.item} is not verified yet`, quarantine: { file: entry.file, name: entry.name, item: entry.item } }));
}

/** Snapshot current native exceptions only from this board's actual, bound proving receipts. */
export function quarantineVerdictSnapshot(board) {
  if (!quarantineOn(board)) return [];
  const active = flakeQuarantines(board).filter(entry => entry.nativeCore && entry.status === 'quarantined');
  if (!active.length) return [];
  const store = boardReceiptStore(board);
  const runs = new Map(gateRuns(board).map(({ eventId, by, ...run }) => [run.id, run]));
  return active.filter(entry => entry.runs.every(id => runs.has(id) && receiptBinds(store, runs.get(id))))
    .map(({ eventId, item, file, name }) => ({ eventId, item, file, name }));
}

/** Atomic outcomes and replay check current board-owned event authority without touching origin files. */
export function validateQuarantineVerdict(board, receipt, { historical = false } = {}) {
  if (!Object.hasOwn(receipt, 'blockingVerdict')) return;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < QUARANTINE_VERDICT_ENGINE) {
    throw new Refused('ENGINE_VERSION', `computed quarantine verdicts require engine ${QUARANTINE_VERDICT_ENGINE}`);
  }
  const verdict = quarantineVerdictFields(receipt.blockingVerdict, { green: receipt.green,
    exitCode: receipt.version === 2 ? receipt.proof?.exitCode : receipt.blockingVerdict?.exitCode, failures: receipt.failures });
  const active = historical ? board.db.prepare("SELECT event_id, item_id, event_detail FROM event WHERE event_kind = 'test-quarantine' ORDER BY event_id").all().flatMap(row => {
    const detail = JSON.parse(row.event_detail);
    return detail.engine >= QUARANTINE_CORE_ENGINE ? [{ eventId: row.event_id, item: row.item_id, file: detail.file, name: detail.name }] : [];
  }) : flakeQuarantines(board).filter(entry => entry.nativeCore && entry.status === 'quarantined');
  if (!verdict || verdict.quarantines.some(row => !active.some(entry => entry.eventId === row.eventId
    && entry.item === row.item && entry.file === row.file && entry.name === row.name))) {
    throw new Refused('PROOF_RUN_UNBOUND', 'the computed verdict must name current native quarantine events and their exact failed cases');
  }
}

/** Seal actual proving receipt custody before ordering; the atomic validator separately rechecks event authority. */
export function sealQuarantineVerdict(board, receipt, { historical = false } = {}) {
  if (!Object.hasOwn(receipt ?? {}, 'blockingVerdict')) return;
  validateQuarantineVerdict(board, receipt, { historical });
  const runs = new Map(gateRuns(board).map(({ eventId, by, ...run }) => [run.id, run]));
  const store = boardReceiptStore(board);
  const entries = historical ? board.db.prepare("SELECT event_id, item_id, event_detail FROM event WHERE event_kind = 'test-quarantine' ORDER BY event_id").all().flatMap(row => {
    const detail = JSON.parse(row.event_detail);
    return detail.engine >= QUARANTINE_CORE_ENGINE ? [{ ...detail, eventId: row.event_id, item: row.item_id }] : [];
  }) : flakeQuarantines(board).filter(entry => entry.nativeCore && entry.status === 'quarantined');
  if (!historical && !quarantineOn(board) || receipt.blockingVerdict.quarantines.some(row => !entries.some(entry =>
    entry.eventId === row.eventId && entry.item === row.item && entry.file === row.file && entry.name === row.name
    && Array.isArray(entry.runs) && entry.runs.length && entry.runs.every(id => runs.has(id) && receiptBinds(store, runs.get(id)))))) {
    throw new Refused('PROOF_RUN_UNBOUND', 'the quarantine event needs its actual native proving receipts at origin before ordering');
  }
}

/** A cached landing exception must remain the exact recorded receipt, with current authority. */
export function validateQuarantineGate(board, gate, options) {
  if (!Object.hasOwn(gate ?? {}, 'blockingVerdict')) return;
  const id = gate.proofReceiptId ?? gate.receiptId;
  const run = gateRuns(board).find(row => row.id === id);
  if (!run || run.tree !== gate.tree || gate.exitCode !== 1 || run.green !== false
    || gate.isGreen !== run.blockingVerdict?.green
    || JSON.stringify(run.blockingVerdict) !== JSON.stringify(gate.blockingVerdict)
    || JSON.stringify(run.failures) !== JSON.stringify(gate.quarantineFailures?.map(({ file, name }) => ({ file, name })))) {
    throw new Refused('PROOF_RUN_UNBOUND', 'a computed landing verdict needs its exact recorded raw receipt');
  }
  validateQuarantineVerdict(board, run, options);
}

/** Recheck event authority inside the outcome transaction, using only already-recorded native execution identities. */
export function validateQuarantineProofIds(board, item, { agentId, ids, kind, commit, requireGreen = false }) {
  if (!Array.isArray(ids) || !ids.length || ids.length > (kind === 'verdict' ? 1 : 2) || new Set(ids).size !== ids.length) {
    throw new Refused('PROOF_RUN_UNBOUND', 'a computed outcome needs its exact recorded native proof ids');
  }
  const runs = proofReceipts(board, item.item_id);
  for (const id of ids) {
    const run = runs.find(row => row.id === id);
    if (!run || !Object.hasOwn(run, 'blockingVerdict') || run.kind !== kind || run.seat !== agentId
      || run.item !== item.item_id || run.frozenDigest !== item.item_frozen_digest || run.sourceClean !== true
      || run.exitCode !== 1 || commit !== undefined && run.commit !== commit || requireGreen && !nativeProofBlockingGreen(run)) {
      throw new Refused('PROOF_RUN_UNBOUND', 'the quarantine outcome must bind this actor, item, bar and actual native execution');
    }
    validateQuarantineVerdict(board, { green: false, failures: run.failures, blockingVerdict: run.blockingVerdict });
  }
}

/** Only the selected proof grants publication authority; other immutable cache history stays historical. */
export function validateQuarantineLandingProof(board, batch) {
  if (batch.proof?.receipt) {
    validateQuarantineVerdict(board, batch.proof.receipt);
    return;
  }
  const records = landingGateRecords(batch);
  const selected = records.filter(gate => gate?.tree === batch.proof?.tree && gate.logPath === batch.proof?.logPath);
  if (!selected.length && records.some(gate => gate?.tree === batch.proof?.tree && Object.hasOwn(gate, 'blockingVerdict'))) {
    throw new Refused('PROOF_RUN_UNBOUND', 'a computed landing must identify its exact selected gate log');
  }
  for (const gate of selected) validateQuarantineGate(board, gate);
}

/** The open repair item the older paired-rerun ledger already holds for this test, so one test never gets two. */
function existingRepair(board, file, name, landedOnly = false) {
  const row = flakeLedger(board).find(entry => entry.file === file && entry.name === name && entry.item !== null);
  if (!row) return null;
  const item = getItem(board, row.item);
  return (landedOnly ? !item.item_merged_commit && item.item_status !== 'withdrawn' : !['verified', 'withdrawn'].includes(item.item_status)) ? row.item : null;
}

/**
 * The receipt a run carries, checked and normalized, or a refusal naming what a gate run needs.
 *
 * @param {any} receipt
 * @returns {NonNullable<ReturnType<typeof receiptFields>>}
 */
export function runReceipt(receipt) {
  const fields = receiptFields(receipt);
  if (!fields || fields.version !== 1 && !(fields.version === 2 && fields.testOutcomes)) throw new Refused('GATE_RUN_EVIDENCE', 'a gate run needs its receipt: id, tree, command digest, result, failing tests and host load; run the gate again from a clean checkout');
  return fields;
}

/**
 * Refuse a run that is not the gate's own receipt, byte for byte, in the store beside this board. Only the gate's
 * private writer makes that file, right after the process it ran exits, so a run written by hand has nothing to match.
 */
export function requireBound(board, receipt) {
  if (!receiptBinds(boardReceiptStore(board), runReceipt(receipt))) throw new Refused('GATE_RUN_UNBOUND', 'a run counts only as the receipt its own gate stored for it; run the gate, which records its runs itself');
  if (!gateRuns(board).some(run => run.id === receipt.id)) sealQuarantineVerdict(board, receipt);
}

/** Validate the complete gate wire shape and actor before any origin binding or board append. */
function gateRunValue(board, { agentId, receipt }) {
  if (Object.hasOwn(receipt ?? {}, 'testOutcomes') && (board.executionEngineVersion ?? ENGINE_VERSION) < QUARANTINE_CORE_ENGINE) {
    throw new Refused('ENGINE_VERSION', `structured quarantine outcomes require engine ${QUARANTINE_CORE_ENGINE}`);
  }
  if ((Object.hasOwn(receipt ?? {}, 'timing') || Object.hasOwn(receipt ?? {}, 'full'))
    && (board.executionEngineVersion ?? ENGINE_VERSION) < RUN_TIMING_ENGINE) {
    throw new Refused('ENGINE_VERSION', `run phase timings require engine ${RUN_TIMING_ENGINE}`);
  }
  if (Object.hasOwn(receipt ?? {}, 'shadow') && (board.executionEngineVersion ?? ENGINE_VERSION) < SHADOW_TIER1_ENGINE) {
    throw new Refused('ENGINE_VERSION', `tier 1 shadow facts require engine ${SHADOW_TIER1_ENGINE}`);
  }
  if (Object.hasOwn(receipt ?? {}, 'collection') && (board.executionEngineVersion ?? ENGINE_VERSION) < MAIN_AUDIT_ENGINE) {
    throw new Refused('ENGINE_VERSION', `collection receipts require engine ${MAIN_AUDIT_ENGINE}`);
  }
  if (Object.hasOwn(receipt ?? {}, 'environment') && (board.executionEngineVersion ?? ENGINE_VERSION) < LANDING_ENVIRONMENT_ENGINE) throw new Refused('ENGINE_VERSION', `gate environments require engine ${LANDING_ENVIRONMENT_ENGINE}`);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < GATE_RUN_ENGINE) throw new Refused('ENGINE_VERSION', `gate runs require engine ${GATE_RUN_ENGINE}; upgrade Pullboard`);
  if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(agentId)) throw new Refused('NOT_JOINED', 'join this board before recording a gate run');
  const value = runReceipt(receipt);
  if (value.version === 2 && value.proof.seat !== agentId) throw new Refused('GATE_RUN_UNBOUND', 'a native test outcome must be recorded by the seat that executed its proof');
  return value;
}

/**
 * Append one gate run and, when it completes a proof, file the repair item and quarantine the test. A test is proven
 * flaky by two actual structured verdicts for that test on one tree. Legacy receipts retain coordinator-only inference;
 * a different tree, unrelated green case, skipped body or unbound run never supplies the missing verdict.
 *
 * @param {any} board
 * @param {{ agentId: string, receipt: object, lane: string, owners?: Record<string,string> }} request
 * @returns {{ run: object, duplicate?: boolean, quarantined: {file: string, name: string, item: number}[] }}
 */
export function recordGateRun(board, { agentId, receipt, lane, owners, autoSubmit }) {
  const value = gateRunValue(board, { agentId, receipt });
  // A caller's own run must be the receipt its gate stored. A sealed move being replayed was checked where it was made
  // (prepareEngineMove), because another machine holds no copy of that receipt; quarantineWaivers checks again here.
  if (board.executionEngineVersion === undefined) requireBound(board, value);
  return recordSealedGateRun(board, { agentId, receipt: value, lane, owners, autoSubmit });
}

/** Require a diagnostic marker to name an authenticated native grant made before this execution [C7,H16]. */
export function requireSubmitDiagnosticAdmission(board, agentId, value) {
  const proof = value.proof;
  const rows = board.db.prepare("SELECT event_by, item_id, event_at, event_detail FROM event WHERE event_kind IN ('claim','renew') AND json_valid(event_detail) AND json_extract(event_detail,'$.submitAdmission.id')=?").all(proof.diagnosticAdmission);
  const grant = rows.length === 1 ? rows[0] : null;
  const detail = grant && JSON.parse(grant.event_detail);
  if (!grant || grant.event_by !== agentId || proof.seat !== agentId || grant.item_id !== proof.item
    || detail.submitAdmission.commit !== value.head || detail.submitAdmission.tree !== value.tree
    || !Number.isFinite(Date.parse(grant.event_at)) || !(Date.parse(grant.event_at) <= Date.parse(value.at))
    || value.kind === 'submit' && detail.digest !== proof.frozenDigest
    || value.kind === 'check' && (proof.submitPhase !== 'diagnostic' || proof.frozenDigest !== null)) {
    throw new Refused('GATE_RUN_UNBOUND', 'diagnostic quarantine evidence needs its matching prior native Submit admission; run a new admitted Submit');
  }
}

/** Append a gate already bound by the native origin adapter; callers retain pure current-event revalidation. */
export function recordSealedGateRun(board, { agentId, receipt, lane, owners, autoSubmit }) {
  const value = gateRunValue(board, { agentId, receipt });
  const marked = Object.hasOwn(value.proof ?? {}, 'diagnosticAdmission');
  if (marked && autoSubmit === undefined) autoSubmit = true;
  if (autoSubmit !== undefined && (autoSubmit !== true || value.version !== 2 || !['submit', 'check'].includes(value.kind) || value.kind === 'check' && (value.proof.submitPhase !== 'diagnostic' || value.proof.frozenDigest !== null))) throw new Refused('GATE_RUN_EVIDENCE', 'automatic quarantine needs a genuine admitted native Submit receipt');
  if (autoSubmit && (board.executionEngineVersion ?? ENGINE_VERSION) < AUTO_SUBMIT_QUARANTINE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before recording automatic Submit quarantine');
  warmFlakeHistory(board);
  return atomic(board, () => {
    if (marked) requireSubmitDiagnosticAdmission(board, agentId, value);
    if (Object.hasOwn(value, 'collection')) {
      if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator records a landed batch audit');
      const batch = landingBatches(board).find(entry => entry.id === value.collection.batchId);
      if (!batch || batch.state !== 'landed' || batch.tip !== value.head
        || batch.proof?.tree && batch.proof.tree !== value.tree) {
        throw new Refused('GATE_RUN_UNBOUND', 'the audit receipt must name the exact recorded landed batch tip and tree');
      }
    }
    const existing = gateRuns(board).find(entry => entry.id === value.id);
    if (existing) {
      const { eventId, by, ...stored } = existing;
      if (JSON.stringify(stored) !== JSON.stringify(value)) throw new Refused('GATE_RUN_CHANGED', 'a run id already binds different evidence; keep the original and use a new id');
      return { run: stored, duplicate: true, quarantined: [] };
    }
    validateQuarantineVerdict(board, value);
    const engine = Math.max(autoSubmit ? AUTO_SUBMIT_QUARANTINE_ENGINE : 1, value.testOutcomes ? QUARANTINE_CORE_ENGINE : GATE_RUN_ENGINE,
      value.blockingVerdict ? QUARANTINE_VERDICT_ENGINE : GATE_RUN_ENGINE,
      Object.hasOwn(value, 'collection') ? MAIN_AUDIT_ENGINE : GATE_RUN_ENGINE,
      Object.hasOwn(value, 'environment') ? LANDING_ENVIRONMENT_ENGINE : GATE_RUN_ENGINE,
      Object.hasOwn(value, 'timing') ? RUN_TIMING_ENGINE : GATE_RUN_ENGINE,
      Object.hasOwn(value, 'shadow') ? SHADOW_TIER1_ENGINE : GATE_RUN_ENGINE);
    const itemId = value.proof?.item ?? null;
    logEvent(board, agentId, 'gate-run', itemId, { engine, run: value, ...(autoSubmit ? { autoSubmit: true } : {}) });
    if (itemId !== null && value.shadow) logEvent(board, agentId, 'fact', itemId, { id: randomUUID(), kind: 'measurement',
      text: `Tier-1 shadow for gate receipt ${value.id} at ${value.head}: ${value.shadow.verdict}; real gate result: ${value.shadow.real}; differs: ${value.shadow.differs}.`,
      ref: { kind: 'gate-run', id: value.id }, supersedes: null });
    if (autoSubmit) {
      const filed = recordSubmitQuarantines(board, agentId, value);
      // A seat's Submit pair is a pair the landing ratchet counts; file it now, or landing stops until a coordinator run.
      return { run: value, quarantined: backfillRatchetQuarantines(board, agentId, file => ownerLane(owners?.[file] ?? lane), filed) };
    }
    if (value.testOutcomes) return { run: value, quarantined: recordStructuredQuarantines(board, agentId, value, lane, owners) };
    // Only the coordinator's runs prove a flake: its landing and main-checkout gates run accepted work, and no seat can
    // send a move as the coordinator. A seat's runs stay on the board as evidence of what it saw [C7,D1].
    const sameTree = gateRuns(board).filter(entry => entry.tree === value.tree && entry.by === COORDINATOR
      && !['suite', 'main-red'].includes(entry.kind));
    const candidates = new Map();
    for (const entry of sameTree) for (const failure of entry.failures) candidates.set(testKey(failure.file, failure.name), failure);
    const known = new Map(flakeQuarantines(board).map(entry => [testKey(entry.file, entry.name), entry]));
    const filed = [];
    for (const [key, failure] of candidates) {
      const prior = known.get(key);
      if (prior?.status === 'quarantined') continue;
      const since = prior?.since ?? 0;
      const red = sameTree.filter(entry => entry.eventId > since && !entry.green && entry.failures.some(f => testKey(f.file, f.name) === key));
      const green = sameTree.filter(entry => entry.eventId > since && entry.green);
      if (!red.length || !green.length) continue;
      const evidence = [...red, ...green].sort((a, b) => a.eventId - b.eventId);
      const item = existingRepair(board, failure.file, failure.name) ?? addItem(board, { by: agentId, lane, route: 'strong',
        title: `Flaky test: ${failure.file} :: ${failure.name}`.slice(0, 240),
        criterion: `Identify and correct why ${failure.file} :: ${failure.name} fails intermittently on an unchanged tree; prove the correction without retries, and pass the gate.`,
        brief: `One tree went red and green for this test. Tree ${value.tree}. When the coordinator turns quarantine on, the test still runs and reports, but a landing no longer stops on it until this item is verified.\n\n`
          + evidence.map(entry => JSON.stringify({ run: entry.id, kind: entry.kind, at: entry.at, green: entry.green, failing: entry.failures.map(f => f.file + ' :: ' + f.name), load: entry.load })).join('\n') });
      logEvent(board, agentId, 'test-quarantine', item, { engine: GATE_RUN_ENGINE, file: failure.file, name: failure.name, tree: value.tree, runs: evidence.map(entry => entry.id) });
      filed.push({ file: failure.file, name: failure.name, item });
    }
    return { run: value, quarantined: filed };
  });
}

/**
 * Read the gate-run and flake histories before a write takes the board lock, so the write reads only the events
 * since. A caller already inside a transaction reads them there, as before [C7].
 * @param {any} board
 */
export function warmFlakeHistory(board) {
  if (board.db.isTransaction !== false) return;
  gateRunEvents(board);
  flakeEvents(board);
  warmRatchetBoundary(board);
  if (board.db.prepare("SELECT 1 FROM event WHERE event_kind = 'test-quarantine' LIMIT 1").get()) indexOutcomes(board, gateRuns(board));
}

/** File one owner-lane repair when two actual verdicts name the same test and immutable tree. */
function recordStructuredQuarantines(board, agentId, value, lane, owners) {
  const all = gateRuns(board).filter(run => !submitDiagnostic(run)), known = new Map(flakeQuarantines(board).map(row => [testKey(row.file, row.name), row])), filed = [];
  if (structuredRun(value)) {
    const runs = all.filter(run => run.tree === value.tree && structuredRun(run));
    for (const outcome of value.testOutcomes) {
      if (outcome.skipped) continue;
      const key = testKey(outcome.file, outcome.name), prior = known.get(key);
      if (prior?.status === 'quarantined') continue;
      const eligible = runs.filter(run => run.eventId > (prior?.since ?? 0)
        && run.testOutcomes.some(row => !row.skipped && testKey(row.file, row.name) === key));
      const red = eligible.find(run => run.testOutcomes.some(row => testKey(row.file, row.name) === key && !row.skipped && !row.passed));
      const green = eligible.find(run => run.testOutcomes.some(row => testKey(row.file, row.name) === key && !row.skipped && row.passed));
      if (!red || !green || red.id === green.id) continue;
      fileStructuredQuarantine(board, agentId, { file: outcome.file, name: outcome.name, tree: value.tree, red: red.id, green: green.id, lane: owners?.[outcome.file] ?? lane }, known, filed);
    }
  }
  // Backfill: a flake proven on a tree that never runs again would otherwise stay unfiled while the ratchet counts it.
  return backfillRatchetQuarantines(board, agentId, file => owners?.[file] ?? lane, filed, all, known);
}

/** A lane a repair can be filed in; a Submit names its seat's lane, so fall back to core rather than refuse the run. */
function ownerLane(lane) {
  return typeof lane === 'string' && /^[a-z][a-z0-9-]*$/u.test(lane) ? lane : 'core';
}

/**
 * File one repair and quarantine for every same-tree pair the landing ratchet counts and no quarantine answers.
 * Why: the ratchet counts pairs from every recorded run, Submit included, but only coordinator runs filed them, so one
 * flaky Submit stopped every landing until a coordinator gate ran (5 Nov: FLAKE_RATCHET on a seat's Submit pair) [C7].
 */
export function backfillRatchetQuarantines(board, agentId, laneFor, filed = [], runs = gateRuns(board),
  known = new Map(flakeQuarantines(board).map(row => [testKey(row.file, row.name), row]))) {
  for (const pair of backfillPairs(board, runs, flakeLedger(board))) {
    const key = testKey(pair.file, pair.name), prior = known.get(key);
    if (prior?.status === 'quarantined' || prior?.since >= pair.lastEventId) continue;
    fileStructuredQuarantine(board, agentId, { ...pair, red: pair.red.id, green: pair.green.id, lane: laneFor(pair.file) }, known, filed);
  }
  return filed;
}

/** Log one structured quarantine against its repair item, reusing an open repair, and mark the test known. */
function fileStructuredQuarantine(board, agentId, { file, name, tree, red, green, lane }, known, filed) {
  if (typeof lane !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(lane)) throw new Refused('GATE_RUN_EVIDENCE', 'a quarantined test needs its recorded owner lane');
  const item = existingRepair(board, file, name) ?? addItem(board, { by: agentId, lane, route: 'strong',
    title: `Flaky test: ${file} :: ${name}`.slice(0, 240),
    criterion: `Correct why ${file} :: ${name} gives contradictory verdicts on tree ${tree}; retain both runs and prove the correction.`,
    brief: `Structured native quarantine. Test ${file} :: ${name}. Tree ${tree}. Red run ${red}; green run ${green}. The test still runs and is reported. Its actual exit code and blocking verdict are unchanged; 20 actual clean runs or verification of this item releases quarantine.` });
  logEvent(board, agentId, 'test-quarantine', item, { engine: QUARANTINE_CORE_ENGINE, file, name, tree, runs: [red, green] });
  filed.push({ file, name, item });
  known.set(testKey(file, name), { status: 'quarantined' });
}

/** File one core repair only after two separately admitted native Submit contradictions within the rolling day. */
function recordSubmitQuarantines(board, agentId, value) {
  const events = gateRunEvents(board);
  const marked = new Set(events.filter(entry => entry.autoSubmit).map(entry => entry.run.id));
  const runs = events.map(entry => entry.run).filter(run => marked.has(run.id));
  const known = new Map(flakeQuarantines(board).map(row => [testKey(row.file, row.name), row]));
  const filed = [];
  for (const outcome of value.testOutcomes ?? []) {
    if (outcome.skipped) continue;
    const prior = known.get(testKey(outcome.file, outcome.name));
    if (prior?.status === 'quarantined') continue;
    const pairs = submitFlakePairs(runs.filter(run => run.eventId > (prior?.since ?? 0)), outcome.file, outcome.name, value.at);
    if (pairs.length < 2) continue;
    const evidence = pairs.slice(-2).flat();
    const item = existingRepair(board, outcome.file, outcome.name, true) ?? addItem(board, { by: agentId, lane: 'core', route: 'strong',
      title: `Flaky test: ${outcome.file} :: ${outcome.name}`.slice(0, 240),
      criterion: `Correct why ${outcome.file} :: ${outcome.name} fails then passes at unchanged source in separate submits; retain the raw failures and prove the correction without retries.`,
      brief: 'Automatic quarantine after two admitted Submit pairs within 24 hours. The actual failed result and stack remain in each native run log. Quarantine ends only after this repair lands.\n\n'
        + evidence.map(run => `Native receipt ${run.id}; admission ${run.proof.diagnosticAdmission}; tree ${run.tree}; ${run.green ? 'pass' : 'fail'}; ${run.at}`).join('\n') });
    logEvent(board, agentId, 'test-quarantine', item, { engine: AUTO_SUBMIT_QUARANTINE_ENGINE, autoSubmit: true,
      file: outcome.file, name: outcome.name, tree: value.tree, runs: evidence.map(run => run.id) });
    filed.push({ file: outcome.file, name: outcome.name, item });
    known.set(testKey(outcome.file, outcome.name), { status: 'quarantined' });
  }
  return filed;
}

/** Select genuine repeated Submit contradictions without lending skips or deterministic reds authority [C7,H16]. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Return at most one ordered same-tree red/pass pair from each distinct native Submit admission within 24 hours. */
export function submitFlakePairs(runs, file, name, at) {
  const end = Date.parse(at), admissions = new Map();
  if (!Number.isFinite(end)) return [];
  for (const run of runs) {
    const proof = run.proof, time = Date.parse(run.at);
    const outcome = run.testOutcomes?.find(row => row.file === file && row.name === name);
    const diagnostic = run.kind === 'check' && proof?.submitPhase === 'diagnostic' && proof.frozenDigest === null;
    if (!(run.kind === 'submit' || diagnostic) || run.version !== 2 || proof?.sourceClean !== true
      || ![0, 1].includes(proof.exitCode) || !proof.diagnosticAdmission || !run.tree
      || !Number.isFinite(time) || time > end || time < end - DAY_MS || !outcome || outcome.skipped) continue;
    // Each pair keeps its own tree and actor/item; unrelated phases cannot complete another submit's evidence.
    const key = JSON.stringify([proof.diagnosticAdmission, proof.seat, proof.item, run.tree]);
    const group = admissions.get(key) ?? [];
    if (!group.some(entry => entry.run.id === run.id)) group.push({ run, time, passed: outcome.passed, diagnostic });
    admissions.set(key, group);
  }
  const pairs = new Map();
  for (const group of admissions.values()) {
    group.sort((a, b) => a.time - b.time);
    const red = group.find(entry => !entry.passed && !entry.diagnostic);
    const green = red && group.find(entry => entry.passed && entry.diagnostic && entry.time > red.time);
    if (green && !pairs.has(red.run.proof.diagnosticAdmission)) pairs.set(red.run.proof.diagnosticAdmission, [red.run, green.run]);
  }
  return [...pairs.values()];
}
