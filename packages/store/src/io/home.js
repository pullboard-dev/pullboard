/**
 * Where this machine and this repository keep relay links, relay keys and pending baseline results, and whether any
 * exists. A command around which none exists has no relay or baseline work to do, so it never loads those modules
 * [C7].
 */
import {
  existsSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { repoInfo } from "../../../git/index.js";
import { Refused } from "../../../kernel/index.js";
import { gitSyncMarkerLinked } from "../../../config/index.js";

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

/** The machine's relay key folder. */
export function relayKeyDirectory() {
  return join(pullboardHome(), 'relay-keys');
}

/** A repository's relay link, beside its board in the shared Git directory. */
export function relayLinkFile(commonDir) {
  return join(commonDir, 'pullboard', 'relay.json');
}

/** Whether this machine explicitly enabled account-free Git board sharing [H11]. */
export function gitSyncLinked(root) {
  return gitSyncMarkerLinked(root);
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
  return existsSync(relayLinkFile(commonDir)) || existsSync(relayDeletedFile(commonDir));
}

/** A repository's baseline results that finished after their command exited. */
export function baselineReceiptDirectory(commonDir) {
  return join(commonDir, 'pullboard', 'baseline-results');
}

/**
 * Whether the relay sync, auto-link, person requests or baseline delivery around a command could do anything here:
 * a relay token in the environment, relay state on this machine, a relay link, or a pending baseline result. False
 * only when each of them would return without acting, so skipping them changes nothing.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
export function syncMayAct(cwd) {
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined && process.env.PULLBOARD_RELAY_KEY !== undefined) return true;
  if (existsSync(relayMachineDirectory()) || existsSync(relayKeyDirectory())) return true;
  let info;
  try { info = repoInfo(cwd); }
  catch (error) {
    // Outside a repository every step refuses quietly with these codes; any other failure takes the full path.
    return !(error instanceof Refused && ['NOT_A_REPO', 'CORE_BARE'].includes(error.code));
  }
  if (existsSync(relayLinkFile(info.commonDir)) || existsSync(join(info.commonDir, 'pullboard', 'git-sync.json'))) return true;
  const receipts = baselineReceiptDirectory(info.commonDir);
  return existsSync(receipts) && readdirSync(receipts).some((name) => BASELINE_RECEIPT.test(name));
}
