/** Lightweight post-land wakeup; the worker independently checks source, ownership and batch history [C7]. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeIsFromMain } from '../../../../../git/index.js';
import { git } from '../../../../../git/index.js';
import { gitChildEnv } from '../../../../../git/index.js';
import { repoInfo } from '../../../../../git/index.js';
import { mainAuditDirectory } from './state.js';
import { readMainAudit } from './state.js';

/**
 * Call only after foreground checkout/landing leases release; never await an audit or gate admission.
 * The cells inventory is not produced here: the first gate that needs it gets it through its cells-inventory job.
 */
export async function nudgeMainAudit(root, workerUrl) {
  const info = repoInfo(root);
  if (!info.isMain || !codeIsFromMain()) return null;
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:') throw new TypeError('main audit nudge requires its actual process entry URL');
  // An unactivated repository has no audit work; avoid starting a detached no-op child.
  // Malformed/unreadable state still follows the worker's ordinary diagnostic path.
  try { if (!readMainAudit(join(mainAuditDirectory(info), 'activation.json'))) return null; }
  catch { /* Let the worker preserve its normal failure handling for unknown state. */ }
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:') throw new TypeError('main audit nudge requires its actual process entry URL');
  const env = gitChildEnv(root);
  // An independent job may not borrow the foreground command's admission or checkout ownership.
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[key];
  const child = spawn(process.execPath, [fileURLToPath(workerUrl), info.root, randomUUID(), '--scheduled'],
    { cwd: info.root, env, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}

/**
 * Whether an activated main checkout's tip differs from the last green audited tip.
 *
 * Why: a hand landing, a plain `merged` or a hotfix commit moves main with no landing command,
 * so the sentinel sweep asks this and nudges the audit whatever moved main [C7].
 */
export function mainMovedSinceAudit(root) {
  let info;
  try { info = repoInfo(root); } catch { return false; } // Outside a repository there is no main to audit.
  if (!info.isMain) return false;
  const directory = mainAuditDirectory(info);
  try { if (!readMainAudit(join(directory, 'activation.json'))) return false; }
  catch { return true; } // Unreadable state goes to the worker, which records its own diagnosis.
  let tip;
  try { tip = git(info.root, ['rev-parse', '--verify', '-q', 'refs/heads/main^{commit}']); }
  catch { return false; } // No main branch: nothing to audit.
  let last;
  try { last = readMainAudit(join(directory, 'last-green.json'))?.tip; }
  catch { last = null; } // A malformed record never counts as audited.
  return Boolean(tip) && tip !== last;
}
