/** A checkout belongs to one local agent session; bindings never enter the shared board [B3,B7]. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeResource } from './resources.js';
import { Refused } from './refused.js';

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

/** Serialize local binding changes, record an explicit takeover, and replace complete JSON atomically. */
export async function bindLocalSession(info, { agent, digest, takeover = false, recordTakeover, keepLease = false }) {
  const file = checkoutSessionFile(info);
  const name = 'checkout-session:' + createHash('sha256').update(info.gitDir).digest('hex');
  const lease = await takeResource({ name, capacity: 1, scope: 'repo', root: info.root, agent });
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
      throw new Refused('NOT_YOUR_CHECKOUT', `this checkout belongs to ${previous.agent} in another agent session; run pullboard worktree <lane> and work there, or, if you are the same agent in a new session, run pullboard takeover`);
    }
    if (takeover) await recordTakeover();
    if (!previous || takeover || previous.agent !== agent) persist(agent);
    if (keepLease) {
      retained = true;
      return { release: lease.release, updateAgent: persist };
    }
  } finally { if (!retained) lease.release(); }
}
