import { requirePreparedComputedConflict } from "../../../landing/index.js";
import { withRecordedConflictContext } from "../../../state/index.js";
/** Account-free ordered moves on the repository's own Git remote [H11,H10]. */
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as store from "../../../store/index.js";
import {
  exportBoard,
  importBoard,
  semanticBoardDigest,
} from "../../../store/index.js";
import {
  appliedSequence,
  applyEngineMove,
  engineReceipt,
  prepareEngineMove,
} from "../../../state/index.js";
import {
  gitChildEnv,
  repoInfo,
} from "../../../git/index.js";
import { withGitSyncLock } from './git/lock.js';
import { Refused } from "../../../kernel/index.js";
import {
  gitSyncFiles,
  gitSyncMarkerLinked,
} from '../../../config/index.js';
import {
  GIT_BOARD_REF,
  validateGitBoardCommit,
} from "../../../commits/index.js";

const PREFIX = 'local:git-sync:';
const CACHE = 'refs/pullboard/cache';
const WRITER = new AsyncLocalStorage();
// Budget: a Git phase ends before the fixed two-minute writer lease can expire.
const GIT_PHASE_TIMEOUT_MS = 110_000;

/** Every local write and remote Git phase belongs to the current unexpired transport capability. */
function assertWriter() {
  const lease = WRITER.getStore();
  if (!lease) throw new Refused('GIT_SYNC_LOCK_LOST', 'Git transport has no active writer capability', 'retry through the native sync operation; preserve its pending intent');
  lease.assertHeld();
  return lease;
}

/** Keep the transport marker and pending intent in the shared Git directory of this machine. */
function paths(root) {
  const info = repoInfo(root);
  const folder = join(info.commonDir, 'pullboard');
  return { marker: join(folder, 'git-sync.json'), pending: join(folder, 'git-sync-pending.json') };
}

/** Detect an explicitly enabled Git transport without making network requests. */
export function gitSyncLinked(root) {
  return gitSyncMarkerLinked(root);
}

/** Run real Git with repository selectors scrubbed and captured output. */
function git(root, args, input = '') {
  const lease = assertWriter();
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-replace-objects', ...args], { cwd: root, env: gitChildEnv(root), timeout: GIT_PHASE_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', status => {
      try { lease.assertHeld(); resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Turn a Git failure into a stable named refusal, without claiming an unacknowledged move succeeded. */
async function required(root, args, input) {
  const result = await git(root, args, input);
  if (result.status !== 0) throw new Refused('GIT_SYNC_REMOTE', 'the repository remote did not acknowledge Git board sync; local reads remain available and the pending move is preserved', 'restore access to origin, then retry the same command');
  return result.stdout;
}

/** Atomically replace a local marker or sealed pending intent before any network publication. */
function save(file, value) {
  assertWriter();
  const temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Read transport metadata committed in the same SQLite transaction as its replayed move. */
function meta(board, key) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(PREFIX + key)?.meta_value ?? null;
}

/** Distinguish a durable Git prefix from relay history; a Git sequence is not evidence of relay use. */
export function gitSyncCompatibility(root, board) {
  const tip = meta(board, 'tip');
  const event = meta(board, 'event');
  const latest = String(board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id);
  const linked = existsSync(join(gitSyncFiles(root).folder, 'relay.json'));
  const prefix = tip !== null;
  const validPrefix = prefix && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tip) && event === latest;
  return { prefix, validPrefix, relayHistory: linked || !prefix && appliedSequence(board) !== 0,
    compatible: !linked && (prefix ? validPrefix : appliedSequence(board) === 0) };
}

/** Check native transport history before any marker, network, import or replay effect. */
function requireCompatibleTransport(root, board) {
  const state = gitSyncCompatibility(root, board);
  if (state.relayHistory) throw new Refused('GIT_SYNC_LINKED', 'this board already has relay-ordered history; Git sync cannot start a second transport', 'use the existing relay for this board, or initialize a separate board');
  if (!state.compatible) throw new Refused('GIT_SYNC_LOCAL_CHANGED', 'this board does not match its acknowledged Git prefix; its history and pending intent were preserved', 'restore the acknowledged prefix before syncing; do not replace it with a fresh baseline');
}

/** Remember the exact applied Git prefix together with its native last event. */
function remember(board, tip) {
  assertWriter();
  const put = board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value');
  put.run(PREFIX + 'tip', tip);
  put.run(PREFIX + 'event', String(board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id));
}

/** Refuse local event writes made outside the enabled ordered transport instead of overwriting them. */
function requirePrefix(board) {
  if (meta(board, 'tip') === null) return;
  const event = String(board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id);
  if (event !== meta(board, 'event')) throw new Refused('GIT_SYNC_LOCAL_CHANGED', 'this board has local moves outside its shared Git prefix; they were preserved', 'export the local board and ask the coordinator to reconcile it before syncing');
}

/** Fetch only the dedicated board ref; a missing ref means this remote has no shared board yet. */
async function fetchTip(root) {
  const advertised = await required(root, ['ls-remote', '--refs', 'origin', GIT_BOARD_REF]);
  if (!advertised) return null;
  await required(root, ['fetch', '--no-tags', 'origin', '+' + GIT_BOARD_REF + ':' + CACHE]);
  return required(root, ['rev-parse', CACHE]);
}

/** Write a data-only Git commit without touching the worktree, index or code refs. */
async function commit(root, payload, parent) {
  const blob = await required(root, ['hash-object', '-w', '--stdin'], JSON.stringify(payload) + '\n');
  const tree = await required(root, ['mktree'], '100644 blob ' + blob + '\tpayload.json\n');
  return required(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'pullboard: ordered board data']);
}

/** Append with an exact compare-and-swap lease; normal push hooks remain in force. */
async function publish(root, head, previous) {
  const result = await git(root, ['push', '--porcelain', '--force-with-lease=' + GIT_BOARD_REF + ':' + (previous ?? ''), 'origin', head + ':' + GIT_BOARD_REF]);
  return result.status === 0;
}

/** Validate the whole linear data log before importing or applying any of its prefix. */
async function log(root, tip) {
  const names = (await required(root, ['rev-list', '--reverse', '--first-parent', tip])).split('\n');
  const records = [];
  let parent = null;
  for (const name of names) {
    const payload = await validateGitBoardCommit(root, name, parent);
    if (payload.kind !== (parent ? 'move' : 'baseline') || parent && payload.sequence !== records.length) throw new Refused('GIT_SYNC_LOG', 'the Git board log is not a contiguous ordered prefix', 'restore the append-only refs/pullboard/board history before syncing');
    records.push({ hash: name, payload });
    parent = name;
  }
  return records;
}

/** Import only a fresh clone, then replay acknowledged moves through the existing deterministic engine. */
async function reconcile(root, board) {
  requireCompatibleTransport(root, board);
  requirePrefix(board);
  const tip = await fetchTip(root);
  if (!tip) {
    if (meta(board, 'tip')) throw new Refused('GIT_SYNC_LOG', 'the shared Git board ref disappeared; the local prefix was preserved', 'restore refs/pullboard/board on origin before syncing');
    return null;
  }
  const records = await log(root, tip);
  let local = meta(board, 'tip');
  if (!local) {
    const snapshot = records[0].payload.snapshot;
    assertWriter();
    if (semanticBoardDigest(exportBoard(board)) !== semanticBoardDigest(snapshot)) importBoard(board, snapshot);
    store.atomic(board, () => remember(board, records[0].hash));
    local = records[0].hash;
  }
  const offset = records.findIndex(record => record.hash === local);
  if (offset < 0) throw new Refused('GIT_SYNC_LOG', 'the remote rewrote this machine\'s acknowledged board prefix; local state was preserved', 'restore the append-only refs/pullboard/board history before syncing');
  for (const { hash, payload } of records.slice(offset + 1)) {
    assertWriter();
    store.atomic(board, () => {
      const position = { sequence: payload.sequence, at: payload.at };
      withRecordedConflictContext(board, payload.move, position, () => applyEngineMove(board, payload.move, position));
      remember(board, hash);
    });
  }
  return tip;
}

/** Establish one baseline, resolving simultaneous initial publishers without merging unrelated local boards. */
async function establish(root, board) {
  requireCompatibleTransport(root, board);
  let tip = await reconcile(root, board);
  if (tip) return tip;
  if (appliedSequence(board) !== 0) throw new Refused('GIT_SYNC_LINKED', 'this board already has relay-ordered history; Git sync cannot start a second transport', 'use the existing relay for this board, or initialize a separate board');
  const snapshot = exportBoard(board);
  const initial = await commit(root, { version: 1, kind: 'baseline', snapshot }, null);
  if (await publish(root, initial, null)) {
    store.atomic(board, () => remember(board, initial));
    return initial;
  }
  tip = await reconcile(root, board);
  if (!tip) throw new Refused('GIT_SYNC_REMOTE', 'origin refused the initial shared board; no move was recorded and Git sharing stays off', 'ask the person to restore write access to origin; other commands keep working on this machine');
  return tip;
}

/** Publish the same sealed intent after a rejected or uncertain push, recognizing an already accepted ID. */
async function settle(root, board, pending) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tip = await reconcile(root, board);
    if (!tip) throw new Refused('GIT_SYNC_LOG', 'the shared Git board ref disappeared; the pending move was preserved', 'restore refs/pullboard/board before retrying');
    const previous = engineReceipt(board, pending.move.id);
    if (previous) {
      assertWriter();
      rmSync(paths(root).pending, { force: true });
      return previous.outcome;
    }
    if (pending.move.operation === 'reopen' && pending.move.args[1]?.computedConflict !== undefined) {
      requirePreparedComputedConflict(board, pending.move.args[0], pending.move.args[1].agentId, pending.move.args[1].computedConflict);
    }
    const payload = { version: 1, kind: 'move', sequence: appliedSequence(board) + 1, at: new Date().toISOString(), move: pending.move };
    const head = await commit(root, payload, tip);
    if (await publish(root, head, tip)) {
      await reconcile(root, board);
      const receipt = engineReceipt(board, pending.move.id);
      if (!receipt) throw new Refused('GIT_SYNC_LOG', 'the acknowledged Git move has no replay receipt; the pending move was preserved', 'restore the complete shared Git log before retrying');
      assertWriter();
      rmSync(paths(root).pending, { force: true });
      return receipt.outcome;
    }
  }
  throw new Refused('GIT_SYNC_REMOTE', 'origin did not acknowledge the shared move after competing pushes; the same sealed move is pending', 'restore access to origin, then retry the same command');
}

/**
 * Whether this board's Git sharing is on: a valid opt-in marker and a first board origin accepted [C7].
 * A marker without an acknowledged prefix (left by an older sync whose first push was refused) runs local-only,
 * so one refused push never makes every later command retry it under the shared lock.
 */
export function gitSyncAcknowledged(root, board) {
  return gitSyncLinked(root) && meta(board, 'tip') !== null;
}

/** Sync only after explicit opt-in; a normal read catches network refusals and keeps its local prefix. */
export async function syncGitBoard(root, board, io, { settlePending = false } = {}) {
  board.gitRoot = root; // Runtime Git authority is local, not a field supplied by a replicated move.
  requireCompatibleTransport(root, board);
  const explicit = io?.relayCommand?.cliOperation === 'sync';
  if (!explicit && !gitSyncLinked(root)) throw new Refused('GIT_SYNC_LINKED', 'only an explicit pullboard sync can enable Git board sharing', 'ask the person to opt in to Git sharing on a board without relay history');
  const file = paths(root);
  return withGitSyncLock(file.marker, lease => WRITER.run(lease, async () => {
    requireCompatibleTransport(root, board);
    // The opt-in marker is written only after origin acknowledged the first board; a refusal leaves none.
    try { await establish(root, board); }
    catch (error) {
      if (explicit && meta(board, 'tip') === null) rmSync(file.marker, { force: true });
      throw error;
    }
    if (explicit) save(file.marker, { version: 1, remote: 'origin', ref: GIT_BOARD_REF,
      writer: { command: 'sync', pid: process.pid, at: new Date().toISOString() } });
    const pending = existsSync(file.pending) ? JSON.parse(readFileSync(file.pending, 'utf8')) : null;
    const outcome = settlePending && pending ? await settle(root, board, pending) : null;
    if (outcome?.error) throw new Refused(outcome.error.code, outcome.error.message, outcome.error.next);
    return { version: 1, ref: GIT_BOARD_REF, sequence: appliedSequence(board), pending: pending && !settlePending ? pending.move.id : null };
  }), io);
}

/** Route a mutation through the single remote order, retaining a pending intent before its first push. */
export async function gitBoardOperation(root, board, operation, args, io = {}) {
  board.gitRoot = root;
  requireCompatibleTransport(root, board);
  const file = paths(root);
  return withGitSyncLock(file.marker, lease => WRITER.run(lease, async () => {
    // An enabled replica seals its intent before its first network attempt, including an outage.
    if (!meta(board, 'tip')) await establish(root, board);
    const command = JSON.stringify(io.relayCommand ?? { operation, args });
    let pending = existsSync(file.pending) ? JSON.parse(readFileSync(file.pending, 'utf8')) : null;
    let outcome;
    if (pending) {
      outcome = await settle(root, board, pending);
      if (pending.command === command && pending.move.operation === operation) {
        if (outcome.error) throw new Refused(outcome.error.code, outcome.error.message, outcome.error.next);
        io.onOrderedMove?.({ operation, events: outcome.events ?? [] });
        return outcome.result;
      }
      if (outcome.error) throw new Refused(outcome.error.code, outcome.error.message, outcome.error.next);
    }
    const moveOptions = operation === 'rehomeItem' && io.rehomeMoveId ? { id: io.rehomeMoveId } : {};
    pending = { version: 1, command, at: new Date().toISOString(), move: prepareEngineMove(board, operation, args, moveOptions) };
    save(file.pending, pending);
    outcome = await settle(root, board, pending);
    if (outcome.error) throw new Refused(outcome.error.code, outcome.error.message, outcome.error.next);
    io.onOrderedMove?.({ operation, events: outcome.events ?? [] });
    return outcome.result;
  }), io);
}
