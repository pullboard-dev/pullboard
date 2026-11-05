/** Isolate blocking Git and gates so the coordinator keeps renewing and fencing its board lease [Q1,Q3]. */
import {
  spawn,
  spawnSync,
} from './windows-child-process.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './board.js';
import {
  invalidateGitFacts,
  mainCheckout,
  repoInfo,
} from './git.js';
import { Refused } from './refused.js';
import { parseProcessCensus } from './process-census.js';

const FILE = fileURLToPath(import.meta.url);

/** Preserve one typed refusal prefix while passing it through more than one process. */
function messageText(error) { return String(error.message).replace(/^\[[A-Z][A-Z0-9_]*\] /u, ''); }

/** Read process identities before attributing a live worker or its detached gate descendants. */
function census() {
  try {
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    if (result.status !== 0) return null;
    const rows = parseProcessCensus(result.stdout);
    rows?.delete(result.pid); // This already-exited observer is never a cleanup target.
    return rows;
  } catch { return null; }
}

/** Stop owned descendants and their group; optional observers exercise census races without signaling foreign processes. */
export function stop(child, member, { read = census, kill = process.kill, log = stopNotice } = {}) {
  if (!child.pid) return;
  const rows = read();
  const root = rows?.get(child.pid);
  const known = member && rows?.get(member.pid);
  const ownsRoot = root && (child.pid === process.pid || root.ppid === process.pid && child.exitCode === null && child.signalCode === null);
  const ownsMember = known && known.pgid === child.pid && known.started === member.started && known.processSha256 === member.processSha256;
  if (!ownsRoot && !ownsMember) return;
  // Shards have separate groups; traverse actual descendant ancestry before stopping the known group.
  const owned = new Set([ownsRoot ? child.pid : member.pid]);
  let changed;
  do {
    changed = false;
    for (const row of rows.values()) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  } while (changed);
  const current = read();
  if (!current) return; // Missing identity evidence never authorizes a process-group signal.
  // Stop producers first: killing a held gate must not wake its worker into post-gate Git work.
  for (const pid of owned) if (pid !== child.pid && !current.get(pid)?.state.startsWith('Z') && current.get(pid)?.started === rows.get(pid)?.started
    && current.get(pid)?.processSha256 === rows.get(pid)?.processSha256) {
    try { kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  // Descendant signals can empty the group; its earlier census is no longer a signal target.
  const group = read();
  if (!group) { log(`landing stop skipped group ${child.pid}: the final process census is unavailable`); return; }
  if (!runningGroup(group, child.pid)) return;
  // Only an original attributed member can witness this group number's lifetime; a zombie still reserves its identity.
  const witnessed = [...owned].some(pid => rows.get(pid)?.pgid === child.pid && group.get(pid)?.pgid === child.pid
    && group.get(pid).started === rows.get(pid).started && group.get(pid).processSha256 === rows.get(pid).processSha256);
  if (!witnessed) { log(`landing stop skipped group ${child.pid}: no recorded original process identity remains in that group`); return; }
  try { kill(-child.pid, 'SIGKILL'); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    const after = error.code === 'EPERM' ? read() : null;
    if (after && !runningGroup(after, child.pid)) return; // macOS can report EPERM for an already-empty group.
    throw error; // A live group or unknown census never licenses suppressing a permission failure.
  }
}

/** Report unattributed remaining work without claiming its group was reused or drained. */
function stopNotice(message) { process.stderr.write(message + '\n'); }

/** Unknown states remain executing; only a known group without non-zombie members is drained. */
function runningGroup(rows, pgid) { return [...rows.values()].some(row => row.pgid === pgid && !row.state.startsWith('Z')); }

/** Run blocking batch work under a live parent that owns all canonical writes and lease renewal. */
export async function runLandingWorker(options, { write, checkLease, checkLeaseNow, bindWorker, watchDeadline, onWait, say, signal }) {
  const child = spawn(process.execPath, [FILE, 'guardian'], { cwd: options.root, env: process.env, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const inFlight = new Set();
  let result;
  let failure;
  let stderr = '';
  let member;
  const unwatch = watchDeadline(until => { if (child.connected) child.send({ type: 'deadline', until }, () => {}); });
  child.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-65536); });
  /** A failed authority check stops the whole owned group before another command can adopt its worktree. */
  const abort = () => { failure ??= signal.reason; stop(child, member); };
  signal.addEventListener('abort', abort, { once: true });
  /** Reply only over this owned child's channel, preserving the original typed refusal. */
  const answer = (id, value, error) => {
    if (!child.connected) return;
    child.send({ type: 'answer', id, value, error: error ? { code: error.code ?? 'LAND_WORKER', message: messageText(error) } : null }, () => {});
  };
  child.on('message', message => {
    if (message.type === 'worker') {
      if (signal.aborted || failure) { stop(child, member); return; }
      try { checkLeaseNow(); }
      catch (error) { failure = error; stop(child, member); return; }
      const row = census()?.get(message.pid);
      if (!row || row.ppid !== child.pid || row.pgid !== child.pid) {
        failure = new Refused('LAND_WORKER', 'the landing worker identity could not be confirmed; inspect pullboard resume before adopting');
        stop(child);
        return;
      }
      member = row;
      child.send({ type: 'worker-start', options: { ...options, guardianPid: child.pid } }, () => {});
      return;
    }
    if (message.type === 'say') { say(message.text); return; }
    if (message.type === 'result') { result = message.value; return; }
    if (message.type === 'failure') { failure = new Refused(message.code, message.message); return; }
    if (message.type !== 'call') return;
    /** Permit only the batch worker's narrow protocol, retaining all authority in this parent. */
    const act = async () => {
      if (signal.aborted || failure) throw signal.reason ?? failure;
      if (message.operation === 'check') { await checkLease(); checkLeaseNow(); return null; }
      if (message.operation === 'wait') return await onWait?.(message.args[0]);
      if (!['recordLandingBatch', 'finishLandingBatch', 'recordLandingFlake', 'recordLandingTestDefect', 'recordFlakeObservation', 'recordGateRun', 'reopen', 'appendFact'].includes(message.operation)) {
        throw new Refused('LAND_WORKER', 'the landing worker requested an unsupported operation; stop it and inspect pullboard resume');
      }
      return await write(message.operation, message.args);
    };
    const pending = act().then(value => answer(message.id, value), error => answer(message.id, null, error));
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending));
  });
  try {
    const terminal = new Promise(resolveClose => {
      child.once('error', error => { failure = error; });
      child.once('exit', (code, terminatedBy) => {
        if (code !== 0 || terminatedBy || result === undefined) {
          failure ??= new Refused('LAND_WORKER', 'the landing guardian stopped unexpectedly; inspect pullboard resume before adopting');
          stop(child, member);
        }
      });
      child.once('close', (code, terminatedBy) => resolveClose({ code, signal: terminatedBy }));
    });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    await bindWorker(child.pid);
    if (signal.aborted) abort();
    else child.send({ type: 'start', options });
    const status = await terminal;
    if (failure) throw failure;
    if (status.code !== 0 || result === undefined) throw new Refused('LAND_WORKER', `the landing worker stopped without a completed batch (${status.signal ?? status.code}); inspect pullboard resume before adopting${stderr ? `: ${stderr.trim()}` : ''}`);
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    unwatch();
    if (child.exitCode === null && child.signalCode === null) stop(child, member);
    await Promise.allSettled(inFlight);
  }
}

/** Make one checked request to the live parent without giving the worker independent board-write authority. */
function channel(group) {
  let next = 0;
  let finished = false;
  const waiting = new Map();
  process.on('message', message => {
    if (message.type !== 'answer') return;
    const pair = waiting.get(message.id);
    if (!pair) return;
    waiting.delete(message.id);
    if (message.error) pair.reject(new Refused(message.error.code, message.error.message));
    else pair.resolve(message.value);
  });
  process.once('disconnect', () => { if (!finished) { try { process.kill(-group, 'SIGKILL'); } catch { process.exit(1); } } });
  const call = (operation, args = []) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    process.send({ type: 'call', id, operation, args });
  });
  return { call, finish(message) { finished = true; process.send(message, () => process.disconnect()); } };
}

/** Enter batch execution only through the parent's private process channel. */
async function workerMain(options) {
  const pipe = channel(options.guardianPid);
  const { call } = pipe;
  const board = store.openBoard(join(repoInfo(options.root).commonDir, 'pullboard', 'board.sqlite'));
  try {
    const { runLandingBatch } = await import('./land.js');
    /** Canonical catch-up may have moved proof or trunk while the request was in flight. */
    const checkLease = async () => { await call('check'); invalidateGitFacts(); assertWorkerFence(board, options.fence, options.root); };
    const result = await runLandingBatch({ ...options, board, write: (operation, args) => call(operation, args),
      say: text => process.send({ type: 'say', text }), onWait: state => call('wait', [state]), checkLease,
      checkLeaseNow: () => assertWorkerFence(board, options.fence, options.root) });
    pipe.finish({ type: 'result', value: result });
  } catch (error) {
    process.exitCode = 1;
    pipe.finish({ type: 'failure', code: error.code ?? 'LAND_WORKER', message: messageText(error) });
  } finally { store.closeBoard(board); }
}

/** Check the shared native board immediately before a physical Git action, with no intervening await. */
function assertWorkerFence(board, fence, root) {
  // This imported live binding is used only after module initialization, keeping board cycles inert.
  const holder = assertLandingLease(board, fence);
  invalidateGitFacts();
  if (mainCheckout(root)?.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the trunk branch changed; start a fresh land command for its current branch');
  return holder;
}
import { assertLandingLease } from './landing-lease.js';

/** A nonblocking guardian survives CLI death and stops its own whole group, even while the worker is synchronous. */
function guardianMain() {
  let worker;
  let finished = false;
  let closed = false;
  let pending = 0;
  let deadline = 0;
  let expiring = false;
  /** Fail closed independently of a suspended CLI, using only its last acknowledged authority deadline. */
  const expire = () => {
    if (finished || expiring) return;
    expiring = true;
    if (process.connected) process.send({ type: 'failure', code: 'LAND_LEASE_LOST', message: 'the guardian stopped its owned worker before the acknowledged landing lease expired' }, () => stop({ pid: process.pid }));
    else stop({ pid: process.pid });
  };
  const watchdog = setInterval(() => { if (deadline && Date.now() >= deadline - 1500) expire(); }, 100);
  /** Flush result and refusal messages before ending this private channel normally. */
  const finish = () => {
    if (!closed || pending) return;
    finished = true;
    clearInterval(watchdog);
    if (process.connected) process.disconnect();
  };
  process.on('message', message => {
    if (message.type === 'deadline') {
      if (Number.isFinite(message.until)) deadline = message.until;
      return;
    }
    if (message.type === 'start' && !worker) {
      // The worker stays in this guardian's detached group; its gates inherit that group too.
      // Worker observations must not leave an optional status-refresh index lock when interrupted.
      worker = spawn(process.execPath, [FILE, 'worker'], { cwd: message.options.root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      worker.on('message', value => {
        if (!process.connected) return;
        pending += 1;
        process.send(value, () => { pending -= 1; finish(); });
      });
      worker.once('error', error => {
        if (process.connected) process.send({ type: 'failure', code: 'LAND_WORKER', message: error.message });
      });
      worker.once('close', (code, signal) => {
        closed = true;
        process.exitCode = code ?? (signal ? 1 : 0);
        finish();
      });
      worker.once('spawn', () => process.send({ type: 'worker', pid: worker.pid }));
    } else if (message.type === 'worker-start' && worker?.connected) {
      if (!deadline || Date.now() >= deadline - 1500) { expire(); return; }
      worker.send({ type: 'start', options: message.options });
    } else if (worker?.connected) worker.send(message, () => {});
  });
  process.once('disconnect', () => { if (!finished) stop({ pid: process.pid }); });
}

if (process.argv[1] === FILE && process.send) {
  if (process.argv[2] === 'guardian') guardianMain();
  else if (process.argv[2] === 'worker') process.once('message', message => {
    if (message.type === 'start') void workerMain(message.options);
  });
}
