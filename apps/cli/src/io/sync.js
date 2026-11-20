import { nativeBoardOpeners } from './context.js';
import { nativePersonRequestPorts } from './context.js';
import { recordedMoveRefusal } from '../../../../packages/state/index.js';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';
import { baselineReceiptsPending } from '../../../../packages/store/light.js';
import { readBoardKey } from '../../../../packages/keys/index.js';
/**
 * The relay and baseline work around a command: link a new project, sync the relay, deliver finished baselines and
 * run the person's waiting requests. The command line loads it only when one of them could act [C7].
 */
import { relayOutboxSetting } from './relay-outbox.js';
import { displayedRefusal } from './context.js';
import { Refused } from '../../../../packages/kernel/index.js';
import {
  DEFAULT_RELAY,
  relayStatus,
  syncRelay,
} from '../../../../packages/link/index.js';
import { executePersonRequests } from '../../../../packages/link/index.js';
import { autoLinkProject } from '../../../../packages/link/index.js';
import {
  gitSyncLinked,
  relayLinkFile,
} from '../../../../packages/store/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { takeConflictNotices } from '../../../../packages/outbox/light.js';
import { environmentAdapter } from '../../../../packages/env/index.js';
import {
  localFirstBoard,
  nudgeRelaySender,
  senderInBackground,
} from '../../../../packages/link/index.js';
import {
  context,
  withBoard,
  withBoardRead,
} from './context.js';

const fs = fileSystemAdapter();

/** Deliver finished baselines; the gate loads only when a sync step reaches this call [C7]. */
async function retryCheckBaselines(root, ...args) {
  // No finished result waiting means nothing to deliver, so the gate stays unloaded.
  if (!baselineReceiptsPending(repoInfo(root).commonDir)) return;
  return (await import('../../../../packages/gate/heavy.js')).retryCheckBaselines(root, ...args);
}

/** Codes a checkout with no board refuses with, which the sync around a command keeps quiet. */
const QUIET = ['NOT_A_REPO', 'NO_REPO', 'NO_CONFIG', 'CORE_BARE'];
const KEY_WARNED_COMMANDS = new WeakSet();
const LOCAL_ONLY_WARNED = new WeakSet();

/**
 * Warn once per command that a Git opt-in origin never accepted runs local-only [C7]. Why: the old refusal
 * told agents to run pullboard sync, which retried the refused push and froze every board write.
 */
export function warnGitSyncLocalOnly(io) {
  if (LOCAL_ONLY_WARNED.has(io)) return;
  LOCAL_ONLY_WARNED.add(io);
  io.err?.('pullboard: origin has not accepted this board\'s first Git sync push; this command runs local-only');
}

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
    return localFirstBoard(file, () => relayOutboxSetting(info.root)) ? { root: info.root, file, board: JSON.parse(fs.readFile(file, 'utf8')).board } : null;
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

/** How long a command waits on a relay that does not answer while this board's baseline is paused (#7779). */
const PAUSED_BASELINE_WAIT_MS = 250;

/** The paused-baseline wait: 250 ms for people; a fixture board may widen it, since its loopback relay shares a loaded event loop. */
function pausedBaselineWaitMs() {
  const environment = environmentAdapter();
  const widened = Number(environment.get('PULLBOARD_FIXTURE_PAUSED_WAIT_MS'));
  return environment.get('PULLBOARD_FIXTURE_BOARD') === '1' && widened > 0 ? widened : PAUSED_BASELINE_WAIT_MS;
}

/** Whether this checkout's relay link holds a paused baseline upload: its saved pause, read from one small local file. */
function pausedBaseline(io) {
  try {
    const state = JSON.parse(fs.readFile(relayLinkFile(repoInfo(io.cwd).commonDir), 'utf8'));
    return Boolean(state?.baselinePause) && state.mode === 'ordered' && !state.environment;
  } catch { return false; }
}

/** A network refusal preserves offline reads; linked mutation dispatch requires an acknowledgement. */
export async function retrySync(io) {
  const local = senderInBackground() ? localFirstLink(io) : null;
  if (local) {
    try { tellLocalKeyDiagnostic(io, local); } catch (error) { await reportQuietly(io, error); }
    // No sync and no lock: hand the relay's work to the machine's sender, and deliver finished baselines here.
    nudgeRelaySender(local.root, local.file, io.launchRelaySender);
    try { await retryCheckBaselines(io.cwd, io, { openBoard: nativeBoardOpeners(io).openBoard }); } catch (error) { await reportQuietly(io, error); }
    return;
  }
  // A paused baseline waits for the relay in the background; a relay that does not answer costs this command one short wait.
  if (pausedBaseline(io)) io.relayDeadlineAt = Date.now() + pausedBaselineWaitMs();
  try {
    if (io.relayCommand?.cliOperation !== 'sync' && gitSyncLinked(io.cwd)) {
      const ctx = context(io);
      const { gitSyncAcknowledged, gitSyncCompatibility, syncGitBoard } = await import('../../../../packages/sync/index.js');
      const [compatible, acknowledged] = withBoardRead(ctx, board => [gitSyncCompatibility(io.cwd, board).compatible, gitSyncAcknowledged(io.cwd, board)]);
      if (compatible && !acknowledged) warnGitSyncLocalOnly(io);
      else if (compatible) await withBoard(ctx, board => syncGitBoard(io.cwd, board, io));
    }
    io.relayOutbox ??= () => relayOutboxSetting(io.cwd);
    await syncRelay(io.cwd, io);
    await retryCheckBaselines(io.cwd, io, { openBoard: nativeBoardOpeners(io).openBoard });
  }
  catch (error) { await reportQuietly(io, error); }
  finally { delete io.relayDeadlineAt; }
}

/** Before a command: link this project when the machine links new ones, sync, then run the person's waiting requests. */
export async function syncBefore(io, main) {
  try { if (io.relayCommand?.cliOperation !== 'sync' && !gitSyncLinked(io.cwd)) await autoLinkProject(io.cwd, io, nativeBoardOpeners(io)); } catch (error) { if (!(error instanceof Refused)) throw error; }
  const local = localFirstLink(io);
  if (local && senderInBackground()) {
    // The sender runs the person's waiting requests too, so a read never waits on them.
    await retrySync(io);
    tellConflicts(io, local);
    return;
  }
  await retrySync(io);
  // An off that only the relay can vouch for is checked against the relay's own authority before anything reads it (#408).
  try { await (await import('../../../../packages/person/index.js')).attestBeforeCommand(io.cwd, io, { DEFAULT_RELAY, relayStatus: root => relayStatus(root, io), openBoard: nativeBoardOpeners(io).openBoard, openBoardForRead: nativeBoardOpeners(io).openBoardForRead }); }
  catch (error) { reportQuietly(io, error); }
  try { await executePersonRequests(io.cwd, io, main, nativePersonRequestPorts(io)); }
  catch (error) { await reportQuietly(io, error); }
  tellConflicts(io, local);
}
