/** A main-only wake starts independent finite source work after foreground leases release [C7,V4]. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { codeIsFromMain } from './git.js';
import { gitChildEnv } from './git.js';
import { repoInfo } from './git.js';

/** Never borrow the caller's test or checkout admission, and never wait for the actual gate. */
export async function nudgeSourceAdvances(root) {
  const info = repoInfo(root);
  if (!info.isMain || !codeIsFromMain()) return null;
  const env = gitChildEnv(root);
  for (const key of ['PULLBOARD_GATE_SLOT_HELD','PULLBOARD_GATE_SLOT_POOL','PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_BROWSER_SLOT_HELD','PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/source-advance.js', import.meta.url)), info.root, randomUUID()],
    { cwd: info.root, env, detached: true, stdio: 'ignore' });
  await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
  child.unref(); return child;
}
