import { outboxFile } from './summary.js';
import { readOutboxSummary } from './summary.js';
import { readRelayLink } from './read.js';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { environmentAdapter } from '../../../../env/index.js';
import { readCommonDir } from './common-dir.js';
import { relayOrigin } from '../../logic/relay/origin.js';

const fs = fileSystemAdapter();

export const STATE_FILES = new WeakMap();

/** Validate private link metadata before trusting its destination or acknowledgement cursor. */
export function loadLink(file) {
  const state = readRelayLink(file);
  if (!state) return null;
  if (state.token === undefined || state.token?.startsWith('ps_')) {
    state.token = null;
    delete state.tokenId;
    state.personReauth = true;
    saveLink(file, state);
  }
  STATE_FILES.set(state, file);
  // A move queues itself without the relay lock, so the outbox summary lives in its own file (#1013).
  const waiting = readOutboxSummary(file);
  if (waiting) state.outbox = waiting;
  else if (!fs.exists(outboxFile(file))) delete state.outbox;
  return state;
}

/** Atomically persist acknowledgements and an exact sealed retry before attempting its send. */
export function saveLink(file, state) {
  STATE_FILES.set(state, file);
  fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    // The outbox summary is the outbox's own file; a link saved by the sender never overwrites a move's (#1013).
    fs.writeFile(temporary, JSON.stringify({ ...state, outbox: undefined }) + '\n', { flag: 'wx', mode: 0o600 });
    fs.rename(temporary, file);
  } finally { fs.rm(temporary, { force: true }); }
}

/*
 * The link-state reads below take the cells they need as `ports` and import none of them, so the link light door loads
 * no items, state or git files. A caller passes { repoInfo, relayFiles, boardFilePath, codeIsFromMain, closeBoard,
 * engineReceipt, withProjectGitTimeout, withDerivedFamily, Refused }; each function reads only the ports it names [C7,#12003].
 */

/** The shared git directory, read straight from `.git` when possible and from git otherwise [C7]. */
export function quickCommonDir(root, ports) { return readCommonDir(root) ?? ports.repoInfo(root).commonDir; }

/** Find the shared local link metadata without opening a board or connecting for an unlinked repo. */
export function linkFile(root, ports) { return ports.relayFiles(quickCommonDir(root, ports)).link; }

/** Locate the credential-free reason an independently deleted copy no longer syncs. */
export function deletedLinkFile(root, ports) { return ports.relayFiles(ports.repoInfo(root).commonDir).deleted; }

/** Read only a private, bounded deletion marker; it never supplies credentials or an outbound destination. */
export function deletedLink(root, ports) {
  const { Refused } = ports;
  const file = deletedLinkFile(root, ports);
  if (!fs.exists(file)) return null;
  const stat = fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4096) throw new Refused('RELAY_STORAGE', 'restore the private deleted-copy notice before reading relay status');
  let value;
  try { value = JSON.parse(fs.readFile(file, 'utf8')); } catch { throw new Refused('RELAY_STORAGE', 'restore the private deleted-copy notice before reading relay status'); }
  if (value?.version !== 1 || !/^[0-9a-f]{32}$/u.test(value.board ?? '') || typeof value.url !== 'string') throw new Refused('RELAY_STORAGE', 'restore the supported deleted-copy notice before reading relay status');
  relayOrigin(value.url);
  const recovered = value.recovered;
  if (recovered !== undefined && (!recovered || !/^[A-Za-z0-9_-]{1,80}$/u.test(recovered.id ?? '')
      || !/^[0-9a-f]{64}$/u.test(recovered.intent ?? '')
      || (recovered.commandIntent !== undefined && !/^[0-9a-f]{64}$/u.test(recovered.commandIntent)))) {
    throw new Refused('RELAY_STORAGE', 'restore the private interrupted-move receipt pointer before retrying');
  }
  return value;
}

/** Read durable local event rows; their ids are the crash-safe outbox after the saved cursor. */
export function localRecords(openBoard, root, work, ports) {
  const info = ports.repoInfo(root);
  const board = openBoard(ports.boardFilePath(info.commonDir), undefined, { isMain: ports.codeIsFromMain(), gitRoot: root });
  try { return work(board); } finally { ports.closeBoard(board); }
}

/** Resolve the private pointer only through the exact durable native receipt, never a remote key. */
export function deletedRecovery(root, io, ports) {
  const marker = deletedLink(root, ports);
  if (!marker?.recovered) return null;
  const receipt = localRecords(io.openBoard, root, board => ports.engineReceipt(board, marker.recovered.id), ports);
  let move;
  try { move = receipt && JSON.parse(receipt.move); } catch { /* Refuse a corrupt receipt below. */ }
  if (!move || move.id !== marker.recovered.id || !receipt.outcome) {
    throw new ports.Refused('RELAY_STORAGE', 'restore the interrupted native receipt before retrying its command');
  }
  return { marker, receipt, move };
}

/** A saved link is the opt-in boundary; unlinked callers neither read keys nor contact the relay. */
export function relayLinked(root, ports) { return Boolean(loadLink(linkFile(root, ports))); }

/** Expose only an unreported operation descriptor so CLI preconditions cannot strand its outcome. */
export function relayRecovered(root, { includePending = false } = {}, io, ports) {
  const state = loadLink(linkFile(root, ports));
  return state ? state.recovered?.move ?? (includePending ? state.pending?.move : null) ?? null : deletedRecovery(root, io, ports)?.move ?? null;
}

/** Expose board-scoped machine context only to the native setup/approval adapter. */
export function relayMachineContext(root, ports) { return ports.withProjectGitTimeout(root, () => loadLink(linkFile(root, ports))); }

/**
 * The agent an environment session works as, when this clone's link came from its environment and the token is still
 * there, or null. Reading the link file directly keeps this a pure read with no relay contact.
 *
 * @param {string} root
 * @param {{ db: any }} board
 * @param {{ repoInfo: Function, relayFiles: Function, withDerivedFamily: Function }} ports
 * @returns {object | null} the agent row
 */
export function environmentAgent(root, board, ports) {
  if (!environmentAdapter().has('PULLBOARD_RELAY_TOKEN')) return null;
  let state;
  try { state = JSON.parse(fs.readFile(ports.relayFiles(ports.repoInfo(root).commonDir).link, 'utf8')); } catch { return null; }
  const agent = state?.environment?.agent;
  return typeof agent === 'string' ? ports.withDerivedFamily(board, board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agent)) ?? null : null;
}
