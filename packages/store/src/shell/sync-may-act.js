/** Decide whether command preflight can perform local relay or baseline work without loading the board composition [C7]. */
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Refused } from '../../../kernel/core.js';

const BASELINE_RECEIPT = /^[a-f0-9-]{36}\.json$/;

/** The machine's private Pullboard folder. */
function pullboardHome() {
  return process.env.PULLBOARD_HOME || join(homedir(), '.pullboard');
}

/**
 * Decide whether sync preflight has local inputs that may cause work.
 * The caller passes the git cell's repoInfo as a port, so store takes no import past git's front door.
 */
export function syncMayAct(cwd, repoInfo) {
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined && process.env.PULLBOARD_RELAY_KEY !== undefined) return true;
  if (existsSync(join(pullboardHome(), 'relay-machine')) || existsSync(join(pullboardHome(), 'relay-keys'))) return true;
  let info;
  try { info = repoInfo(cwd); }
  catch (error) {
    return !(error instanceof Refused && ['NOT_A_REPO', 'CORE_BARE'].includes(error.code));
  }
  const folder = join(info.commonDir, 'pullboard');
  if (existsSync(join(folder, 'relay.json')) || existsSync(join(folder, 'git-sync.json'))) return true;
  const receipts = join(folder, 'baseline-results');
  return existsSync(receipts) && readdirSync(receipts).some((name) => BASELINE_RECEIPT.test(name));
}
