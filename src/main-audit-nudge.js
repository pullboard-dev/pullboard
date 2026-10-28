/** Lightweight post-land wakeup; the worker independently checks source, ownership and batch history [C7]. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeIsFromMain } from './git.js';
import { gitChildEnv } from './git.js';
import { repoInfo } from './git.js';
import { mainAuditDirectory } from './main-audit-state.js';
import { readMainAudit } from './main-audit-state.js';

/** Call only after foreground checkout/landing leases release; never await an audit or gate admission. */
export async function nudgeMainAudit(root) {
  const info = repoInfo(root);
  if (!info.isMain || !codeIsFromMain()) return null;
  // An unactivated repository has no audit work; avoid starting a detached no-op child.
  // Malformed/unreadable state still follows the worker's ordinary diagnostic path.
  try { if (!readMainAudit(join(mainAuditDirectory(info), 'activation.json'))) return null; }
  catch { /* Let the worker preserve its normal failure handling for unknown state. */ }
  const env = gitChildEnv(root);
  // An independent job may not borrow the foreground command's admission or checkout ownership.
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/main-audit.js', import.meta.url)), info.root, randomUUID(), '--scheduled'],
    { cwd: info.root, env, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}
