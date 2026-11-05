/** Run only an approved due board watch, outside any SQLite write transaction [A6]. */
import { spawn } from './windows-child-process.js';
import { spawnSync } from './windows-child-process.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Refused } from './refused.js';
import { parseProcessCensus } from './process-census.js';
import { sentinels } from './sentinels.js';
import { gitChildEnv } from './git.js';
import { mainCheckout } from './git.js';

/** Prepare immutable local trunk in a private clone, leaving every live checkout untouched. */
export async function withSentinelTrunk(root, action) {
  const trunk = mainCheckout(root);
  if (!trunk?.commit) throw new Refused('SENTINEL_TRUNK', 'commit the primary branch before running sentinels: pullboard sentinel run');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-sentinel-trunk-'));
  const checkout = join(directory, 'checkout');
  const env = gitChildEnv(root);
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], { env, encoding: 'utf8' });
    const selected = clone.status === 0 && spawnSync('git', ['checkout', '--quiet', '--detach', trunk.commit], { cwd: checkout, env, encoding: 'utf8' });
    if (!selected || selected.status !== 0) throw new Refused('SENTINEL_TRUNK', 'the trunk checkout could not be prepared; inspect the primary branch and retry pullboard sentinel run');
    return { results: await action(checkout), trunk };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Keep only bounded final output; a noisy check cannot grow a board receipt without limit. */
function outputTail(previous, chunk) {
  return Buffer.concat([previous, chunk]).subarray(-12_000);
}

/** Read a locale-stable POSIX census; an unavailable census never means an empty owned group. */
function watchCensus() {
  const read = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  }); // budget: bounded process-identity inspection, independent of checker throughput.
  const rows = read.status === 0 ? parseProcessCensus(read.stdout) : null;
  if (!rows) throw new Refused('SENTINEL_DRAIN', 'the watch process census is unavailable; inspect its owned process before retrying');
  return rows;
}

/** Read only the detached session captured before its approved command was allowed to start. */
function watchMembers(pgid, anchor) {
  const rows = watchCensus(), leader = rows.get(pgid);
  if (!anchor || leader && leader.started !== anchor.started) {
    throw new Refused('SENTINEL_DRAIN', 'the watch process-group identity changed; no replacement process was touched');
  }
  return [...rows.values()].filter(row => row.pgid === pgid && !row.state.startsWith('Z'));
}

/** Signal individual owned members only after rechecking PID, start, group and executable. */
function signalWatch(pgid, anchor, signal) {
  for (const member of watchMembers(pgid, anchor)) {
    const now = watchCensus().get(member.pid);
    if (!now || now.pgid !== member.pgid || now.started !== member.started || now.processSha256 !== member.processSha256) continue;
    try { process.kill(member.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

/** Retain custody through normal exit too: redirected, unreferenced children still need shutdown. */
async function drainWatch(pgid, anchor) {
  if (process.platform === 'win32' || !pgid) return;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!watchMembers(pgid, anchor).length) return;
    signalWatch(pgid, anchor, signal);
    const deadline = Date.now() + 2_000; // budget: owned-group shutdown grace, not a performance threshold.
    do {
      if (!watchMembers(pgid, anchor).length) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
  }
  throw new Refused('SENTINEL_DRAIN', 'the owned watch group did not drain; inspect its recorded process before retrying');
}

/** Run one owned process group in the approved directory, with a bounded hang and drained shutdown. */
export function executeSentinel(root, row, { signal, environment = process.env } = {}) {
  return new Promise((settle, reject) => {
    let directory;
    try {
      const base = realpathSync(root);
      directory = realpathSync(resolve(base, row.directory));
      const path = relative(base, directory);
      if (path === '..' || path.startsWith('..' + sep)) throw new Refused('BAD_SENTINEL', 'the approved sentinel directory must remain inside its project');
    } catch (error) { reject(error); return; }
    if (signal?.aborted) { reject(new Refused('SENTINEL_ABORTED', 'the sentinel run stopped before this check began; retry pullboard sentinel run')); return; }
    const start = performance.now();
    const group = process.platform !== 'win32';
    // The shell waits on a private start pipe until its detached group identity is captured.
    // The approved command remains one exact argument, and receives the original ignored stdin.
    const child = group ? spawn('/bin/sh', ['-c', 'IFS= read -r pullboard_watch_start || exit 125; exec /bin/sh -c "$1" </dev/null', 'pullboard-watch', row.check],
      { cwd: directory, env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(row.check, { cwd: directory, env: environment, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let anchor = null;
    let startupError = null;
    let drainError = null;
    let output = Buffer.alloc(0);
    let timedOut = false;
    let stopping = false;
    let closed = false;
    let interrupted = false;
    let hardTimer;
    /** Stop only the child this command spawned, then wait for its close before returning. */
    const send = signalName => {
      if (!Number.isSafeInteger(child.pid)) return;
      try {
        if (group && anchor) signalWatch(child.pid, anchor, signalName);
        else child.kill(signalName); // Before the start handshake, only this direct child can exist.
      } catch (error) {
        drainError ||= error;
        if (!closed) child.kill(signalName);
      }
    };
    const stop = () => {
      if (stopping || closed) return;
      stopping = true; send('SIGTERM');
      hardTimer = setTimeout(() => send('SIGKILL'), 5_000); // budget: owned process-group shutdown grace after TERM.
      hardTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, row.timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', stop, { once: true });
    /** A scheduled run drains its approved command before honoring shutdown. */
    const interrupt = () => { interrupted = true; stop(); };
    process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
    /** Remove only this run's handlers, leaving the embedding process's other handlers untouched. */
    const cleanup = () => {
      closed = true; clearTimeout(timer); clearTimeout(hardTimer); signal?.removeEventListener('abort', stop);
      process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    };
    if (group) {
      child.stdin.on('error', error => { startupError ||= error; stop(); });
      child.once('spawn', () => {
        try {
          anchor = watchCensus().get(child.pid);
          if (!anchor || anchor.pgid !== child.pid) throw new Refused('SENTINEL_DRAIN', 'the watch did not start in its own process group');
          child.stdin.end('start\n');
        } catch (error) { startupError ||= error; stop(); }
      });
    }
    child.stdout.on('data', chunk => { output = outputTail(output, chunk); });
    child.stderr.on('data', chunk => { output = outputTail(output, chunk); });
    child.once('error', error => {
      cleanup(); reject(error);
    });
    child.once('close', async (code, stoppedBy) => {
      try {
        if (group && anchor) await drainWatch(child.pid, anchor);
        if (startupError || drainError) throw startupError || drainError;
        const aborted = interrupted || Boolean(signal?.aborted);
        settle({ green: code === 0 && !timedOut && !aborted, code, timedOut,
          signal: stoppedBy, aborted, durationMs: performance.now() - start, output: output.toString('utf8').split(/\r?\n/u).slice(-12).join('\n') });
      } catch (error) { reject(error); }
      finally { cleanup(); }
    });
  });
}

/** Claim through the ordinary ordered engine, execute without a lock, then publish its exact result. */
export async function runDueSentinels({ root, board, agentId, ordered, signal, execute = executeSentinel }) {
  const results = [];
  for (const row of sentinels(board).filter(entry => entry.status === 'approved')) {
    if (signal?.aborted) break;
    const run = randomUUID();
    let claimed;
    try { claimed = await ordered('beginSentinelRun', [{ agentId, name: row.name, digest: row.digest, run }]); }
    catch (error) { if (error instanceof Refused && error.code === 'STALE_SENTINEL') continue; throw error; }
    if (!claimed) continue;
    let result;
    const began = performance.now();
    try { result = await execute(root, claimed, { signal }); }
    catch (error) {
      result = { green: false, code: null, timedOut: false, signal: null,
        aborted: Boolean(signal?.aborted) || error?.code === 'SENTINEL_ABORTED', durationMs: performance.now() - began,
        output: String(error?.message ?? error).slice(-12_000) };
    }
    try { results.push(await ordered('finishSentinelRun', [{ agentId, name: row.name, digest: row.digest, run, result }])); }
    catch (error) { if (!(error instanceof Refused) || error.code !== 'STALE_SENTINEL') throw error; }
    if (result.aborted) break;
  }
  return results;
}
