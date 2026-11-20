/** A stand-in runner serve for install-serve tests: a separate process, so ps sees it as launchd's serve would be [P7,#10839]. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The stand-in: it waits, and on SIGTERM records whether the new app folder's marker was already in place, then exits. */
export const STAND_IN_SERVE = `const { existsSync, writeFileSync } = require('node:fs');
const [marker, seen] = process.argv.slice(2);
process.on('SIGTERM', () => { writeFileSync(seen, existsSync(marker) ? 'new' : 'old'); process.exit(0); });
setInterval(() => {}, 1000);
process.stdout.write('ready\\n');
`;

/**
 * Start the stand-in running <root>/serve/app/svc.cjs, as launchd would, once it listens for SIGTERM; it is killed after the test.
 * Why a real process: the installer finds a stale serve by its command line in ps, which no in-process double shows.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} root - The install root.
 * @param {string} seen - The file the stand-in writes 'new' or 'old' to on SIGTERM.
 * @returns {Promise<{ pid: number, exited: Promise<{ code: number | null, signal: string | null }> }>}
 */
export async function startStandInServe(t, root, seen) {
  const app = join(root, 'serve', 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'svc.cjs'), STAND_IN_SERVE);
  const child = spawn(process.execPath, [join(app, 'svc.cjs'), join(app, 'marker.txt'), seen], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  await once(child.stdout, 'data');
  return { pid: child.pid, exited };
}
