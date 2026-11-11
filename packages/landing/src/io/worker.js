/** Stop a landing's owned process group, and fence each physical Git action on the landing lease [Q1,Q3,C7]. */
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { invalidateGitFacts } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/** Read process identities before attributing a live worker or its detached gate descendants. */
function census(parseProcessCensus) {
  try {
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
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

/** The environment name of the token a landing's timed gate workers carry on their command line, for its guardian to find them by. */
export const CUSTODY_ENV = 'PULLBOARD_LANDING_CUSTODY';

/** Pids of the live timed gate workers carrying a landing's token; the random token is their identity, so a reused pid never matches. */
function registeredGates(token) {
  return new Promise(resolve => execFile('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
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
export function startGuardian({ onDeath }) {
  const token = randomUUID();
  const code = `import(${JSON.stringify(import.meta.url)}).then(module => module.guardianMain(${JSON.stringify(token)}))`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let ended = false;
  // Refuse first: the stopped gate then fails into an aborted landing, so its fall-out cannot block the batch or name itself the cause.
  child.once('exit', () => { if (ended) return; onDeath(); draining = stopRegisteredGates(token).catch(() => {}); });
  process.env[CUSTODY_ENV] = token;
  return {
    pid: child.pid,
    /** Resolves once a guardian death has finished stopping the gates, so the landing never releases before they are gone. */
    settle: () => draining,
    deadline(at) { if (child.connected) child.send({ deadline: at }); },
    end() {
      ended = true;
      delete process.env[CUSTODY_ENV];
      if (child.connected) child.send({ end: true }, () => {});
    },
  };
}

/** The guardian process body: stop the landing's gate workers when the command's channel closes or the deadline lapses. */
export function guardianMain(token) {
  let deadline = Infinity;
  let finishing = false;
  /** Stop the gates once, then leave. */
  const act = () => { if (finishing) return; finishing = true; void stopRegisteredGates(token).finally(() => process.exit(0)); };
  process.on('message', message => {
    if (message?.end) { finishing = true; process.exit(0); }
    if (Number.isFinite(message?.deadline)) deadline = message.deadline;
  });
  process.on('disconnect', act);
  setInterval(() => { if (Date.now() >= deadline) act(); }, 250);
}
