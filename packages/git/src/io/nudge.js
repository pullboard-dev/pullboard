/** A main-only wake starts independent finite source work after foreground leases release [C7,V4]. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { codeIsFromMain } from "./main.js";
import { gitChildEnv } from "./main.js";
import { repoInfo } from "./main.js";

/** The higher-layer caller supplies the literal worker URL; this Git wake owns no application dependency.
 * Never borrow the caller's test or checkout admission, and never wait for the actual gate. */
export async function nudgeSourceAdvances(root, { workerUrl, eligible }) {
  const info = repoInfo(root);
  if (!info.isMain || !codeIsFromMain()) return null;
  // The higher-layer caller owns the application eligibility probe; this Git cell only
  // accepts its explicit decision and leaves real work to the normal worker.
  if (eligible !== true) return null;
  const env = gitChildEnv(root);
  for (const key of ['PULLBOARD_GATE_SLOT_HELD','PULLBOARD_GATE_SLOT_POOL','PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_BROWSER_SLOT_HELD','PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[key];
  const child = spawn(process.execPath, [fileURLToPath(workerUrl), info.root, randomUUID()],
    { cwd: info.root, env, detached: true, stdio: 'ignore' });
  await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
  child.unref(); return child;
}
