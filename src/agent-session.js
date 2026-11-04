/** A checkout belongs to one local agent session; bindings never enter the shared board [B3,B7]. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { AGENT_SESSION_IDS, AGENT_SHELL_MARKERS } from './person.js';
import {
  holdsLease,
  takeResource,
} from './resources.js';
import { Refused } from './refused.js';

/**
 * A command that holds this checkout passes its lease to the processes it starts, its Git hooks among them, so they act
 * under it instead of queueing behind their own parent (#906: init --yes committed, and its pre-commit hook waited on
 * init forever).
 */
export const CHECKOUT_SESSION_TOKEN_ENV = 'PULLBOARD_CHECKOUT_SESSION_TOKEN';
/** How long a hook waits for a checkout another command holds before it names the holder and stops (#906). */
export const HOOK_CHECKOUT_WAIT_MS = 30_000;

/**
 * The caller's agent-session identity and checkout lease. A process that acts as its own seat, or as the view, must
 * never inherit them: a scripted seat would be recorded under the caller's session and refused as self-verification
 * (#952), and a view-spawned scan would be judged against a checkout that a later session of the same agent took over.
 */
export const CALLER_SESSION_NAMES = Object.freeze([...AGENT_SHELL_MARKERS, ...AGENT_SESSION_IDS, CHECKOUT_SESSION_TOKEN_ENV]);

/** Copy an environment without the caller's agent session, so the child carries no session digest to bind with. */
export function withoutCallerSession(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !CALLER_SESSION_NAMES.includes(name)));
}

/** Take the checkout's lease, act under the one a parent command passed down, or stop after waitLimitMs naming the holder. */
async function checkoutLease(info, name, agent, waitLimitMs) {
  const inherited = process.env[CHECKOUT_SESSION_TOKEN_ENV];
  if (inherited && holdsLease({ name, scope: 'repo', root: info.root, token: inherited })) return { token: inherited, release() {} };
  const startedAt = Date.now();
  const onWait = waitLimitMs ? (state) => {
    if (Date.now() - startedAt < waitLimitMs) return;
    const holder = state?.holders?.[0];
    throw new Refused('CHECKOUT_BUSY', `this checkout is in use by ${holder ? `${holder.agent} (since ${holder.since})` : 'another Pullboard command'}, `
      + `and this hook waited ${Math.round(waitLimitMs / 1000)} s for it; let that command finish, or stop it if it is stuck, then commit again`);
  } : undefined;
  return takeResource({ name, capacity: 1, scope: 'repo', root: info.root, agent, ...(onWait ? { onWait } : {}) });
}

/** Keep each worktree's binding in its own Git directory rather than the shared common directory. */
export function checkoutSessionFile(info) {
  return join(info.gitDir, 'pullboard-checkout-session.json');
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

/** Check whether this already-bound checkout belongs to the invoking agent session. */
export function localSessionMatches(info, { agent, digest }) {
  const current = readBinding(checkoutSessionFile(info), false);
  return current !== null && current.agent === agent && current.digest === digest;
}

/** Serialize local binding changes, record an explicit takeover, and replace complete JSON atomically. */
export async function bindLocalSession(info, { agent, digest, takeover = false, recordTakeover, keepLease = false, waitLimitMs = 0 }) {
  const file = checkoutSessionFile(info);
  const name = 'checkout-session:' + createHash('sha256').update(info.gitDir).digest('hex');
  const lease = await checkoutLease(info, name, agent, waitLimitMs);
  let retained = false;
  /** Atomically replace the complete local record, keeping identifiers out of durable state. */
  function persist(identity) {
    const pending = file + '.' + process.pid + '.tmp';
    writeFileSync(pending, JSON.stringify({ version: 1, agent: identity, digest, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    renameSync(pending, file);
  }
  try {
    const previous = readBinding(file, takeover);
    if (!takeover && previous && previous.digest !== digest) {
      throw new Refused('NOT_YOUR_CHECKOUT', `this checkout belongs to ${previous.agent} in another agent session`,
        'create a separate checkout with git worktree add --detach .claude/worktrees/<new-name> HEAD, using an unused folder; then cd there and run pullboard join <lane> --model "<model name>". If you are the same agent in a new session, run pullboard takeover instead');
    }
    if (takeover) await recordTakeover();
    if (!previous || takeover || previous.agent !== agent) persist(agent);
    if (keepLease) {
      retained = true;
      // Processes this command starts while it holds the checkout inherit the lease; the previous value returns with it.
      const previous = process.env[CHECKOUT_SESSION_TOKEN_ENV];
      process.env[CHECKOUT_SESSION_TOKEN_ENV] = lease.token;
      const release = () => {
        if (process.env[CHECKOUT_SESSION_TOKEN_ENV] === lease.token) {
          if (previous === undefined) delete process.env[CHECKOUT_SESSION_TOKEN_ENV];
          else process.env[CHECKOUT_SESSION_TOKEN_ENV] = previous;
        }
        lease.release();
      };
      return { release, updateAgent: persist };
    }
  } finally { if (!retained) lease.release(); }
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
