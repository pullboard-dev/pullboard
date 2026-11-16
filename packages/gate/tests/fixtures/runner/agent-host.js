/** The SSH stand-in's agent host: a child of the test that starts each pulled job's runner agent as its own child [C7]. */
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

// The host listens on a loopback port it writes to `<folder>/port`. Each connection sends one JSON start line; the host
// runs its command as a detached child it keeps and answers "ok". A closed stdin means the test process is gone, so the
// host stops every agent's group and exits. Sockets, not folder events: a LaunchDaemon may get no folder events.
const HOST_SOURCE = String.raw`
import { renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
const folder = process.argv[2];
const agents = new Set();
const server = createServer(socket => {
  let line = '';
  socket.on('error', () => {});
  socket.on('data', part => {
    line += part;
    const end = line.indexOf('\n');
    if (end < 0) return;
    let request;
    try { request = JSON.parse(line.slice(0, end)); } catch { socket.end('bad\n'); return; }
    const agent = spawn('/bin/sh', ['-c', request.command], { cwd: request.cwd, env: request.env, detached: true, stdio: 'ignore' });
    agents.add(agent);
    const gone = () => agents.delete(agent);
    agent.once('exit', gone); agent.once('error', gone);
    socket.end('ok\n');
  });
});
const stop = () => {
  for (const agent of agents) { try { process.kill(-agent.pid, 'SIGTERM'); } catch { /* already gone */ } }
  process.exit(0);
};
process.stdin.on('end', stop); process.stdin.on('error', stop); process.stdin.resume();
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(folder, 'port.tmp'), String(server.address().port));
  renameSync(join(folder, 'port.tmp'), join(folder, 'port'));
});
`;

let hosts = 0;
const liveHosts = new Set();
/**
 * End every host once the test's work is done. Why: the gate's child drain waits at beforeExit for every child the test
 * spawned, and a host that only ended with the test process held that drain to its timeout.
 */
const endHosts = () => { for (const host of liveHosts) host.stdin.end(); liveHosts.clear(); };

/**
 * Make the folder of a `nohup` that behaves as on an ssh remote, ignoring HUP and running its command, for the front of
 * the stand-in's PATH; returns the folder.
 * Why: macOS nohup detaches from the launchd console first, and in a LaunchDaemon, as a pull runner's serve is, that
 * fails with "can't detach from console", so every agent start died silently and its job sat queued (#6917). A real ssh
 * session is not launchd-managed, so the stand-in gives its remote that behaviour.
 *
 * @param {string} bin - The box's private bin folder.
 * @returns {string}
 */
export function installRemoteNohup(bin) {
  const folder = join(bin, '.remote-bin');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const nohup = join(folder, 'nohup');
  writeFileSync(nohup, "#!/bin/sh\ntrap '' HUP\nexec \"$@\"\n", { mode: 0o700 });
  chmodSync(nohup, 0o700);
  return folder;
}

/**
 * Start one agent host for a stand-in box and return the folder its stand-in hands agent starts to.
 * Why: an agent the stand-in backgrounds outlives the stand-in's shell and leaves the test's process tree. The host is
 * the test's child and every agent is the host's child, so the whole chain stays inside the test's tree (#6917). Its
 * stdin is the test's pipe, so it ends its agents when the test process exits, and it never holds the test's stdio or
 * event loop.
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
  host.on('error', () => { /* no host: handAgentStart finds no port and the stand-in starts the agent itself */ });
  host.stdin.on('error', () => { /* the host already exited */ });
  host.unref(); host.stdin.unref();
  if (!liveHosts.size) process.once('beforeExit', endHosts);
  liveHosts.add(host);
  host.once('exit', () => liveHosts.delete(host));
  return folder;
}

/**
 * Hand one agent start to the box's host. Resolves true once the host answered that it started it, or false when no
 * host listens or it did not answer within the budget, so the caller starts the agent itself.
 * A host that took a start but whose answer was lost makes the caller start a second agent; that is harmless, as the
 * agent's lock lets only one run.
 *
 * @param {string} folder - startAgentHost's folder.
 * @param {{ command: string, cwd: string, env: Record<string, string> }} start - The agent line, without a trailing '&'.
 * @param {{ budgetMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function handAgentStart(folder, start, { budgetMs = 10_000 } = {}) { // budget: a host on a loaded runner answers within seconds.
  let port;
  try { port = Number(readFileSync(join(folder, 'port'), 'utf8')); } catch { return Promise.resolve(false); }
  if (!Number.isSafeInteger(port) || port < 1) return Promise.resolve(false);
  return new Promise(resolve => {
    let answer = '';
    const socket = connect({ port, host: '127.0.0.1' }, () => socket.write(`${JSON.stringify(start)}\n`));
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(budgetMs, () => finish(false));
    socket.on('data', part => { answer += part; if (answer.includes('\n')) finish(answer.startsWith('ok')); });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(answer.startsWith('ok')));
  });
}
