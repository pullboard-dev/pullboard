/** The SSH stand-in's agent host: a child of the test that starts each pulled job's runner agent as its own child [C7]. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The host takes `<folder>/<n>.start` by renaming it, then runs its command as a detached child it keeps; a closed stdin
// means the test process is gone, so the host stops every agent's group and exits.
const HOST_SOURCE = String.raw`
import { readdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const folder = process.argv[2];
const agents = new Set();
const take = () => {
  let names = [];
  try { names = readdirSync(folder); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.start')) continue;
    const taken = join(folder, name + '.taken');
    try { renameSync(join(folder, name), taken); } catch { continue; }
    let request;
    try { request = JSON.parse(readFileSync(taken, 'utf8')); } catch { continue; }
    const agent = spawn('/bin/sh', ['-c', request.command], { cwd: request.cwd, env: request.env, detached: true, stdio: 'ignore' });
    agents.add(agent);
    const gone = () => agents.delete(agent);
    agent.once('exit', gone); agent.once('error', gone);
  }
};
const stop = () => {
  for (const agent of agents) { try { process.kill(-agent.pid, 'SIGTERM'); } catch { /* already gone */ } }
  process.exit(0);
};
process.stdin.on('end', stop); process.stdin.on('error', stop); process.stdin.resume();
try { watch(folder, { persistent: false }, take); } catch { /* the poll below still takes each start */ }
setInterval(take, 250); // budget: a backstop for a missed watch event; a start waits at most this long.
writeFileSync(join(folder, 'pid'), String(process.pid));
take();
`;

let hosts = 0;

/**
 * Start one agent host for a stand-in box and return the folder its stand-in hands agent starts to.
 * Why: an agent the stand-in backgrounds outlives the stand-in's shell and leaves the test's process tree; on the pull
 * runners such an orphan died at once, so its queued job never ran and the test hung to its kill (#6917). The host is
 * the test's child and every agent is the host's child, so the whole chain stays inside the test's tree. Its stdin is
 * the test's pipe, so it ends its agents when the test process exits, and it never holds the test's stdio or event loop.
 *
 * @param {string} bin - The box's private bin folder.
 * @returns {string} The handover folder.
 */
export function startAgentHost(bin) {
  const folder = join(bin, `.agent-host-${process.pid}-${++hosts}`);
  mkdirSync(folder, { mode: 0o700 });
  const program = join(folder, 'host.mjs');
  writeFileSync(program, HOST_SOURCE, { mode: 0o600 });
  const host = spawn(process.execPath, [program, folder], { stdio: ['pipe', 'ignore', 'ignore'] });
  host.on('error', () => { /* no host: handAgentStart finds no pid and the stand-in starts the agent itself */ });
  host.stdin.on('error', () => { /* the host already exited */ });
  host.unref(); host.stdin.unref();
  return folder;
}

/** Whether the host that owns `folder` is alive, read from the pid file it writes once it is listening. */
function hostAlive(folder) {
  let pid;
  try { pid = Number(readFileSync(join(folder, 'pid'), 'utf8')); } catch { return false; }
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Resolve true as soon as `done()` holds after a change in `folder`, or with `done()` once `deadline` passes. */
function untilFolderShows(folder, done, deadline) {
  return new Promise(resolve => {
    let watcher = null, timer = null;
    const finish = value => { watcher?.close(); clearTimeout(timer); resolve(value); };
    const check = () => { if (done()) finish(true); };
    try { watcher = watch(folder, check); } catch { resolve(done()); return; }
    timer = setTimeout(() => finish(done()), Math.max(0, deadline - Date.now()));
    check();
  });
}

/**
 * Hand one agent start to the box's host. Resolves true once the host took it, or false when no host is alive or it did
 * not take the start within the budget; the start is then withdrawn, so the caller may start the agent itself.
 *
 * @param {string} folder - startAgentHost's folder.
 * @param {{ command: string, cwd: string, env: Record<string, string> }} start - The agent line, without a trailing '&'.
 * @param {{ budgetMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function handAgentStart(folder, start, { budgetMs = 10_000 } = {}) { // budget: a host on a loaded runner starts and takes a start within seconds.
  const deadline = Date.now() + budgetMs;
  if (!await untilFolderShows(folder, () => existsSync(join(folder, 'pid')), deadline) || !hostAlive(folder)) return false;
  const name = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const file = join(folder, `${name}.start`);
  writeFileSync(join(folder, `${name}.tmp`), JSON.stringify(start), { mode: 0o600 });
  renameSync(join(folder, `${name}.tmp`), file);
  if (await untilFolderShows(folder, () => !existsSync(file), deadline)) return true;
  // Withdraw it: a rename that succeeds proves the host never took it, so the agent is never started twice.
  try { renameSync(file, `${file}.withdrawn`); return false; } catch { return true; }
}
