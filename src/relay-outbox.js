/**
 * The ordered outbox (#922): board moves made on an accepted relay link while the relay is unavailable, sealed on
 * this machine with the board as the relay last ordered it, until they replay in relay order.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import {
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import * as store from './board.js';
import {
  engineReceipt,
  executableArgs,
  prepareEngineMove,
} from './engine.js';
import {
  exportBoard,
  restoreRelaySnapshot,
} from './exchange.js';
import { readBoardKey } from './relay-key.js';
import { leaveConflictNotice } from './relay-conflicts.js';
import { withOutboxGuard } from './relay-outbox-guard.js';
import { transientRelayFailure } from './relay-move-fallback.js';
import {
  refuseRevokedSeat,
  seatReceipt,
  withSeatName,
} from './relay-seats.js';
import {
  credentialActor,
  operationIntent,
  relayMoveActor,
} from './relay-sender.js';
import {
  seal,
  unseal,
} from './seal.js';
import { captureBoardChanges } from './board-capture.js';
import { undoQueued } from './relay-outbox-undo.js';
import { stampCoordinatorHolder } from './coordinator-hold.js';
import { Refused } from './refused.js';
import {
  outboxFile,
  outboxSummaryFile,
  readOutboxSummary,
} from './relay-outbox-summary.js';
export {
  outboxFile,
  outboxSummaryFile,
  readOutboxSummary,
};
import {
  createdItemAt,
  createsItems,
  entryCreatedItems,
  rememberCreatedItems,
} from './relay-created-items.js';

/** How many replay refusals the link keeps for pullboard status; older ones stay in the relay's own receipts. */
const KEPT_REFUSALS = 20;

/** Commands that already said their move waits in the outbox, so a command says it once. */
const OUTBOX_NOTICES = new WeakSet();

/** Whether a link holds moves the relay has not ordered yet, while the local board still shows them applied. */
export function outboxAhead(state) {
  return Boolean(state?.outbox?.moves?.length) && state.outbox.restored !== true;
}

/**
 * Read and open the sealed outbox, or null when there is none.
 * Why: the board image and the queued moves are as private as the relay's own sealed records, so they stay sealed at rest.
 */
export async function readOutbox(file, key, boardId) {
  if (!existsSync(file)) return null;
  const plain = await unseal(key, readFileSync(file), { boardId, kind: 'outbox', sequence: 0 });
  const document = JSON.parse(gunzipSync(plain).toString('utf8'));
  // Version 3 (#1013) keeps no board image: each move carries the rows it changed, to be taken back by them.
  if (![1, 2, 3].includes(document?.version) || !Array.isArray(document.moves) || !(document.base || document.version === 3) || !Number.isSafeInteger(document.baseSequence)) {
    throw new Refused('RELAY_OUTBOX', 'the relay outbox on this machine is unreadable; keep it, and ask for help before relinking this board');
  }
  return document;
}

/** The item currently created by a queued move, before the relay has made its number authoritative. */
export async function outboxHasPendingCreatedItem(file, key, boardId, itemId) {
  if (!Number.isSafeInteger(itemId) || itemId < 1) return false;
  const outbox = await readOutbox(file, key, boardId);
  return Boolean(outbox?.moves.some(entry => entryCreatedItems(entry).some(created => created.item === itemId)));
}

/** Seal and atomically replace the outbox, readable only by this user. */
export async function writeOutbox(file, key, boardId, document) {
  // Old clients must refuse richer result bindings rather than treating temporary item numbers as final.
  if (!document.base) document.version = 3;
  else if (document.moves.some(entry => (entry.move.operation !== 'addItem' && createsItems(entry.move.operation))
      || entry.created?.some(row => row.resultPath.length)
      || entry.refs?.some(ref => ref.resultPath?.length))) document.version = 2;
  const sealed = await seal(key, gzipSync(Buffer.from(JSON.stringify(document))), { boardId, kind: 'outbox', sequence: 0 });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, Buffer.from(sealed), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Remove the outbox once every move in it has been ordered. */
export function removeOutbox(file) {
  rmSync(file, { force: true });
}

/** The item a move acts on, when its first argument names one. */
function moveItem(move) {
  return Number.isSafeInteger(move?.args?.[0]) ? move.args[0] : null;
}

/** Name a move for people: its operation, its item and who made it. */
export function describeMove(move) {
  const item = moveItem(move);
  return `${move.operation}${item === null ? '' : ` #${item}`}${move.actor ? ` by ${move.actor}` : ''}`;
}

/** The key-free line pullboard status keeps for one queued move. */
export function outboxEntrySummary(entry) {
  return { id: entry.move.id, operation: entry.move.operation, item: moveItem(entry.move), actor: entry.move.actor ?? null, queuedAt: entry.queuedAt };
}

/**
 * The moves the relay ordered after a queued move was made and before it replayed, on the same item when any are,
 * so a refusal at replay names what came first.
 * Why: a refused replay that named only itself would leave the person to guess which other machine's move won.
 */
export function earlierMoves(board, entry, sequence) {
  const rows = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'").all();
  const between = [];
  for (const { meta_value: value } of rows) {
    let receipt;
    try { receipt = JSON.parse(value); } catch { continue; }
    if (!(receipt.sequence > entry.after && receipt.sequence < sequence)) continue;
    let move;
    try { move = JSON.parse(receipt.move); } catch { continue; }
    if (move.id === entry.move.id) continue;
    between.push({ sequence: receipt.sequence, move });
  }
  const item = moveItem(entry.move);
  const same = item === null ? [] : between.filter(({ move }) => moveItem(move) === item);
  return (same.length ? same : between).sort((a, b) => a.sequence - b.sequence).slice(-3)
    .map(({ sequence: at, move }) => ({ sequence: at, move: describeMove(move) }));
}

/** Keep one replay refusal on the link for pullboard status, newest last, and return its line. */
export function keepRefusal(state, entry, refusal, earlier) {
  const kept = { move: describeMove(entry.move), queuedAt: entry.queuedAt, code: refusal.code, message: refusal.message, earlier };
  state.outboxRefusals = [...(state.outboxRefusals ?? []), kept].slice(-KEPT_REFUSALS);
  return refusalLine(kept);
}

/** Say what a refused replay was, which move won, and which ordered moves came first. */
export function refusalLine(kept) {
  const winner = kept.earlier.at(-1);
  const first = kept.earlier.length
    ? `; won by sequence ${winner.sequence} ${winner.move}; moves the relay ordered first: ${kept.earlier.map(({ sequence, move }) => `sequence ${sequence} ${move}`).join(', ')}`
    : '; no other move reached the relay first';
  return `[RELAY_OUTBOX_REFUSED] the queued move ${kept.move} (made ${kept.queuedAt}) was refused when it replayed: [${kept.code}] ${kept.message}${first}`;
}

/** The ordered operations whose first argument is an item number; a decision's answer names a shout instead. */
const FIRST_ITEM = ['approveOutside', 'signBar', 'editItem', 'completeCheckBaseline', 'escalate', 'recordAttempt', 'claim', 'release', 'submit', 'reserveReview', 'verify',
  'merged', 'withdraw', 'refreeze', 'reopen', 'holdItem', 'releaseItemHold', 'appendFact', 'acceptCheck'];

/**
 * Where each ordered operation names an item, as paths into its arguments: `*` is every element of a list. Every
 * engine operation is listed, most with no item field, so a new operation must say where its items sit
 * (test/relay-outbox.test.js walks them all) (#922).
 */
export const ITEM_SLOTS = Object.freeze({
  setBarReady: [], setLineSetting: [], setLaneLead: [],
  requestCompanion: [[0, 'parentId']],
  recordPublishFinding: [[0, 'item']],
  register: [], ensureCoordinator: [], shout: [], passDecision: [], holdLane: [], releaseLane: [],
  moveMilestone: [], editMilestone: [], removeMilestone: [], shipMilestone: [],
  recordRowDecisions: [], decideSpecRevisions: [], applyRowDecisions: [], draftSpecRow: [], recordSpecApprovalBaseline: [],
  recordLandingBatch: [], recordLandingWaiver: [], recordLandingFlake: [], recordLandingTestDefect: [], finishLandingBatch: [],
  recordHealthFindings: [], decideSentinel: [], beginSentinelRun: [], finishSentinelRun: [],
  recordFlakeObservation: [], recordGateRun: [], recordProofRun: [[0, 'itemId'], [0, 'receipt', 'proof', 'item']], declareJob: [], recordJobRun: [], takeCoordinator: [], openHandoff: [], landingLeaseMove: [], setPersonSigning: [], proposePersonMove: [],
  recordActivityDelivery: [], actOnActivity: [], recordRowVerification: [], setBoardMembers: [],
  // Re-home IDs are acknowledged-only; foreign board/source IDs are never locally rewritten.
  reserveRehomeItemId: [], rehomeItem: [[0]], applyRehomeItem: [[0, 'destinationItemId']],
  ...Object.fromEntries(FIRST_ITEM.map((operation) => [operation, [[0]]])),
  intakeOutside: [[0, 'item', 'parentId'], [0, 'item', 'after', '*']],
  addItem: [[0, 'parentId'], [0, 'after', '*']],
  editItem: [[0], [1, 'after', '*']],
  verify: [[0], [1, 'implies', '*']],
  appendFact: [[0], [1, 'implies', '*']],
  answerDecision: [[1, 'implies', '*']],
  reserveNextReview: [[0, 'skipIds', '*']],
  addMilestone: [[0, 'items', '*']],
  editMilestoneItems: [[1, 'add', '*'], [1, 'remove', '*']],
  orderMilestoneItems: [[1, 'items', '*']],
  takeHandoff: [[0, 'item']],
  proposeSentinel: [[0, 'evidence', 'items', '*', 'id']],
});

/** An item number as a move holds it: a whole number, or the CLI's "12" or "#12". */
function itemNumber(value) {
  if (Number.isSafeInteger(value)) return value;
  const match = typeof value === 'string' ? /^#?(\d{1,15})$/u.exec(value.trim()) : null;
  return match ? Number(match[1]) : null;
}

/** Write a number back in the form the move held it, so a string stays a string. */
function sameForm(old, value) {
  return typeof old === 'string' ? `${old.trim().startsWith('#') ? '#' : ''}${value}` : value;
}

/** Every concrete path in a move's arguments that one declared slot pattern reaches. */
function expand(args, pattern) {
  let paths = [[]];
  for (const key of pattern) {
    paths = paths.flatMap((path) => {
      const at = path.reduce((value, step) => value?.[step], args);
      if (key !== '*') return at !== null && typeof at === 'object' && Object.hasOwn(at, key) ? [[...path, key]] : [];
      return Array.isArray(at) ? at.map((_, index) => [...path, index]) : [];
    });
  }
  return paths;
}

/** Where a move names an item, as concrete paths into its arguments. */
function itemSlots(move) {
  return (ITEM_SLOTS[move.operation] ?? []).flatMap((pattern) => expand(move.args, pattern))
    .filter((path) => itemNumber(slot(move, path)) !== null);
}

/** Read or write the value at one slot of a move's arguments. */
function slot(move, path, value) {
  const holder = path.slice(0, -1).reduce((at, key) => at[key], move.args);
  if (value !== undefined) holder[path.at(-1)] = value;
  return holder[path.at(-1)];
}

/** Keys under which a move might name an item that no declared slot reaches. */
const ITEM_KEYS = /^(id|ids|item|items|itemId|parentId|after|implies|add|remove|skipIds)$/u;

/** Moves whose IDs and results have to be ordered by the relay; they cannot become provisional outbox state [E15,H16]. */
export const ACKNOWLEDGED_OPERATIONS = Object.freeze([
  'register', 'ensureCoordinator', 'takeCoordinator', 'landingLeaseMove',
  'reserveRehomeItemId', 'rehomeItem', 'applyRehomeItem',
]);

/**
 * Item numbers of offline adds that a move names outside its declared slots. Such a move is refused rather than
 * queued, because the outbox could not follow the item if the relay renumbers it (#922).
 */
export function strayItemRefs(outbox, move) {
  const pending = new Set(outbox.moves.flatMap(entryCreatedItems).map(row => row.item));
  if (!pending.size) return [];
  const declared = new Set(itemSlots(move).map((path) => JSON.stringify(path)));
  const found = [];
  const walk = (value, path, itemish) => {
    if (Array.isArray(value)) { value.forEach((element, index) => walk(element, [...path, index], itemish)); return; }
    if (value !== null && typeof value === 'object') { for (const [key, inner] of Object.entries(value)) walk(inner, [...path, key], ITEM_KEYS.test(key)); return; }
    const number = itemNumber(value);
    if (itemish && number !== null && pending.has(number) && !declared.has(JSON.stringify(path))) found.push(number);
  };
  // A bare top-level number is an item only through a declared slot; a decision's first argument names a shout.
  move.args.forEach((value, index) => walk(value, [index], false));
  return found;
}

/**
 * Bind the item numbers a new move names to the queued adds that made those items here, by the add's move id.
 * Why: a number shown on this machine for an item it added offline is temporary; the relay may give another machine
 * that number, and a replay part way through renumbers it here, so only the add itself names the item (#922).
 */
export function bindRefs(outbox, move) {
  const pending = new Map(outbox.moves.flatMap(entry => entryCreatedItems(entry).map(row => [row.item,
    { add: entry.move.id, ...(row.resultPath.length ? { resultPath: row.resultPath } : {}) }])));
  return itemSlots(move).filter((path) => pending.has(itemNumber(slot(move, path))))
    .map(path => ({ path, ...pending.get(itemNumber(slot(move, path))) }));
}

/**
 * The move to send or apply: each bound number becomes its add's item, as the relay numbered it, or as this machine
 * shows it now when `local` and the add still waits. `lost` names the slots whose add was refused at replay.
 */
export function resolveMove(entry, outbox, { local = false } = {}) {
  const move = structuredClone(entry.move);
  const lost = [];
  for (const { path, add, resultPath = [] } of entry.refs ?? []) {
    const waiting = local ? outbox.moves.find((other) => other.move.id === add) : null;
    const result = outbox.results?.[add];
    const value = waiting ? entryCreatedItems(waiting).find(row => JSON.stringify(row.resultPath) === JSON.stringify(resultPath))?.item
      : createdItemAt(result, resultPath);
    if (result === null && !waiting || value === undefined) lost.push(itemNumber(slot(entry.move, path)));
    else if (Number.isSafeInteger(value)) slot(move, path, sameForm(slot(entry.move, path), value));
  }
  return { move, lost };
}

/** Drop the replayed move from the outbox and save what is left. */
async function finishEntry(link, outbox, where, key) {
  outbox.moves.shift();
  if (outbox.moves.length) await writeOutbox(where, key, link.state.board, outbox);
  else removeOutbox(where);
  saveOutboxSummary(link, outbox);
}

/** The queued moves and replay refusals pullboard status shows, when there are any. */
export function outboxFields(state) {
  return { ...(state?.outbox?.moves?.length ? { outbox: structuredClone(state.outbox.moves) } : {}),
    ...(state?.outboxRefusals?.length ? { outboxRefusals: structuredClone(state.outboxRefusals) } : {}),
    ...(state?.outboxRenumbered?.length ? { outboxRenumbered: structuredClone(state.outboxRenumbered) } : {}) };
}

/** Whether this command may queue a move in the ordered outbox: the board's relay.outbox setting, on unless opted out (#922,H21). */
function outboxEnabled(io) {
  try { return io?.relayOutbox?.() === true; } catch { return false; }
}

/**
 * Whether a failure on an accepted link may queue the move instead of refusing it (#922): the relay said nothing
 * definite, and the move needs no relay answer to exist. Ephemeral sessions cannot retain an outbox, while
 * registration, takeover, person requests and landing authority need an acknowledgment.
 */
export function outboxQueueable(state, error, operation, io, args = []) {
  return state.mode === 'ordered' && state.baselineAccepted === true && !state.baselineConflict && !state.environment
    && process.env.PULLBOARD_RELAY_TOKEN === undefined && !io?.relayCanary && !io?.personRequest && !io?.personRequestMoveId
    && !ACKNOWLEDGED_OPERATIONS.includes(operation)
    && !args.some(arg => arg?.landingFence !== undefined) && transientRelayFailure(error) && outboxEnabled(io);
}

/** Keep the key-free outbox summary beside the link, or drop it once the outbox is empty. */
function saveOutboxSummary({ file, state }, outbox) {
  const where = outboxSummaryFile(file);
  if (outbox?.moves.length) {
    state.outbox = { restored: outbox.restored, moves: outbox.moves.map(outboxEntrySummary) };
    mkdirSync(dirname(where), { recursive: true, mode: 0o700 });
    const temporary = where + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(state.outbox) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, where);
    } finally { rmSync(temporary, { force: true }); }
  } else {
    delete state.outbox;
    rmSync(where, { force: true });
  }
}

/** Whether a move waits in the outbox now, read from disk rather than from a link loaded earlier. */
export function outboxWaiting(linkFile) {
  return existsSync(outboxFile(linkFile));
}

/** The file counting moves ever queued on this board, beside its link. */
function generationFile(linkFile) {
  return join(dirname(linkFile), 'relay-outbox.generation');
}

/**
 * How many moves this machine has queued on the board, as a number that only grows.
 * Why: a checkpoint read without the outbox guard is safe to publish only if no move was queued while it was read,
 * since a queued move shows on the board before the relay orders it (#1013).
 */
export function outboxGeneration(linkFile) {
  try { return Number(readFileSync(generationFile(linkFile), 'utf8')) || 0; } catch { return 0; }
}

/** Count one more queued move. */
function bumpGeneration(linkFile) {
  writeFileSync(generationFile(linkFile), `${outboxGeneration(linkFile) + 1}\n`, { mode: 0o600 });
}

/**
 * Queue a move on an accepted link, then make it on this machine (#922, #1013). The caller holds the outbox guard.
 * The first queued move seals the board as the relay last ordered it; the move is written before it is applied, so
 * a crash between the two leaves it queued and the next rebuild starts from that image anyway. A move this board
 * refuses is refused now and never queued. `quiet` is a local-first move, which says nothing: queuing is normal.
 */
export async function queueMove(link, { operation, args, command, move, error, applyLocally, quiet = false }) {
  const { root, file, state, io, localRecords, safePauseCode, safePauseMessage } = link;
  if (ACKNOWLEDGED_OPERATIONS.includes(operation)) {
    throw new Refused('RELAY_OUTBOX_UNBOUND', 'this move needs the relay to acknowledge its IDs and result; retry it when the relay answers');
  }
  const key = readBoardKey(state.board);
  const where = outboxFile(file);
  // A new outbox holds no board image: the moves are taken back by their own rows, so queuing costs no export.
  const outbox = await readOutbox(where, key, state.board)
    ?? { version: 3, baseSequence: localRecords(root, appliedSequence), restored: false, moves: [] };
  if (!move) {
    const sent = withSeatName(root, operation, args);
    move = stampCoordinatorHolder(localRecords(root, (board) => prepareEngineMove(board, operation, sent)), state.machine, state.computerName);
    move.actor = relayMoveActor(move) ?? credentialActor(move);
  }
  refuseRevokedSeat(state, credentialActor(move));
  const stray = strayItemRefs(outbox, move);
  if (stray.length) {
    throw new Refused('RELAY_OUTBOX_UNBOUND', `this move names #${stray[0]}, which this machine added while the relay was down, in a field the outbox cannot follow if the relay renumbers it; run it again once the relay answers`);
  }
  // `after` is the relay sequence this machine had seen: a refusal at replay names the moves ordered since.
  const entry = { move, refs: bindRefs(outbox, move), intent: operationIntent(operation, args), queuedAt: new Date().toISOString(),
    after: Math.max(state.sequence, outbox.baseSequence),
    ...(command ? { command, commandIntent: operationIntent('cli:' + command.cliOperation, command) } : {}) };
  // The row counters as they were before this move, so taking it back puts the next numbers back too.
  entry.sequences = localRecords(root, rowCounters);
  outbox.moves.push(entry);
  bumpGeneration(file);
  // Written before it is applied: a crash between leaves a move with no captured rows, which a rebuild from the
  // relay's checkpoint takes care of.
  await writeOutbox(where, key, state.board, outbox);
  if (state.pending?.move?.id === move.id) {
    delete state.pending;
    link.saveLink(file, state);
  }
  saveOutboxSummary(link, outbox);
  let result;
  try {
    const applied = await captureBoardChanges(() => applyLocally());
    result = applied.result;
    entry.changes = encodeChanges(applied.changes);
  } catch (refusal) {
    outbox.moves.pop();
    if (outbox.moves.length) await writeOutbox(where, key, state.board, outbox);
    else removeOutbox(where);
    saveOutboxSummary(link, outbox);
    throw refusal;
  }
  rememberCreatedItems(entry, result);
  await writeOutbox(where, key, state.board, outbox);
  if (!quiet && !OUTBOX_NOTICES.has(io)) {
    OUTBOX_NOTICES.add(io);
    io.err(`pullboard: [${safePauseCode(error)}] ${error.transportFailure ? `the relay did not answer (${error.transportFailure})` : safePauseMessage(error)}; the move is saved on this machine and waits in the relay outbox (${outbox.moves.length} pending); it goes up in order when the relay answers, and pullboard status lists it`);
  }
  return result;
}

/** Most send-and-rebuild rounds one flush takes before it leaves the rest to the next. */
const FLUSH_ROUNDS = 100;

/** The board's relay-applied sequence. */
function appliedSequence(board) {
  return Number(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'relay_applied_sequence'").get()?.meta_value ?? 0);
}

/** The board's row counters, which SQLite keeps outside any row a changeset records. */
function rowCounters(board) {
  return board.db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all().map((row) => ({ name: row.name, seq: row.seq }));
}

/** Changesets as the outbox keeps them. */
function encodeChanges(changes) {
  return changes.map((change) => Buffer.from(change).toString('base64'));
}

/** Make one queued move on this board again, recording its rows; null when the board now refuses it. */
async function reapply(link, outbox, entry) {
  const { root, localRecords } = link;
  const { move } = resolveMove(entry, outbox, { local: true });
  entry.sequences = localRecords(root, rowCounters);
  const applied = await captureBoardChanges(() => localRecords(root, (board) => {
    try { return store.atomic(board, () => store[move.operation](board, ...executableArgs(move, board))); }
    catch (error) { if (!(error instanceof Refused)) throw error; return null; }
  }));
  entry.changes = encodeChanges(applied.changes);
  return applied.result;
}

/**
 * Take every queued move back so the board is exactly as the relay last ordered it; false when that cannot be done
 * row for row (a move with no captured rows, or a row changed in a way the undo cannot follow), and the caller
 * restores the relay's checkpoint instead. Each seat's newer shout-read position is kept, as a restore keeps it.
 */
function takeBack(link, outbox) {
  const { root, localRecords } = link;
  if (!outbox.moves.every((entry) => Array.isArray(entry.changes) && Array.isArray(entry.sequences))) {
    link.io.err('pullboard: a queued move has no recorded rows; the board is rebuilt from the relay checkpoint');
    return false;
  }
  return localRecords(root, (board) => {
    const cursors = board.db.prepare('SELECT agent_id, agent_last_shout_id FROM agent').all();
    const problem = undoQueued(board, outbox.moves);
    if (problem) {
      link.io.err(`pullboard: the queued moves cannot be taken back row for row (${problem}); the board is rebuilt from the relay checkpoint`);
      return false;
    }
    if (appliedSequence(board) !== outbox.baseSequence) {
      link.io.err(`pullboard: taking the queued moves back left the board at relay sequence ${appliedSequence(board)}, not ${outbox.baseSequence}; the board is rebuilt from the relay checkpoint`);
      return false;
    }
    keepNewerCursors(board, cursors);
    return true;
  });
}

/** Keep each seat's newer shout-read position over the one an undo or restore put back. */
function keepNewerCursors(board, cursors) {
  const keep = board.db.prepare('UPDATE agent SET agent_last_shout_id = ? WHERE agent_id = ? AND (agent_last_shout_id IS NULL OR agent_last_shout_id < ?)');
  for (const row of cursors) if (Number.isSafeInteger(row.agent_last_shout_id)) keep.run(row.agent_last_shout_id, row.agent_id, row.agent_last_shout_id);
}

/**
 * Read every record the relay ordered after the outbox's base image. Network only: the board is not touched. When
 * the relay compacted that prefix, its checkpoint stands in for the base.
 *
 * @returns {Promise<{ baseSequence: number, checkpoint?: { native: any, sequence: number }, events: any[] } | null>}
 */
async function pullSinceBase(link, key, { fromCheckpoint = false } = {}) {
  const { file, state, io, request } = link;
  const outbox = await readOutbox(outboxFile(file), key, state.board);
  if (!outbox?.moves.length) return null;
  const events = async (after) => {
    const remote = await request(state, '/api/v1/boards/' + state.board + '/events?after=' + after, {}, io);
    if ([remote.warning, ...(remote.warnings ?? [])].some((warning) => warning?.code === 'KEY_REQUESTS')) io.keyRequestsWaiting = true;
    if (!Array.isArray(remote.events) || remote.events.some((record, index) => !record || record.event_id !== after + index + 1 || !['move', 'request'].includes(record.kind) || typeof record.sealed !== 'string')) {
      throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid ordered prefix; fetch a consistent relay snapshot');
    }
    return remote.events;
  };
  if (fromCheckpoint) {
    const checkpoint = await link.fetchCheckpoint(key);
    // A checkpoint older than the moves' base cannot stand in for it: the board would go back past what it shows.
    if (checkpoint.sequence < outbox.baseSequence) throw new Refused('RELAY_OUTBOX', `this machine cannot take its queued moves back, and the relay checkpoint (sequence ${checkpoint.sequence}) is older than the board they sit on (sequence ${outbox.baseSequence}); keep the board as it is and ask the person to publish a newer checkpoint from another machine`);
    return { baseSequence: outbox.baseSequence, checkpoint, events: await events(checkpoint.sequence) };
  }
  try { return { baseSequence: outbox.baseSequence, events: await events(outbox.baseSequence) }; }
  catch (error) {
    if (error.code !== 'SNAPSHOT_REQUIRED') throw error;
    const checkpoint = await link.fetchCheckpoint(key);
    if (checkpoint.sequence <= outbox.baseSequence) throw new Refused('RELAY_RESPONSE', 'the relay checkpoint did not advance the missing prefix; fetch a consistent newer snapshot');
    return { baseSequence: outbox.baseSequence, checkpoint, events: await events(checkpoint.sequence) };
  }
}

/** Put the board back to an image the relay ordered, keeping each seat's newer shout-read position. */
function restoreBase(link, image, sequence) {
  link.localRecords(link.root, (board) => {
    const cursors = board.db.prepare('SELECT agent_id, agent_last_shout_id FROM agent').all();
    restoreRelaySnapshot(board, image, sequence);
    // Reading shouts is this machine's own progress; the restore keeps the newer read position.
    keepNewerCursors(board, cursors);
  });
}

/** Settle one queued move the relay ordered: report a refusal with the move that won, and note a renumbered item. */
function settle(link, outbox, entry, receipt) {
  const { root, state, io, localRecords } = link;
  if (receipt.outcome.error) {
    const earlier = localRecords(root, (board) => earlierMoves(board, { ...entry, move: resolveMove(entry, outbox).move }, receipt.sequence));
    const line = keepRefusal(state, entry, receipt.outcome.error, earlier);
    io.err(`pullboard: ${line}`);
    tellAgent(link, entry.move.actor, line);
  }
  if (!createsItems(entry.move.operation)) return;
  outbox.results[entry.move.id] = receipt.outcome.error ? null : receipt.outcome.result;
  for (const { item: was, resultPath } of entryCreatedItems(entry)) {
    const is = createdItemAt(receipt.outcome.result, resultPath);
    if (!receipt.outcome.error) noteRenumbered(link, was, is);
  }
}

/** Say once that an item this machine showed under one number now has another, and keep it for status. */
function noteRenumbered({ state, io }, was, is) {
  if (!Number.isSafeInteger(was) || !Number.isSafeInteger(is) || is === was) return;
  state.outboxRenumbered = [...(state.outboxRenumbered ?? []), { was, is }].slice(-KEPT_REFUSALS);
  io.err(`pullboard: the item this machine showed as #${was} while the relay was down is #${is} on the board; its queued moves follow it`);
}

/**
 * Leave a refusal found at replay for the agent whose move it was, so its next command says it (#1013).
 * Why: the background sender has no terminal; the agent that made the move is the one that must hear it lost.
 */
function tellAgent(link, actor, line) {
  if (typeof actor !== 'string') return;
  try {
    const path = link.localRecords(link.root, (board) => board.db.prepare('SELECT agent_path FROM agent WHERE agent_id = ?').get(actor)?.agent_path);
    if (path) leaveConflictNotice(link.file, path, line);
  } catch { /* The refusal stays in pullboard status even when no notice can be left. */ }
}

/**
 * Rebuild the board from what the relay ordered (#1013); the caller holds the outbox guard. The board goes back to
 * the outbox's base image (or the relay's checkpoint), every ordered record replays through the engine, each queued
 * move the relay now holds is settled by its receipt, and the moves still queued are made again on top, so this
 * machine keeps showing them. Returns whether moves still wait.
 */
async function rebuild(link, key, pulled) {
  const { root, file, state, localRecords, saveLink } = link;
  const where = outboxFile(file);
  // Read again under the guard: a move may have queued itself while the relay was being read.
  const outbox = await readOutbox(where, key, state.board);
  if (!outbox?.moves.length) {
    removeOutbox(where);
    saveOutboxSummary(link, null);
    return false;
  }
  if (outbox.baseSequence !== pulled.baseSequence) return true;
  // Nothing new from the relay: the board already shows the base and every queued move on top.
  if (!pulled.checkpoint && !pulled.events.length && outbox.restored !== true) return true;
  // Back to the relay's order: the relay's checkpoint, an older outbox's image, or the queued moves taken back.
  if (pulled.checkpoint) restoreBase(link, pulled.checkpoint.native, pulled.checkpoint.sequence);
  else if (outbox.base) restoreBase(link, outbox.base, outbox.baseSequence);
  else if (!takeBack(link, outbox)) return 'checkpoint';
  await link.applyRecords(root, key, state, pulled.events);
  state.sequence = localRecords(root, appliedSequence);
  outbox.results ??= {};
  const waiting = [];
  for (const entry of outbox.moves) {
    const receipt = localRecords(root, (board) => engineReceipt(board, entry.move.id));
    if (!receipt) { waiting.push(entry); continue; }
    if (state.pending?.move?.id === entry.move.id) delete state.pending;
    if (state.recovered?.move?.id === entry.move.id) delete state.recovered;
    settle(link, outbox, entry, receipt);
  }
  outbox.moves = [];
  for (const entry of waiting) {
    const { lost } = resolveMove(entry, { ...outbox, moves: waiting });
    // A move on an item whose add was refused is refused itself; sent, it would act on another item.
    if (lost.length && (entry.refs ?? []).every((ref) => !waiting.some((other) => other.move.id === ref.add))) {
      const line = keepRefusal(state, entry, { code: 'RELAY_OUTBOX_DEPENDS', message: `it acts on #${lost[0]}, which this machine added while the relay was down, and that add was refused` }, []);
      link.io.err(`pullboard: ${line}`);
      tellAgent(link, entry.move.actor, line);
      continue;
    }
    outbox.moves.push(entry);
  }
  // An older outbox keeps its image until it empties; a new one keeps only the sequence its moves sit on.
  if (outbox.base) outbox.base = localRecords(root, (board) => exportBoard(board));
  outbox.baseSequence = state.sequence;
  outbox.restored = false;
  if (!outbox.moves.length) {
    removeOutbox(where);
    saveOutboxSummary(link, null);
    saveLink(file, state);
    return false;
  }
  for (const entry of outbox.moves) {
    const result = await reapply(link, outbox, entry);
    // A re-applied add may get another number here; later moves reach it through their bound add, not the number.
    const shown = entryCreatedItems(entry);
    rememberCreatedItems(entry, result);
    for (const { item: was, resultPath } of shown) {
      noteRenumbered(link, was, entryCreatedItems(entry).find((row) => JSON.stringify(row.resultPath) === JSON.stringify(resultPath))?.item);
    }
  }
  await writeOutbox(where, key, state.board, outbox);
  saveOutboxSummary(link, outbox);
  saveLink(file, state);
  return true;
}

/**
 * Send the queued moves the relay does not hold yet, in order, each at the next sequence (#1013). Network only: the
 * board is not touched; the next rebuild applies what the relay took. Stops at a move that names an item whose add
 * the relay has not numbered yet, and at another machine's move in the way. Returns how many went up.
 */
async function sendQueued(link, key) {
  const { root, file, state, io, localRecords, sealedRecord } = link;
  const outbox = await readOutbox(outboxFile(file), key, state.board);
  let sent = 0;
  for (const entry of outbox?.moves ?? []) {
    if ((entry.refs ?? []).some((ref) => outbox.moves.some((other) => other.move.id === ref.add))) break;
    const { move, lost } = resolveMove(entry, outbox);
    if (lost.length) break;
    if (localRecords(root, (board) => engineReceipt(board, move.id))) continue;
    const sequence = outbox.baseSequence + sent + 1;
    const sealed = await sealedRecord(key, move, state, 'move', sequence);
    const registration = seatReceipt(move, sequence, sealed);
    const pending = { move, intent: entry.intent, ...(entry.command ? { command: entry.command, commandIntent: entry.commandIntent } : {}),
      sequence, sealed, ...(registration ? { registration } : {}) };
    try { await link.postPending(root, file, state, pending, io); }
    catch (error) {
      // Another machine's move took this place: the next pull orders it first and this move goes after it.
      if (['SEQUENCE_REPEAT', 'SEQUENCE_GAP'].includes(error.code)) break;
      // A lost reply may have been taken; the next pull says, by the move's receipt, without sending it twice.
      if (sent && transientRelayFailure(error)) break;
      throw error;
    }
    sent += 1;
  }
  return sent;
}

/**
 * Send the outbox and bring this machine up to the relay's order (#922, #1013). Each round reads what the relay
 * ordered since the base image, rebuilds the board under the outbox guard, then sends what still waits. Only the
 * rebuild holds the guard, so moves keep queuing while the relay is read or written, and the board never shows a
 * half-replayed state between rounds. A relay failure leaves every move queued and the board as its person last saw
 * it, and is thrown for the caller to report.
 */
export async function flushOutbox(link) {
  const { file, state } = link;
  const where = outboxFile(file);
  if (!state.outbox && !existsSync(where)) return;
  const key = readBoardKey(state.board);
  let fromCheckpoint = false;
  for (let round = 0; round < FLUSH_ROUNDS; round += 1) {
    const pulled = await pullSinceBase(link, key, { fromCheckpoint });
    const waiting = pulled ? await withOutboxGuard(file, () => rebuild(link, key, pulled))
      : await withOutboxGuard(file, async () => {
        if (await readOutbox(where, key, state.board)) return true;
        saveOutboxSummary(link, null);
        return false;
      });
    if (!waiting) return;
    // The queued moves could not be taken back row for row: the next round restores the relay's checkpoint.
    fromCheckpoint = waiting === 'checkpoint';
    if (!pulled || fromCheckpoint) continue;
    await sendQueued(link, key);
  }
  throw new Refused('RELAY_BUSY', 'the relay order stayed busy while this machine sent its queued moves; they stay queued for the next send');
}
