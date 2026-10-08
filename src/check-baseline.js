/** Observe a proposed check on an isolated copy of main before recording its move [V2,H16]. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitChildEnv, tryGit } from './git.js';
import { runShell } from './gate.js';
import { CONFIG_FILE } from './config.js';

/**
 * Capture the command and main commit once on the sender; replay only receives this observation.
 * A missing main cannot turn a warning into a new gate, and the repo gate is already green there.
 *
 * @param {string} root
 * @param {string} command
 * @returns {{command: string, main: string|null, result: string, reason?: string, seconds?: number}}
 */
export function checkBaseline(root, command) {
  const main = tryGit(root, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  if (main.status !== 0) return { command, main: null, result: 'unavailable', reason: 'no main' };
  const base = { command, main: main.stdout };
  if (command === gateOnMain(root, base.main)) return { ...base, result: 'green', reason: 'repo gate' };
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-check-base-'));
  const checkout = join(directory, 'checkout');
  const env = gitChildEnv(root);
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const selected = clone.status === 0 && spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', base.main], { cwd: checkout, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!selected || selected.status !== 0) return { ...base, result: 'unavailable', reason: 'temporary checkout could not be prepared' };
    const ran = runShell(checkout, command);
    return { ...base, result: ran.isGreen ? 'green' : 'red', seconds: ran.seconds };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Use main's committed gate for the shortcut; a dirty local config cannot manufacture a green base. */
function gateOnMain(root, main) {
  const config = tryGit(root, ['show', `${main}:${CONFIG_FILE}`]);
  if (config.status !== 0) return '';
  try {
    const gate = JSON.parse(config.stdout)?.gate;
    return typeof gate === 'string' ? gate.trim() : '';
  } catch { return ''; }
}

/** Print a recorded observation, including the warning every reviewer must see before work. */
export function sayCheckBaseline(io, item) {
  const base = item.item_check_baseline;
  if (!base) return;
  if (base.result === 'unavailable') {
    io.say(`check baseline unavailable: ${base.reason}`);
    return;
  }
  io.say(`check baseline ${base.result} at main ${base.main}${base.reason ? ` (${base.reason})` : ''}: ${base.command}`);
  if (base.result === 'green') {
    io.say('warning: [CRITERION_PROVES_NOTHING] this check already passes on main; use a check that fails before the work and passes after it');
  }
}
