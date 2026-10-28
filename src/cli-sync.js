import { recordedMoveRefusal } from './recorded-move.js';
import { readFileSync } from 'node:fs';
import { readBoardKey } from './relay-key.js';
/**
 * The relay and baseline work around a command: link a new project, sync the relay, deliver finished baselines and
 * run the person's waiting requests. The command line loads it only when one of them could act [C7].
 */
import { retryCheckBaselines } from './check-baseline-worker.js';
import { relayOutboxSetting } from './cli.js';
import { displayedRefusal } from './cli-context.js';
import { Refused } from './refused.js';
import { syncRelay } from './relay.js';
import { executePersonRequests } from './relay-request-execution.js';
import { autoLinkProject } from './relay-setup.js';
import {
  gitSyncLinked,
  relayLinkFile,
} from './local-state.js';
import { repoInfo } from './git.js';
import { takeConflictNotices } from './relay-conflicts.js';
import {
  localFirstBoard,
  nudgeRelaySender,
  senderInBackground,
} from './relay-local-first.js';
import {
  context,
  withBoard,
} from './cli-context.js';

/** Codes a checkout with no board refuses with, which the sync around a command keeps quiet. */
const QUIET = ['NOT_A_REPO', 'NO_REPO', 'NO_CONFIG', 'CORE_BARE'];
const KEY_WARNED_COMMANDS = new WeakSet();

/** Report a refusal from the work around a command without stopping the command. */
async function reportQuietly(io, error) {
  error = recordedMoveRefusal(io, error);
  if (!(error instanceof Refused)) throw error;
  if (!QUIET.includes(error.code)) {
    await io.prepareRefusal?.();
    io.err(`pullboard: ${displayedRefusal(io, error)}\nnext: ${io.refusalDocument(error).error.next}`);
  }
}

/**
 * The relay link of a local-first board at this checkout, or null (#1013): its commands neither sync nor wait, and
 * the machine's background sender does the relay's work. With the sender off (the test runner), commands sync
 * themselves as before.
 */
function localFirstLink(io) {
  try {
    const info = repoInfo(io.cwd);
    const file = relayLinkFile(info.commonDir);
    return localFirstBoard(file, () => relayOutboxSetting(info.root)) ? { root: info.root, file, board: JSON.parse(readFileSync(file, 'utf8')).board } : null;
  } catch { return null; }
}

/** Keep the existing device-key repair warning on local reads without acquiring a relay lock or making a request. */
function tellLocalKeyDiagnostic(io, link) {
  if (KEY_WARNED_COMMANDS.has(io)) return;
  try { readBoardKey(link.board, { legacyKeychain: false }); }
  catch (error) {
    if (!(error instanceof Refused) || error.code !== 'RELAY_KEY_MISSING') throw error;
    KEY_WARNED_COMMANDS.add(io);
    io.err(`pullboard: ${error.message}; moves are off until the key is reachable`);
  }
}

/** Say once, loudly, each queued move of this checkout's agent that lost to another machine's move (#1013). */
function tellConflicts(io, link) {
  if (!link) return;
  for (const line of takeConflictNotices(link.file, link.root)) io.err(`pullboard: ${line}`);
}

/** A network refusal preserves offline reads; linked mutation dispatch requires an acknowledgement. */
export async function retrySync(io) {
  const local = senderInBackground() ? localFirstLink(io) : null;
  if (local) {
    try { tellLocalKeyDiagnostic(io, local); } catch (error) { await reportQuietly(io, error); }
    // No sync and no lock: hand the relay's work to the machine's sender, and deliver finished baselines here.
    nudgeRelaySender(local.root, local.file, io.launchRelaySender);
    try { await retryCheckBaselines(io.cwd, io); } catch (error) { await reportQuietly(io, error); }
    return;
  }
  try {
    if (io.relayCommand?.cliOperation !== 'sync' && gitSyncLinked(io.cwd)) {
      const ctx = context(io);
      await withBoard(ctx, board => import('./sync.js').then(sync => sync.syncGitBoard(io.cwd, board, io)));
    }
    io.relayOutbox ??= () => relayOutboxSetting(io.cwd);
    await syncRelay(io.cwd, io);
    await retryCheckBaselines(io.cwd, io);
  }
  catch (error) { await reportQuietly(io, error); }
}

/** Before a command: link this project when the machine links new ones, sync, then run the person's waiting requests. */
export async function syncBefore(io, main) {
  try { if (io.relayCommand?.cliOperation !== 'sync' && !gitSyncLinked(io.cwd)) await autoLinkProject(io.cwd, io); } catch (error) { if (!(error instanceof Refused)) throw error; }
  const local = localFirstLink(io);
  if (local && senderInBackground()) {
    // The sender runs the person's waiting requests too, so a read never waits on them.
    await retrySync(io);
    tellConflicts(io, local);
    return;
  }
  await retrySync(io);
  // An off that only the relay can vouch for is checked against the relay's own authority before anything reads it (#408).
  try { await (await import('./person-signing-cli.js')).attestBeforeCommand(io.cwd, io); }
  catch (error) { reportQuietly(io, error); }
  try { await executePersonRequests(io.cwd, io, main); }
  catch (error) { await reportQuietly(io, error); }
  tellConflicts(io, local);
}
