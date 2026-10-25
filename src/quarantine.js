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
  listAgents,
  logEvent,
} from './board.js';
import { GATE_RUN_ENGINE } from './gate-run-engine.js';
import { LANDING_ENVIRONMENT_ENGINE } from './landing-environment-engine.js';
import {
  boardReceiptStore,
  receiptBinds,
  receiptFields,
} from './gate-run-receipt.js';
import { COORDINATOR } from './config.js';
import { flakeLedger } from './flakes.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';

const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

/** Quarantine is the coordinator's opt-in: the board reads it from accepted main's pullboard.json, never from a branch. */
export function quarantineOn(board) {
  try { return board.quarantineEnabled?.() === true; } catch { return false; }
}

/** The one identity of a test across runs: its committed file and its structured name. */
function testKey(file, name) { return JSON.stringify([file, name]); }

/** Every recorded gate run, oldest first, with the event that carries it and the seat that recorded it. */
export function gateRuns(board) {
  return board.db.prepare("SELECT event_id, event_by, event_detail FROM event WHERE event_kind = 'gate-run' ORDER BY event_id").all()
    .map(row => ({ eventId: row.event_id, by: row.event_by, ...JSON.parse(row.event_detail).run }));
}

/**
 * Where a test's quarantine stands. Quarantined means its repair item is still being fixed; lifted means that item was
 * verified or withdrawn, so the test blocks again, and `since` is the event after which only newer runs count as proof.
 */
export function flakeQuarantines(board) {
  const latest = new Map();
  for (const row of board.db.prepare("SELECT event_id, item_id, event_detail FROM event WHERE event_kind = 'test-quarantine' ORDER BY event_id").all()) {
    const detail = JSON.parse(row.event_detail);
    latest.set(testKey(detail.file, detail.name), { file: detail.file, name: detail.name, item: row.item_id, tree: detail.tree, runs: detail.runs, eventId: row.event_id });
  }
  return [...latest.values()].map(entry => {
    const state = getItem(board, entry.item).item_status;
    const lifted = state === 'verified' || state === 'withdrawn';
    const closing = lifted ? board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE item_id = ? AND event_kind IN ('accept','withdraw')").get(entry.item).id : null;
    return { ...entry, status: lifted ? 'lifted' : 'quarantined', since: Math.max(entry.eventId, closing ?? 0) };
  });
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
  return flakeQuarantines(board).filter(entry => entry.status === 'quarantined' && entry.runs.every(id => runs.has(id) && receiptBinds(store, runs.get(id))))
    .map(entry => ({ id: `quarantine-${entry.item}`, test: entry.name, kind: 'name', until: FAR_FUTURE, by: 'quarantine', channel: 'board',
      reason: `flaky test, repair #${entry.item} is not verified yet`, quarantine: { file: entry.file, name: entry.name, item: entry.item } }));
}

/** The open repair item the older paired-rerun ledger already holds for this test, so one test never gets two. */
function existingRepair(board, file, name) {
  const row = flakeLedger(board).find(entry => entry.file === file && entry.name === name && entry.item !== null);
  return row && !['verified', 'withdrawn'].includes(getItem(board, row.item).item_status) ? row.item : null;
}

/**
 * The receipt a run carries, checked and normalized, or a refusal naming what a gate run needs.
 *
 * @param {any} receipt
 * @returns {NonNullable<ReturnType<typeof receiptFields>>}
 */
export function runReceipt(receipt) {
  const fields = receiptFields(receipt);
  if (!fields || fields.version !== 1) throw new Refused('GATE_RUN_EVIDENCE', 'a gate run needs its receipt: id, tree, command digest, result, failing tests and host load; run the gate again from a clean checkout');
  return fields;
}

/**
 * Refuse a run that is not the gate's own receipt, byte for byte, in the store beside this board. Only the gate's
 * private writer makes that file, right after the process it ran exits, so a run written by hand has nothing to match.
 */
export function requireBound(board, receipt) {
  if (!receiptBinds(boardReceiptStore(board), runReceipt(receipt))) throw new Refused('GATE_RUN_UNBOUND', 'a run counts only as the receipt its own gate stored for it; run the gate, which records its runs itself');
}

/**
 * Append one gate run and, when it completes a proof, file the repair item and quarantine the test. A test is proven
 * flaky only by a tree the coordinator's gate ran red in one run and green in another for that same test; a rerun of a
 * different tree, a failure that never went green, or a seat's own run proves nothing and quarantines nothing.
 *
 * @param {any} board
 * @param {{ agentId: string, receipt: object, lane: string }} request
 * @returns {{ run: object, duplicate?: boolean, quarantined: {file: string, name: string, item: number}[] }}
 */
export function recordGateRun(board, { agentId, receipt, lane }) {
  if (Object.hasOwn(receipt ?? {}, 'environment') && (board.executionEngineVersion ?? ENGINE_VERSION) < LANDING_ENVIRONMENT_ENGINE) throw new Refused('ENGINE_VERSION', `gate environments require engine ${LANDING_ENVIRONMENT_ENGINE}`);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < GATE_RUN_ENGINE) throw new Refused('ENGINE_VERSION', `gate runs require engine ${GATE_RUN_ENGINE}; upgrade Pullboard`);
  if (!listAgents(board).some(agent => agent.agent_id === agentId)) throw new Refused('NOT_JOINED', 'join this board before recording a gate run');
  const value = runReceipt(receipt);
  // A caller's own run must be the receipt its gate stored. A sealed move being replayed was checked where it was made
  // (prepareEngineMove), because another machine holds no copy of that receipt; quarantineWaivers checks again here.
  if (board.executionEngineVersion === undefined) requireBound(board, value);
  return atomic(board, () => {
    const existing = gateRuns(board).find(entry => entry.id === value.id);
    if (existing) {
      const { eventId, by, ...stored } = existing;
      if (JSON.stringify(stored) !== JSON.stringify(value)) throw new Refused('GATE_RUN_CHANGED', 'a run id already binds different evidence; keep the original and use a new id');
      return { run: stored, duplicate: true, quarantined: [] };
    }
    logEvent(board, agentId, 'gate-run', null, { engine: Object.hasOwn(value, 'environment') ? LANDING_ENVIRONMENT_ENGINE : GATE_RUN_ENGINE, run: value });
    // Only the coordinator's runs prove a flake: its landing and main-checkout gates run accepted work, and no seat can
    // send a move as the coordinator. A seat's runs stay on the board as evidence of what it saw [C7,D1].
    const sameTree = gateRuns(board).filter(entry => entry.tree === value.tree && entry.by === COORDINATOR);
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
