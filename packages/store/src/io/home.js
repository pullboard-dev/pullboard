/**
 * Where this machine and this repository keep relay links, relay keys and pending baseline results, and whether any
 * exists. A command around which none exists has no relay or baseline work to do, so it never loads those modules
 * [C7].
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { repoInfo } from "../../../git/light.js";
import { Refused } from "../../../kernel/light.js";
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

/** A pending baseline result's file name: one per request id. */
export const BASELINE_RECEIPT = /^[a-f0-9-]{36}\.json$/;

/** This machine's private pullboard folder, outside every repository. */
export function pullboardHome() {
  return process.env.PULLBOARD_HOME || join(homedir(), '.pullboard');
}

/** The machine's relay settings folder. */
export function relayMachineDirectory() {
  return join(pullboardHome(), 'relay-machine');
}

/** The relay machine state file, inside the machine's relay settings folder. */
export function relayMachineStateFile() {
  return join(relayMachineDirectory(), 'state.json');
}

/** The machine's relay key folder. */
export function relayKeyDirectory() {
  return join(pullboardHome(), 'relay-keys');
}

/** A repository's relay link, beside its board in the shared Git directory. */
export function relayLinkFile(commonDir) {
  return join(commonDir, 'pullboard', 'relay.json');
}

/** A repository's Git-sharing marker, beside its board in the shared Git directory. */
export function gitSyncMarkerFile(commonDir) {
  return join(commonDir, 'pullboard', 'git-sync.json');
}

/**
 * Whether this machine explicitly enabled account-free Git board sharing [H11]: the marker is a bounded regular file of
 * valid opt-in metadata. This is the same test as the config cell's marker reader, held here so the light door never
 * loads the config package [C7]. A malformed or replaced marker never selects Git sharing.
 */
export function gitSyncLinked(root) {
  const marker = gitSyncMarkerFile(repoInfo(root).commonDir);
  let stat;
  try { stat = fs.lstat(marker); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return false;
    if (error.code === 'ENOTDIR') throw new Refused('GIT_SYNC_FOLDER', `${join(marker, '..')} is not a directory, so the board folder is damaged`,
      `move ${join(marker, '..')} aside, then run pullboard doctor`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
  let value;
  try { value = JSON.parse(fs.readFile(marker, 'utf8')); } catch { return false; }
  const writer = value?.writer;
  const validWriter = writer === undefined || writer && typeof writer === 'object'
    && writer.command === 'sync' && Number.isSafeInteger(writer.pid) && writer.pid > 0
    && typeof writer.at === 'string' && Number.isFinite(Date.parse(writer.at));
  return Boolean(value?.version === 1 && value.remote === 'origin' && value.ref === 'refs/pullboard/board' && validWriter);
}

/** A repository's notice that its relay copy was deleted, which relay status still reads. */
export function relayDeletedFile(commonDir) {
  return join(commonDir, 'pullboard', 'relay-deleted.json');
}

/** A repository's relay link and deleted-copy notice, for the relay client that reads and writes them. */
export function relayFiles(commonDir) {
  return { link: relayLinkFile(commonDir), deleted: relayDeletedFile(commonDir) };
}

/** Whether a repository has relay state to read: a link, or the notice of a deleted copy. */
export function relayStateExists(commonDir) {
  return fs.exists(relayLinkFile(commonDir)) || fs.exists(relayDeletedFile(commonDir));
}

/** A repository's baseline results that finished after their command exited. */
export function baselineReceiptDirectory(commonDir) {
  return join(commonDir, 'pullboard', 'baseline-results');
}

/**
 * Whether the machine's relay state file records nothing due: no linked board, no pending request and no auto-link.
 * One small file is parsed, with no relay import. Why false on any doubt: a missing, unreadable or odd file is left to the
 * full path to report [C7].
 *
 * @returns {boolean}
 */
function relayMachineStateEmpty() {
  const file = relayMachineStateFile();
  if (!fs.exists(file)) return false;
  let state;
  try { state = JSON.parse(fs.readFile(file, 'utf8')); } catch { return false; }
  const none = (value) => value === undefined || Array.isArray(value) && value.length === 0;
  return Boolean(state && typeof state === 'object' && [1, 2].includes(state.v) && state.autoLink === false
    && (state.owner ?? null) === null && (state.pending ?? null) === null
    && none(state.devices) && none(state.revocations) && none(state.approvals));
}

/**
 * Whether the relay sync, auto-link, person requests or baseline delivery around a command could do anything here:
 * a relay token in the environment, relay state on this machine that records anything, a relay link, or a pending
 * baseline result. False only when each of them would return without acting, so skipping them changes nothing.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
export function syncMayAct(cwd) {
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined && process.env.PULLBOARD_RELAY_KEY !== undefined) return true;
  if (fs.exists(relayKeyDirectory()) || (fs.exists(relayMachineDirectory()) && !relayMachineStateEmpty())) return true;
  let info;
  try { info = repoInfo(cwd); }
  catch (error) {
    // Outside a repository every step refuses quietly with these codes; any other failure takes the full path.
    return !(error instanceof Refused && ['NOT_A_REPO', 'CORE_BARE'].includes(error.code));
  }
  if (fs.exists(relayLinkFile(info.commonDir)) || fs.exists(gitSyncMarkerFile(info.commonDir))) return true;
  return baselineReceiptsPending(info.commonDir);
}

/** Whether a finished baseline result waits in this repository's shared Git directory for delivery. */
export function baselineReceiptsPending(commonDir) {
  const receipts = baselineReceiptDirectory(commonDir);
  return fs.exists(receipts) && fs.list(receipts).some((name) => BASELINE_RECEIPT.test(name));
}
