/** A checkout belongs to one local agent session; bindings never enter the shared board [B3,B7]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  holdsLease,
  takeResource,
} from '../../../../resources/light.js';
import { Refused } from '../../../../kernel/index.js';
import { environmentAdapter } from '../../../../env/index.js';
import { checkoutSessionFile } from './binding.js';
export { checkoutSessionFile } from './binding.js';

/**
 * A command that holds this checkout passes its lease to the processes it starts, its Git hooks among them, so they act
 * under it instead of queueing behind their own parent (#906: init --yes committed, and its pre-commit hook waited on
 * init forever).
 */
export const CHECKOUT_SESSION_TOKEN_ENV = 'PULLBOARD_CHECKOUT_SESSION_TOKEN';
/** How long a hook waits for a checkout another command holds before it names the holder and stops (#906). */
export const HOOK_CHECKOUT_WAIT_MS = 30_000;

/** The folder of live writer records in one checkout, beside its session binding. */
export function checkoutWritersDirectory(info) {
  return join(info.gitDir, 'pullboard-checkout-writers');
}

/** The file a takeover writes before it waits, so writers arriving after it queue behind it. */
function takeoverIntentFile(info) {
  return join(info.gitDir, 'pullboard-checkout-takeover');
}

/** Remove a takeover's intent once it ends. */
function removeTakeoverIntent(info) {
  try { unlinkSync(takeoverIntentFile(info)); } catch { /* No intent left: nothing to remove. */ }
}

/** Whether a parent command's inherited token names a writer record still present in this checkout. */
function liveWriterToken(info, token) {
  return typeof token === 'string' && /^[a-f0-9-]{36}$/u.test(token) && existsSync(join(checkoutWritersDirectory(info), token + '.json'));
}

/** Record this process as an active writer of the checkout; the record is the token its children inherit. */
function writeWriterRecord(info) {
  const directory = checkoutWritersDirectory(info);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const file = join(directory, token + '.json');
  writeFileSync(file, JSON.stringify({ version: 1, pid: process.pid, at: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
  return { token, file };
}

/** Remove a writer record; a record already gone needs nothing. */
function removeWriterRecord(record) {
  try { unlinkSync(record.file); } catch { /* Gone already: a takeover reclaimed it, or the folder was removed. */ }
}

/** When a process started, in epoch ms, or null when the OS cannot say (gone, or no ps). */
function processStartedAt(pid) {
  return new Promise((done) => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } },
      (error, stdout) => {
        const at = error ? NaN : Date.parse(String(stdout).trim());
        done(Number.isFinite(at) ? at : null);
      });
  });
}

/**
 * The writer records in a checkout that belong to running processes; records of dead processes, or of a pid reused by
 * a process that started after the record was written, are removed. Why: a crashed command leaves its record behind,
 * and a takeover must never wait on a writer that no longer exists.
 */
export async function liveCheckoutWriters(info) {
  const directory = checkoutWritersDirectory(info);
  let names;
  try { names = readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name)); } catch { return []; }
  const live = [];
  for (const name of names) {
    const file = join(directory, name);
    let record = null;
    try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A record being written or removed reads as nothing. */ }
    if (!Number.isSafeInteger(record?.pid) || !Number.isFinite(record?.at)) continue;
    let alive = true;
    try { process.kill(record.pid, 0); } catch (error) { alive = error.code === 'EPERM'; }
    const startedAt = alive ? await processStartedAt(record.pid) : null;
    // ps reports whole seconds, so a process that started within a second after the record is still its writer.
    if (!alive || startedAt !== null && startedAt > record.at + 1_000) { try { unlinkSync(file); } catch { /* Gone already. */ } continue; }
    live.push({ ...record, file });
  }
  return live;
}

/**
 * Enter a write without the checkout's lease when this checkout is already bound to this very session and no takeover
 * is waiting, or return null for the leased path. Why: holding the lease for a whole command made every write in one
 * checkout queue behind the slowest; on 9 Nov the coordinator's hold, add and edit waited over ten minutes behind a
 * `merged` that ran tests (#C7). The record is written before the binding is read, and a takeover writes its intent
 * before it reads the records, so a takeover either sees this writer or this writer sees the takeover.
 */
function enterBoundSession(info, file, agent, digest) {
  let record;
  try { record = writeWriterRecord(info); } catch { return null; }
  try {
    const current = readBinding(file, false);
    if (current?.agent === agent && current.digest === digest && !existsSync(takeoverIntentFile(info))) return record;
  } catch { /* An unreadable binding refuses on the leased path, with its own next step. */ }
  removeWriterRecord(record);
  return null;
}

/** Hand back a write turn whose children act under its writer record, and which removes that record when it ends. */
function writerTurn(record, persist) {
  const env = environmentAdapter();
  const previous = env.get(CHECKOUT_SESSION_TOKEN_ENV);
  env.set(CHECKOUT_SESSION_TOKEN_ENV, record.token);
  let ended = false;
  const release = () => {
    if (ended) return;
    ended = true;
    if (env.get(CHECKOUT_SESSION_TOKEN_ENV) === record.token) {
      if (previous === undefined) env.delete(CHECKOUT_SESSION_TOKEN_ENV);
      else env.set(CHECKOUT_SESSION_TOKEN_ENV, previous);
    }
    removeWriterRecord(record);
  };
  return { release, updateAgent: persist };
}

/** Wait until no live writer record remains in this checkout; a takeover holds the lease and its intent meanwhile. */
function drainCheckoutWriters(info) {
  return new Promise((done, fail) => {
    /** Look once, and again after a short pause while another writer still runs. */
    const look = () => liveCheckoutWriters(info).then((writers) => {
      if (writers.length) setTimeout(look, 50);
      else done();
    }, fail);
    look();
  });
}

/** Take the checkout's lease, act under the one a parent command passed down, or stop after waitLimitMs naming the holder. */
async function checkoutLease(info, name, agent, waitLimitMs) {
  const inherited = environmentAdapter().get(CHECKOUT_SESSION_TOKEN_ENV);
  if (inherited && (liveWriterToken(info, inherited) || holdsLease({ name, scope: 'repo', root: info.root, token: inherited }))) return { token: inherited, inherited: true, release() {} };
  const startedAt = Date.now();
  const onWait = waitLimitMs ? (state) => {
    if (Date.now() - startedAt < waitLimitMs) return;
    const holder = state?.holders?.[0];
    throw new Refused('CHECKOUT_BUSY', `this checkout is in use by ${holder ? `${holder.agent} (since ${holder.since})` : 'another Pullboard command'}, `
      + `and this hook waited ${Math.round(waitLimitMs / 1000)} s for it; let that command finish, or stop it if it is stuck, then commit again`);
  } : undefined;
  return takeResource({ name, capacity: 1, scope: 'repo', root: info.root, agent, ...(onWait ? { onWait } : {}) });
}


/** Read only a digest and local agent identity; damaged bindings need an explicit takeover. */
function readBinding(file, takeover) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version !== 1 || typeof value.agent !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || !Number.isFinite(Date.parse(value.at))) throw new Error('invalid binding');
    return value;
  } catch {
    if (takeover) return null;
    throw new Refused('CHECKOUT_SESSION', 'this checkout’s local session binding is unreadable; run pullboard takeover from the same agent’s new session');
  }
}

/** Read this seat's authenticated local digest for eligibility observations, without binding or taking over. */
export function localSeatSessionDigest(info, agent) {
  const current = readBinding(checkoutSessionFile(info), false);
  return current?.agent === agent ? current.digest : null;
}

/** Check whether this already-bound checkout belongs to the invoking agent session. */
export function localSessionMatches(info, { agent, digest }) {
  const current = readBinding(checkoutSessionFile(info), false);
  return current !== null && current.agent === agent && current.digest === digest;
}

/**
 * Serialize local binding changes, record an explicit takeover, and replace complete JSON atomically. A write in a
 * checkout already bound to its own session holds no lease across the command: it leaves a writer record instead, so
 * same-session writes run side by side while a takeover still waits for every one of them [B3,B7,C7].
 */
export async function bindLocalSession(info, { agent, digest, takeover = false, recordTakeover, keepLease = false, waitLimitMs = 0 }) {
  const file = checkoutSessionFile(info);
  /** Atomically replace the complete local record, keeping identifiers out of durable state. */
  function persist(identity) {
    const pending = file + '.' + process.pid + '.tmp';
    writeFileSync(pending, JSON.stringify({ version: 1, agent: identity, digest, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    renameSync(pending, file);
  }
  if (keepLease && !takeover) {
    const record = enterBoundSession(info, file, agent, digest);
    if (record) return writerTurn(record, persist);
  }
  const name = 'checkout-session:' + createHash('sha256').update(info.gitDir).digest('hex');
  const lease = await checkoutLease(info, name, agent, waitLimitMs);
  let retained = false;
  let intent = false;
  try {
    // A takeover keeps the lease for as long as its intent exists, so an intent found by another lease holder is stale.
    if (!takeover && !lease.inherited) removeTakeoverIntent(info);
    const previous = readBinding(file, takeover);
    if (!takeover && previous && previous.digest !== digest) {
      throw new Refused('NOT_YOUR_CHECKOUT', `this checkout belongs to ${previous.agent} in another agent session`,
        'create a separate checkout with git worktree add --detach .claude/worktrees/<new-name> HEAD, using an unused folder; then cd there and run pullboard join <lane> --model "<model name>". If you are the same agent in a new session, run pullboard takeover instead');
    }
    // A takeover by another session waits for that session's writes in flight; new ones queue on the lease behind it.
    if (takeover && !(previous?.digest === digest && previous?.agent === agent)) {
      writeFileSync(takeoverIntentFile(info), JSON.stringify({ version: 1, pid: process.pid, at: Date.now() }) + '\n', { mode: 0o600 });
      intent = true;
      await drainCheckoutWriters(info);
    }
    if (takeover) await recordTakeover();
    if (!previous || takeover || previous.agent !== agent) persist(agent);
    if (keepLease && !takeover && !lease.inherited) {
      // The binding is settled: the lease is let go now, and this command writes under its own record.
      const record = writeWriterRecord(info);
      return writerTurn(record, persist);
    }
    if (keepLease) {
      retained = true;
      // Processes this command starts while it holds the checkout inherit the lease; the previous value returns with it.
      const env = environmentAdapter();
      const previous = env.get(CHECKOUT_SESSION_TOKEN_ENV);
      env.set(CHECKOUT_SESSION_TOKEN_ENV, lease.token);
      const release = () => {
        if (env.get(CHECKOUT_SESSION_TOKEN_ENV) === lease.token) {
          if (previous === undefined) env.delete(CHECKOUT_SESSION_TOKEN_ENV);
          else env.set(CHECKOUT_SESSION_TOKEN_ENV, previous);
        }
        if (intent) removeTakeoverIntent(info);
        lease.release();
      };
      return { release, updateAgent: persist };
    }
  } finally {
    if (!retained) {
      if (intent) removeTakeoverIntent(info);
      lease.release();
    }
  }
}

/**
 * The ended session an item folder is bound to, which a claiming session may take over, or null when there is nothing
 * to hand over. A folder whose session is still live is refused, naming the seat that holds it, and is never adopted
 * (#3679). A session is live while a seat with live presence keeps its own checkout bound to it; a seat checkout taken
 * over by a new session, or a seat silent past the live window, means the session that bound the folder has ended.
 *
 * @param {{ root: string, gitDir: string, commonDir: string }} info the item folder about to be adopted
 * @param {{ agent: string, digest: string, liveSeats: () => any[], idle?: () => boolean }} claimer the claiming seat, its session digest, the
 *   board's seats with live presence, read only when the folder is bound to another session, and whether the folder is clean and unused
 * @returns {{ agent: string, digest: string } | null} the binding to replace
 */
export function endedFolderSession(info, { agent, digest, liveSeats, idle = () => false }) {
  const binding = readBinding(checkoutSessionFile(info), true);
  if (!binding || (binding.digest === digest && binding.agent === agent)) return null;
  if (binding.digest !== digest) {
    const others = liveSeats().filter(seat => seat.agent_id !== agent);
    const { digests } = seatLinks(info, others);
    const holder = others.find(seat => digests.get(seat.agent_id) === binding.digest);
    // A live seat's folder that is clean, unused and unclaimed may be adopted; any other live folder is retained (#3720).
    if (holder && !idle()) {
      throw new Refused('ITEM_FOLDER_SESSION_LIVE', `item folder ${info.root} belongs to ${holder.agent_id}'s live session${holder.heartbeatAt ? ` (last seen ${holder.heartbeatAt})` : ''}; it is retained, not adopted`,
        `ask ${holder.agent_id} to finish with the folder or end its session, then claim the item again; build another item meanwhile`);
    }
  }
  return binding;
}

/**
 * Hand a checkout from an ended session to the claiming one, so its commit hooks act for the claimer (#3679).
 * Why: an item folder adopted at claim kept the ended seat's binding, and every commit in it was refused
 * NOT_YOUR_CHECKOUT. The binding is replaced only while it is still the one the caller judged ended (`from`), under the
 * checkout's lease, so a session that bound the folder meanwhile is never overwritten.
 *
 * @param {{ root: string, gitDir: string }} info the adopted checkout
 * @param {{ agent: string, digest: string, from: { agent: string, digest: string } }} adoption
 */
export async function adoptLocalSession(info, { agent, digest, from }) {
  const file = checkoutSessionFile(info);
  const lease = await checkoutLease(info, 'checkout-session:' + createHash('sha256').update(info.gitDir).digest('hex'), agent, 0);
  try {
    const current = readBinding(file, true);
    if (current?.digest !== from.digest || current?.agent !== from.agent) {
      throw new Refused('NOT_YOUR_CHECKOUT', `this checkout belongs to ${current?.agent ?? 'another agent'} in another agent session`,
        'claim the item again; the claim adopts the folder only once its previous session has ended');
    }
    const pending = file + '.' + process.pid + '.tmp';
    writeFileSync(pending, JSON.stringify({ version: 1, agent, digest, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    renameSync(pending, file);
  } finally { lease.release(); }
}

/** Find this session's registered seats from local Git bindings, never from shared board credentials. */
export function localSessionSeats(info, { agents, digest }) {
  const directory = join(info.commonDir, 'worktrees');
  if (!existsSync(directory)) return [];
  const registered = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const seats = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const gitDir = join(directory, entry.name);
    try {
      const binding = readBinding(join(gitDir, 'pullboard-checkout-session.json'), false);
      if (!binding || binding.digest !== digest) continue;
      const agent = registered.get(binding.agent);
      if (!agent || agent.agent_lane === 'coordinator') continue;
      const gitFile = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim();
      const root = realpathSync(dirname(gitFile));
      if (root !== agent.agent_path) continue;
      const pointer = readFileSync(gitFile, 'utf8').trim();
      if (!pointer.startsWith('gitdir: ') || resolve(root, pointer.slice(8)) !== resolve(gitDir)) continue;
      seats.push(agent);
    } catch (error) {
      // Gone or damaged peers are not authority to borrow a checkout. The invoking seat was
      // already checked by bindCheckoutSession, so its own damaged binding still refuses.
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof Refused)) throw error;
    }
  }
  return seats;
}

/** Keep a helper seat's parent record in its own Git directory, beside its session binding. */
export function parentSessionFile(info) {
  return join(info.gitDir, 'pullboard-parent-session.json');
}

/**
 * Record which agent opened a helper seat, from inside that agent's session [N2,B13]. The record is local to the machine
 * and holds only the parent's id and session digest, so it can never lend the parent's claims to the helper: the helper
 * still claims and submits as itself.
 */
export function recordParentSession(info, { parent, digest }) {
  const file = parentSessionFile(info);
  const pending = file + '.' + process.pid + '.tmp';
  writeFileSync(pending, JSON.stringify({ version: 1, parent, digest, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  renameSync(pending, file);
}

/** Record the parent of a just-made helper seat; a note that cannot be written never undoes the seat. */
export function noteHelperParent(info, link) {
  try { recordParentSession(info, link); } catch { /* The seat still works without its parent note. */ }
}

/** Walk the board's linked checkouts and hand each registered agent's Git directory to visit. */
function eachSeatGitDir(info, agents, visit) {
  const directory = join(info.commonDir, 'worktrees');
  if (!existsSync(directory)) return;
  const registered = new Map(agents.filter((agent) => agent.agent_lane !== 'coordinator').map((agent) => [agent.agent_path, agent]));
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const gitDir = join(directory, entry.name);
    try {
      const agent = registered.get(realpathSync(dirname(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim())));
      if (agent) visit(agent, gitDir);
    } catch { /* A gone or half-removed checkout is not a seat to list. */ }
  }
}

/**
 * Map each helper agent's id to the id of the agent that opened it, and each agent's id to its session digest. Unreadable
 * or damaged records are skipped: they only mean the board lists that agent without a parent.
 */
export function seatLinks(info, agents) {
  const parents = new Map();
  const digests = new Map();
  eachSeatGitDir(info, agents, (agent, gitDir) => {
    for (const [name, field, into] of [['pullboard-parent-session.json', 'parent', parents], ['pullboard-checkout-session.json', 'digest', digests]]) {
      try {
        const value = JSON.parse(readFileSync(join(gitDir, name), 'utf8'));
        if (value.version === 1 && typeof value[field] === 'string') into.set(agent.agent_id, value[field]);
      } catch { /* No record, or a damaged one: no link. */ }
    }
  });
  return { parents, digests };
}
