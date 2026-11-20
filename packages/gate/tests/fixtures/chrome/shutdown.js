/** Bounded native shutdown for the exact browser launched by a fixture [C7]. */
import { spawnSync } from 'node:child_process';
import { closeSync } from 'node:fs';
import { constants } from 'node:fs';
import { fstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read a bounded regular endpoint file without following a substituted symlink. */
function browserEndpoint(profile) {
  const fd = openSync(join(profile, 'DevToolsActivePort'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) return null;
    const [port, path] = readFileSync(fd, 'utf8').trim().split('\n');
    if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535
      || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(path)) return null;
    return { port, path };
  } finally { closeSync(fd); }
}

/** Retain native leader start and executable identity, without reading process arguments. */
export function chromeLeaderIdentity(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,comm='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' } });
  return !result.error && result.status === 0 && !result.stderr.trim() && result.stdout.trim()
    ? result.stdout.trim() : null;
}

/** Bind the published listener to the still-running owned child, never a stale profile's browser. */
function ownsListener(child, port) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid),
    `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpf'], { encoding: 'utf8', timeout: 1000,
    maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = (result.stdout ?? '').trim().split('\n');
  return !result.error && result.status === 0 && !result.stderr.trim()
    && lines[0] === `p${child.pid}` && lines.length > 1 && lines.slice(1).every(line => /^f[^\r\n]+$/u.test(line))
    && child.exitCode === null && child.signalCode === null
    && (!child.guardianIdentity || chromeLeaderIdentity(child.pid) === child.guardianIdentity);
}

/** Attempt Browser.close before the caller's existing bounded signal fallback; uncertainty grants no endpoint authority. */
export async function quitOwnedChrome(child, profile, stopped, timeoutMs = 3000) {
  if (!profile || !child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  let endpoint;
  try { endpoint = browserEndpoint(profile); } catch { return false; }
  if (!endpoint || !ownsListener(child, endpoint.port)) return false;
  let socket;
  let timer;
  let active = true;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`);
    const finished = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      socket.addEventListener('open', () => {
        if (active && child.exitCode === null && child.signalCode === null
          && (!child.guardianIdentity || chromeLeaderIdentity(child.pid) === child.guardianIdentity)) socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      }, { once: true });
      socket.addEventListener('error', () => {}, { once: true });
      stopped.then(async () => {
        // Native clone-cleanup helpers may outlive the browser leader; give the same quit deadline to the whole group.
        while (active) {
          try { process.kill(-child.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { resolve(child.exitCode === 0 && child.signalCode === null); return; } }
          await new Promise(done => setTimeout(done, 25));
        }
      });
    });
    return await finished;
  } catch { return false; }
  finally { active = false; clearTimeout(timer); try { socket?.close(); } catch { /* Existing owned cleanup still runs. */ } }
}

/** Recover a guardian's owned leader status without inventing a clean exit receipt. */
export async function quitGuardedChrome(pid, profile, identity) {
  if (!identity || chromeLeaderIdentity(pid) !== identity) return;
  const child = { pid, guardianIdentity: identity, exitCode: null, signalCode: null };
  let poll;
  const stopped = new Promise(resolve => {
    poll = setInterval(() => {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { child.exitCode = 1; resolve(); } }
    }, 25);
  });
  try { await quitOwnedChrome(child, profile, stopped); }
  finally { clearInterval(poll); }
}

/**
 * The guardian program: poll the watched pids and, once any is gone, take down the Chrome process group.
 * It runs in its own session so the owner's death, by any signal, cannot take it along, and it ends by itself
 * once the group is empty. Escalating to SIGKILL after two seconds covers Chrome helpers that ignore SIGTERM.
 */
export const CHROME_GUARDIAN_SOURCE = `
const [groupText, profile, helper, identity, ...watchText] = process.argv.slice(1);
const group = Number(groupText);
const watched = watchText.map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
let signalledAt = 0;
let quitting = false;
setInterval(async () => {
  if (!alive(-group)) process.exit(0);
  if (watched.every(alive)) return;
  if (!signalledAt) {
    if (quitting) return;
    quitting = true;
    if (profile) { try { const { quitGuardedChrome } = await import(helper); await quitGuardedChrome(group, profile, identity); } catch {} }
    signalledAt = Date.now();
    try { process.kill(-group, 'SIGTERM'); } catch {}
  }
  else if (Date.now() - signalledAt >= 2000) { try { process.kill(-group, 'SIGKILL'); } catch {} }
}, 250);
`;
