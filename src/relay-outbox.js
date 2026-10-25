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
import { transientRelayFailure } from './relay-move-fallback.js';
import {
  actorTransport,
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
import { stampCoordinatorHolder } from './coordinator-hold.js';
import { Refused } from './refused.js';
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

/** The sealed outbox beside a link file. */
export function outboxFile(linkFile) {
  return join(dirname(linkFile), 'relay-outbox.sealed');
}

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
  if (![1, 2].includes(document?.version) || !Array.isArray(document.moves) || !document.base || !Number.isSafeInteger(document.baseSequence)) {
    throw new Refused('RELAY_OUTBOX', 'the relay outbox on this machine is unreadable; keep it, and ask for help before relinking this board');
  }
  return document;
}

/** Seal and atomically replace the outbox, readable only by this user. */
export async function writeOutbox(file, key, boardId, document) {
  // Old clients must refuse richer result bindings rather than treating temporary item numbers as final.
  if (document.moves.some(entry => (entry.move.operation !== 'addItem' && createsItems(entry.move.operation))
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

/** Say what a refused replay was and which ordered moves came first. */
export function refusalLine(kept) {
  const first = kept.earlier.length
    ? `; moves the relay ordered first: ${kept.earlier.map(({ sequence, move }) => `sequence ${sequence} ${move}`).join(', ')}`
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
  setBarReady: [], setLineSetting: [],
  requestCompanion: [[0, 'parentId']],
  recordPublishFinding: [[0, 'item']],
  register: [], ensureCoordinator: [], shout: [], passDecision: [], holdLane: [], releaseLane: [],
  moveMilestone: [], editMilestone: [], removeMilestone: [], shipMilestone: [],
  recordRowDecisions: [], decideSpecRevisions: [], applyRowDecisions: [], draftSpecRow: [], recordSpecApprovalBaseline: [],
  recordLandingBatch: [], recordLandingWaiver: [], recordLandingFlake: [], recordLandingTestDefect: [], finishLandingBatch: [],
  recordHealthFindings: [], decideSentinel: [], beginSentinelRun: [], finishSentinelRun: [],
  recordFlakeObservation: [], recordGateRun: [], recordProofRun: [[0, 'itemId'], [0, 'receipt', 'proof', 'item']], declareJob: [], recordJobRun: [], takeCoordinator: [], openHandoff: [], landingLeaseMove: [],
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

/** Whether this command may queue a move in the ordered outbox: the board's relay.outbox setting, off by default (#922). */
function outboxEnabled(io) {
  try { return io?.relayOutbox?.() === true; } catch { return false; }
}

/**
 * Whether a failure on an accepted link may queue the move instead of refusing it (#922): the relay said nothing
 * definite, and the move needs no relay answer to exist (a registration mints its token there; a person's request
 * is the phone's to send).
 */
export function outboxQueueable(state, error, operation, io) {
  return state.mode === 'ordered' && state.baselineAccepted === true && !state.baselineConflict && !io?.personRequest
    && !['register', 'ensureCoordinator'].includes(operation) && transientRelayFailure(error) && outboxEnabled(io);
}

/** The board's relay-applied sequence, read from an exported image. */
function exportedSequence(native) {
  return Number(native.tables.board_meta.find((row) => row.meta_key === 'relay_applied_sequence')?.meta_value ?? 0);
}

/** Keep the key-free outbox summary on the link, or drop it once the outbox is empty. */
function saveOutboxSummary({ file, state, saveLink }, outbox) {
  if (outbox?.moves.length) state.outbox = { restored: outbox.restored, moves: outbox.moves.map(outboxEntrySummary) };
  else delete state.outbox;
  saveLink(file, state);
}

/**
 * Queue a move the relay could not take on an accepted link, then make it on this machine (#922).
 * The first queued move seals the board as the relay last ordered it; the move is written before it is applied,
 * so a crash between the two leaves it queued and the replay starts from that image anyway. A move this board
 * refuses is refused now and never queued.
 */
export async function queueMove(link, { operation, args, command, move, error, applyLocally }) {
  const { root, file, state, io, localRecords, safePauseCode, safePauseMessage } = link;
  const key = readBoardKey(state.board);
  const where = outboxFile(file);
  const outbox = await readOutbox(where, key, state.board) ?? (() => {
    const base = localRecords(root, (board) => exportBoard(board));
    return { version: 1, base, baseSequence: exportedSequence(base), restored: false, moves: [] };
  })();
  if (!move) {
    const sent = withSeatName(root, operation, args);
    move = stampCoordinatorHolder(localRecords(root, (board) => prepareEngineMove(board, operation, sent)), state.machine);
    move.actor = relayMoveActor(move) ?? credentialActor(move);
  }
  const stray = strayItemRefs(outbox, move);
  if (stray.length) {
    throw new Refused('RELAY_OUTBOX_UNBOUND', `this move names #${stray[0]}, which this machine added while the relay was down, in a field the outbox cannot follow if the relay renumbers it; run it again once the relay answers`);
  }
  // `after` is the relay sequence this machine had seen: a refusal at replay names the moves ordered since.
  const entry = { move, refs: bindRefs(outbox, move), intent: operationIntent(operation, args), queuedAt: new Date().toISOString(), after: state.sequence,
    ...(command ? { command, commandIntent: operationIntent('cli:' + command.cliOperation, command) } : {}) };
  outbox.moves.push(entry);
  await writeOutbox(where, key, state.board, outbox);
  if (state.pending?.move?.id === move.id) delete state.pending;
  saveOutboxSummary(link, outbox);
  let result;
  try { result = await applyLocally(); }
  catch (refusal) {
    outbox.moves.pop();
    if (outbox.moves.length) await writeOutbox(where, key, state.board, outbox);
    else removeOutbox(where);
    saveOutboxSummary(link, outbox);
    throw refusal;
  }
  if (createsItems(move.operation)) {
    rememberCreatedItems(entry, result);
    await writeOutbox(where, key, state.board, outbox);
  }
  if (!OUTBOX_NOTICES.has(io)) {
    OUTBOX_NOTICES.add(io);
    io.err(`pullboard: [${safePauseCode(error)}] ${error.transportFailure ? `the relay did not answer (${error.transportFailure})` : safePauseMessage(error)}; the move is saved on this machine and waits in the relay outbox (${outbox.moves.length} pending); it goes up in order when the relay answers, and pullboard status lists it`);
  }
  return result;
}

/**
 * Put the queued moves back on top of the board after a replay stopped part way (#922): seal the board as the relay
 * has now ordered it, then apply each remaining move here again, so this machine keeps showing them.
 */
async function rebaseOutbox(link, outbox, key) {
  const { root, file, state, localRecords } = link;
  outbox.base = localRecords(root, (board) => exportBoard(board));
  outbox.baseSequence = exportedSequence(outbox.base);
  outbox.restored = false;
  await writeOutbox(outboxFile(file), key, state.board, outbox);
  saveOutboxSummary(link, outbox);
  for (const entry of outbox.moves) {
    const { move, lost } = resolveMove(entry, outbox, { local: true });
    // A move on an item whose add was refused stays queued for its own refusal; here it would hit another item.
    if (lost.length) continue;
    const result = localRecords(root, (board) => {
      try { return store.atomic(board, () => store[move.operation](board, ...executableArgs(move, board))); }
      catch (error) { if (!(error instanceof Refused)) throw error; return null; }
    });
    // A re-applied add may get another number here; later moves reach it through their bound add, not the number.
    rememberCreatedItems(entry, result);
  }
  await writeOutbox(outboxFile(file), key, state.board, outbox);
}

/**
 * Replay the ordered outbox before this machine applies or sends anything else (#922). The board goes back to the
 * image the relay last ordered, catches up with every other machine's moves, then sends each queued move in order:
 * a move the relay already holds from a lost reply is not sent twice, and a move refused at replay is reported with
 * the moves ordered before it. A relay that fails again part way puts the rest back on top and throws its failure.
 */
export async function flushOutbox(link) {
  const { root, file, state, io, request, catchUp, sendPending, sealedRecord, localRecords, saveLink } = link;
  const where = outboxFile(file);
  if (!state.outbox && !existsSync(where)) return;
  const key = readBoardKey(state.board);
  const outbox = await readOutbox(where, key, state.board);
  if (!outbox?.moves.length) {
    removeOutbox(where);
    saveOutboxSummary(link, null);
    return;
  }
  try {
    if (!outbox.restored) {
      // Probe first: a relay that is still down leaves this machine's board exactly as its person last saw it.
      try { await request(state, '/api/v1/boards/' + state.board + '/events?after=' + outbox.baseSequence, {}, io); }
      catch (error) { if (error.code !== 'SNAPSHOT_REQUIRED') throw error; }
      localRecords(root, (board) => {
        const cursors = board.db.prepare('SELECT agent_id, agent_last_shout_id FROM agent').all();
        restoreRelaySnapshot(board, outbox.base, outbox.baseSequence);
        // Reading shouts is this machine's own progress; the restore keeps the newer read position.
        const keep = board.db.prepare('UPDATE agent SET agent_last_shout_id = ? WHERE agent_id = ? AND (agent_last_shout_id IS NULL OR agent_last_shout_id < ?)');
        for (const row of cursors) if (Number.isSafeInteger(row.agent_last_shout_id)) keep.run(row.agent_last_shout_id, row.agent_id, row.agent_last_shout_id);
      });
      state.sequence = outbox.baseSequence;
      outbox.restored = true;
      await writeOutbox(where, key, state.board, outbox);
      saveOutboxSummary(link, outbox);
    }
    await catchUp(root, file, state, io);
    outbox.results ??= {};
    while (outbox.moves.length) {
      const entry = outbox.moves[0];
      const receiptOf = () => localRecords(root, (board) => engineReceipt(board, entry.move.id));
      let receipt = receiptOf();
      let sequence = receipt?.sequence;
      if (!receipt) {
        const { move, lost } = resolveMove(entry, outbox);
        if (lost.length) {
          io.err(`pullboard: ${keepRefusal(state, entry, { code: 'RELAY_OUTBOX_DEPENDS', message: `it acts on #${lost[0]}, which this machine added while the relay was down, and that add was refused` }, [])}`);
          await finishEntry(link, outbox, where, key);
          continue;
        }
        // The queued move keeps its bindings; the resolved copy is what goes up, under the same move id.
        await actorTransport(root, file, state, credentialActor(move), io);
        sequence = state.sequence + 1;
        const sealed = await sealedRecord(key, move, state, 'move', sequence);
        const registration = seatReceipt(move, sequence, sealed);
        state.pending = { move, intent: entry.intent, ...(entry.command ? { command: entry.command, commandIntent: entry.commandIntent } : {}),
          sequence, sealed, ...(registration ? { registration } : {}) };
        saveLink(file, state);
        let failure;
        try { await sendPending(root, file, state, io); } catch (error) { failure = error; }
        if (failure && !receiptOf()) {
          if (!['RELAY_UNAVAILABLE', 'RELAY_RESPONSE'].includes(failure.code)) throw failure;
          try { await catchUp(root, file, state, io); } catch { throw failure; }
        }
        receipt = receiptOf();
        if (!receipt) throw failure ?? new Refused('RELAY_RESPONSE', 'the relay acknowledged a queued move without its replay receipt; run pullboard status to retry the outbox');
        sequence = receipt.sequence;
      }
      if (state.pending?.move?.id === entry.move.id) delete state.pending;
      if (state.recovered?.move?.id === entry.move.id) delete state.recovered;
      if (receipt.outcome.error) {
        const earlier = localRecords(root, (board) => earlierMoves(board, { ...entry, move: resolveMove(entry, outbox).move }, sequence));
        io.err(`pullboard: ${keepRefusal(state, entry, receipt.outcome.error, earlier)}`);
      }
      if (createsItems(entry.move.operation)) {
        outbox.results[entry.move.id] = receipt.outcome.error ? null : receipt.outcome.result;
        for (const { item: was, resultPath } of entryCreatedItems(entry)) {
          const is = createdItemAt(receipt.outcome.result, resultPath);
          if (!receipt.outcome.error && Number.isSafeInteger(is) && is !== was) {
            state.outboxRenumbered = [...(state.outboxRenumbered ?? []), { was, is }].slice(-KEPT_REFUSALS);
            io.err(`pullboard: the item this machine showed as #${was} while the relay was down is #${is} on the board; its queued moves follow it`);
          }
        }
      }
      await finishEntry(link, outbox, where, key);
    }
  } catch (error) {
    if (outbox.restored && outbox.moves.length) {
      if (state.pending && outbox.moves.some((entry) => entry.move.id === state.pending.move?.id)) delete state.pending;
      await rebaseOutbox(link, outbox, key);
    }
    throw error;
  }
}
