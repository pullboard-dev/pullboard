/** Stop a landing's owned process group, and fence each physical Git action on the landing lease [Q1,Q3,C7]. */
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { invalidateGitFacts } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { environmentAdapter } from '../../../env/index.js';

/** Read process identities before attributing a live worker or its detached gate descendants. */
function census(parseProcessCensus) {
  try {
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], { encoding: 'utf8', env: { ...environmentAdapter().all(), LC_ALL: 'C', TZ: 'UTC' } });
    if (result.status !== 0) return null;
    const rows = parseProcessCensus(result.stdout);
    rows?.delete(result.pid); // This already-exited observer is never a cleanup target.
    return rows;
  } catch { return null; }
}

/** Stop owned descendants and their group; optional observers exercise census races without signaling foreign processes. */
export function stop(child, member, { parseProcessCensus, read = () => census(parseProcessCensus), kill = process.kill, log = stopNotice } = {}) {
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

/** Check the shared native board immediately before a physical Git action, with no intervening await. */
export function assertWorkerFence(board, fence, root) {
  // This imported live binding is used only after module initialization, keeping board cycles inert.
  const holder = assertLandingLease(board, fence);
  invalidateGitFacts();
  if (mainCheckout(root)?.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the trunk branch changed; start a fresh land command for its current branch');
  return holder;
}
import { assertLandingLease } from '../../../store/index.js';
import { landingLeaseState } from '../../../store/index.js';
import { LANDING_LEASE_MS } from '../../../store/index.js';
import { LANDING_LOCAL_PREFIX } from '../../../store/index.js';
import { DatabaseSync } from 'node:sqlite';

/** The environment name of the token a landing's timed gate workers carry on their command line, for its guardian to find them by. */
export const CUSTODY_ENV = 'PULLBOARD_LANDING_CUSTODY';

/** Pids of the live timed gate workers carrying a landing's token; the random token is their identity, so a reused pid never matches. */
function registeredGates(token) {
  return new Promise(resolve => execFile('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...environmentAdapter().all(), LC_ALL: 'C' } }, (error, stdout) => {
    resolve(error ? [] : stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+) (.*)$/u.exec(line);
      return match && match[2].includes(`--landing-custody=${token}`) && Number(match[1]) !== process.pid ? [Number(match[1])] : [];
    }));
  }));
}

/**
 * Stop every timed gate worker of one landing and wait until each has drained or is gone.
 * SIGTERM first: the worker's own handler drains its descendants and process groups; SIGKILL only after 20 s.
 * Why: the gate runs in its own process groups, so a dead landing command left it running beside the next landing [Q1,Q3,B3].
 */
export async function stopRegisteredGates(token, { pause = ms => new Promise(resolve => setTimeout(resolve, ms)), limitMs = 20_000 } = {}) {
  const end = Date.now() + limitMs;
  let signal = 'SIGTERM';
  for (let live = await registeredGates(token); live.length; live = await registeredGates(token)) {
    if (Date.now() >= end) signal = 'SIGKILL';
    for (const pid of live) { try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* Gone already. */ } } }
    await pause(100);
  }
}

/**
 * Start the independent guardian of one landing: a process of its own that stops the landing's gate workers when
 * the landing command dies or its lease deadline passes unrenewed, and is itself watched by the command.
 * Returns its pid, a deadline sender, and `end()` for a normal finish; `onDeath` runs when the guardian dies first.
 */
export function startGuardian({ onDeath, boardFile = null, leaseToken = null }) {
  const token = randomUUID();
  const code = `import(${JSON.stringify(import.meta.url)}).then(module => module.guardianMain(${JSON.stringify(token)}, ${JSON.stringify({ boardFile, leaseToken })}))`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let ended = false;
  let draining = null;
  // Refuse first: the stopped gate then fails into an aborted landing, so its fall-out cannot block the batch or name itself the cause.
  child.once('exit', () => { if (ended) return; onDeath(); draining = stopRegisteredGates(token).catch(() => {}); });
  environmentAdapter().set(CUSTODY_ENV, token);
  return {
    pid: child.pid,
    /** Resolves once a guardian death has finished stopping the gates, so the landing never releases before they are gone. */
    settle: () => draining,
    deadline(at) { if (child.connected) child.send({ deadline: at }); },
    end() {
      ended = true;
      environmentAdapter().delete(CUSTODY_ENV);
      if (child.connected) child.send({ end: true }, () => {});
    },
  };
}

/**
 * True when the board no longer shows this landing as the holder, or shows its lease past its deadline. It reads the lease the
 * way the fence does (the local heartbeat over the shared record), so an aged lease stops the gate as well as a late IPC deadline.
 */
export function leaseLapsed(boardFile, leaseToken, now = Date.now()) {
  let db;
  try {
    db = new DatabaseSync(boardFile, { readOnly: true });
    const holder = landingLeaseState({ db }).holder;
    return !holder || holder.token !== leaseToken || Date.parse(holder.until) <= now;
  } catch { return false; } // An unreadable or busy board proves nothing; the IPC deadline and channel still guard.
  finally { try { db?.close(); } catch { /* Already closed. */ } }
}

/** How long the guardian keeps renewing for a lander that sends it nothing: the landing's default stall limit [C7,#5770]. */
export const GUARDIAN_RENEW_MS = 600_000;

/**
 * Extend one landing's local heartbeat from its guardian, off the lander's event loop, and return the new deadline in ms;
 * null when nothing changed. Only a lease the board still names, with a heartbeat that has not lapsed, is extended, so a
 * lapsed or released lease is never revived; a busy or unreadable board is tried again on the next tick.
 * Why: the lander's synchronous Git and board work under load starved its 5 s heartbeat past the 2-minute lease, and
 * the lost lease crashed the lander mid-batch (#5770).
 */
export function renewGuardedHeartbeat(boardFile, leaseToken, now = Date.now()) {
  let db;
  try {
    db = new DatabaseSync(boardFile);
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const key = LANDING_LOCAL_PREFIX + leaseToken;
      const row = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
      const local = row && JSON.parse(row.meta_value);
      const holder = landingLeaseState({ db }).holder;
      if (holder?.token !== leaseToken || !local || !(Date.parse(local.until) > now)) { db.exec('ROLLBACK'); return null; }
      const until = Math.max(Date.parse(local.until), now + LANDING_LEASE_MS);
      db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify({ ...local, until: new Date(until).toISOString() }), key);
      db.exec('COMMIT');
      return until;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Not in a transaction. */ } throw error; }
  } catch { return null; }
  finally { try { db?.close(); } catch { /* Already closed. */ } }
}

/** The board's own deadline for a landing's lease in ms, or null when the board names another holder or cannot be read. */
function boardDeadline(boardFile, leaseToken) {
  let db;
  try {
    db = new DatabaseSync(boardFile, { readOnly: true });
    const holder = landingLeaseState({ db }).holder;
    return holder?.token === leaseToken ? Date.parse(holder.until) : null;
  } catch { return null; }
  finally { try { db?.close(); } catch { /* Already closed. */ } }
}

/**
 * The guardian process body: stop the landing's gate workers when the command's channel closes, the deadline lapses, or the
 * board's lease has. Every 5 s it also renews the lease's heartbeat while the command has spoken within GUARDIAN_RENEW_MS, and
 * a passed IPC deadline defers to the board's own while the board still names the lease, so a lander whose event loop is
 * blocked by synchronous work keeps its lease; a dead command still ends it at once through the closed channel [C7,#5770].
 */
export function guardianMain(token, { boardFile = null, leaseToken = null } = {}) {
  let deadline = Infinity;
  let finishing = false;
  let heard = Date.now();
  /** Stop the gates once, then leave. */
  const act = () => { if (finishing) return; finishing = true; void stopRegisteredGates(token).finally(() => process.exit(0)); };
  process.on('message', message => {
    heard = Date.now();
    if (message?.end) { finishing = true; process.exit(0); }
    if (Number.isFinite(message?.deadline)) deadline = message.deadline;
  });
  process.on('disconnect', act);
  // A command killed while this guardian was still importing closed the channel before the listener above existed; without
  // this check the guardian outlived it until the lease expired, and the next landing waited the whole 2 minutes (#5738).
  if (!process.connected) act();
  setInterval(() => {
    if (finishing || Date.now() < deadline) return;
    const board = boardFile && leaseToken ? boardDeadline(boardFile, leaseToken) : null;
    if (board > Date.now()) deadline = board; else act();
  }, 250);
  if (!boardFile || !leaseToken) return;
  let tick = 0;
  setInterval(() => {
    if (finishing) return;
    if (leaseLapsed(boardFile, leaseToken)) { act(); return; }
    if (++tick % 5 === 0 && Date.now() - heard <= GUARDIAN_RENEW_MS) renewGuardedHeartbeat(boardFile, leaseToken);
  }, 1000);
}
