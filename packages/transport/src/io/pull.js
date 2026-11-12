/** The pull adapter: hosted runners behind NAT register a trusted key, take a job by lease and post signed results [C7]. */
import { createPublicKey } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { verify } from 'node:crypto';
import { Refused } from '../../../kernel/light.js';
import { isObjectId } from '../../../pin/light.js';
import { mintJobToken } from '../logic/token.js';
import { readJobToken } from '../logic/token.js';
import { parseResult } from '../logic/result.js';
import { shardIds } from '../logic/result.js';

// Budget: a token outlives one lease renewal so a runner that heartbeats keeps it; it never outlives a lost runner long.
const TOKEN_MS = 10 * 60_000;
// Budget: a signed register or take request is fresh for five minutes either way, for sandbox clock drift.
const SKEW_MS = 5 * 60_000;
// Budget: a pull runner is live while it has asked for work or heartbeated within one job lease (design §3).
const SEEN_MS = 120_000;
const RUNNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * The text a runner signs to register or take work: the action, its own id and the time it asked.
 *
 * @param {'register' | 'take'} action
 * @param {string} runner
 * @param {number} at
 * @returns {string}
 */
export function pullStatement(action, runner, at) {
  return `PB${action.toUpperCase()} 1 ${runner} ${at}`;
}

/** True when a base64url Ed25519 signature over text verifies under a base64url SPKI key. */
function signedBy(publicKey, text, signature) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(text), key, Buffer.from(String(signature ?? ''), 'base64url'));
  } catch { return false; }
}

/**
 * Build the pull adapter. The board side never connects to a runner: the runner opens every connection, registers a
 * key the board already trusts, takes a job by lease, fetches its tree bundle with a token scoped to that one job,
 * and posts a result file signed by its key. The board records each accepted result in one write.
 *
 * Ports keep transport inside its edges: `lease` takes and renews the runner's lease on a job (the jobs cell, wired
 * by the caller), `record` is the board's one write per result, `checkResult` is the receipt cell's signature check,
 * and `bundle(tree)` returns the path of the pin cell's tar for a tree.
 *
 * Why: a sandbox is trusted for nothing. Only a key on the board's trusted list admits a runner, a job token alone
 * never does, and a result counts only when the runner's registered key signed it (DJ27, DJ31, DJ35).
 *
 * @param {{ trusted: string[] | (() => string[]), lease: { take: (job: string, runner: string) => boolean,
 *   renew: (job: string, runner: string) => boolean }, record: (job: string, shard: string, payload: object) => void,
 *   checkResult: (posted: object) => { valid: boolean, reason?: string, keyId?: string }, bundle: (tree: string) => string,
 *   secret?: Buffer, now?: () => number, tokenMs?: number, skewMs?: number, seenMs?: number }} ports
 * @returns {object} The adapter: open and probe for the channel interface, and the runner-facing protocol calls.
 */
export function pullAdapter({ trusted, lease, record, checkResult, bundle, secret = randomBytes(32), now = Date.now, tokenMs = TOKEN_MS, skewMs = SKEW_MS, seenMs = SEEN_MS }) {
  const runners = new Map();
  const offers = new Map();
  const trustedKeys = () => new Set(typeof trusted === 'function' ? trusted() : trusted);

  /** The registered, still trusted runner a request or token names, or a refusal saying how to get admitted. */
  const admitted = id => {
    const runner = runners.get(id);
    if (!runner) throw new Refused('PULL_RUNNER_UNKNOWN', `runner ${id} is not registered; register its trusted key first`);
    if (!trustedKeys().has(runner.publicKey)) throw new Refused('PULL_RUNNER_UNTRUSTED', `runner ${id}'s key is no longer trusted on the board; ask the person to trust it again`);
    return runner;
  };

  /** Refuse a signed request that is stale or not signed by the key named. */
  const checkSigned = (action, id, at, signature, publicKey) => {
    if (!Number.isFinite(at) || Math.abs(now() - at) > skewMs) throw new Refused('PULL_REQUEST_STALE', `the ${action} request is not within ${skewMs} ms of the board clock; sign it again with the current time`);
    if (!signedBy(publicKey, pullStatement(action, id, at), signature)) throw new Refused('PULL_SIGNATURE', `the ${action} request is not signed by runner ${id}'s key; sign it with the key you registered`);
  };

  /** The job a token names, its runner admitted and the job still offered. */
  const tokenJob = token => {
    const scope = readJobToken(token, { secret, now: now() });
    const runner = admitted(scope.runner);
    const offer = offers.get(scope.job);
    if (!offer || offer.runner !== scope.runner) throw new Refused('PULL_JOB_MOVED', `job ${scope.job} is no longer held by runner ${scope.runner}; take a new job`);
    runner.seen = now();
    return { scope, runner, offer };
  };

  /** Offer one shard to pull runners; it is the channel's startShard. */
  const offerShard = ({ job, shard, command, tree }) => {
    shardIds({ job, shard });
    if (typeof command !== 'string' || !command) throw new Refused('TRANSPORT_SHARD_COMMAND', 'a shard needs the project command to run');
    if (!isObjectId(tree)) throw new Refused('PULL_TREE', `shard ${shard} of job ${job} needs the full tree id its runner fetches`);
    const offer = offers.get(job) ?? { job, tree, runner: null, shards: new Map() };
    if (offer.tree !== tree) throw new Refused('PULL_TREE', `job ${job} is offered on tree ${offer.tree}, not ${tree}`);
    offers.set(job, offer);
    const known = offer.shards.get(shard);
    if (known?.result) return { state: 'done', job, shard };
    if (known) return { state: 'running', job, shard };
    offer.shards.set(shard, { shard, command, result: null });
    return { state: 'started', job, shard };
  };

  /** Read a shard's posted result; it is the channel's fetchResult. */
  const readShard = ({ job, shard, digest }) => {
    const known = offers.get(job)?.shards.get(shard);
    if (!known) return { state: 'absent' };
    if (!known.result) return { state: 'running' };
    if (digest && digest !== known.result.digest) {
      const held = known.result.digest;
      known.result = null;
      return { state: 'import.invalid', reason: `digest ${held.slice(0, 12)} is not the recorded ${String(digest).slice(0, 12)}`, digest: held, reset: true };
    }
    return { state: 'done', status: known.result.status, output: known.result.output, digest: known.result.digest };
  };

  return {
    kind: 'pull',

    /** A channel onto the board's offer book; pull runners come to it, so it holds no connection of its own. */
    open(runner) {
      const listeners = new Set();
      let alive = true;
      return {
        runner,
        startShard: async spec => offerShard(spec),
        fetchResult: async spec => readShard(spec),
        resetShard: async ({ job, shard }) => { const known = offers.get(job)?.shards.get(shard); if (known) known.result = null; },
        get alive() { return alive; },
        onLost(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        close() {
          if (!alive) return;
          alive = false;
          const lost = new Refused('TRANSPORT_LOST', 'the pull channel was closed; connect again for a fresh channel');
          for (const listener of listeners) { try { listener(lost); } catch { /* One listener never stops the rest. */ } }
        },
      };
    },

    /** A pull runner answers when it asked for work or heartbeated within one lease; the board never dials it. */
    async probe(runner) {
      const at = now(), seen = runners.get(runner.host)?.seen ?? -Infinity;
      return at - seen <= seenMs ? { ok: true, host: runner.host, at, ms: 0 } : { ok: false, host: runner.host, at, ms: 0, reason: 'the runner has not asked for work within a lease' };
    },

    /**
     * Register a runner whose key the board already trusts, proved by a signature over its id and the time.
     * @param {{ runner: string, publicKey: string, at: number, signature: string }} request
     * @returns {{ runner: string }}
     */
    register({ runner, publicKey, at, signature }) {
      if (!RUNNER.test(String(runner ?? ''))) throw new Refused('PULL_RUNNER_ID', 'a runner id is a plain name: letters, digits, dot, dash or underscore');
      if (!trustedKeys().has(publicKey)) throw new Refused('PULL_RUNNER_UNTRUSTED', `runner ${runner}'s key is not trusted on this board; ask the person to trust it with the runner's public key`);
      checkSigned('register', runner, at, signature, publicKey);
      runners.set(runner, { runner, publicKey, seen: now() });
      return { runner };
    },

    /**
     * Take the first offered job with shards still owed, by lease, and hand back a token scoped to it alone.
     * @param {{ runner: string, at: number, signature: string }} request
     * @returns {{ job: string, tree: string, shards: { shard: string, command: string }[], token: string } | null}
     */
    take({ runner, at, signature }) {
      const holder = admitted(runner);
      checkSigned('take', runner, at, signature, holder.publicKey);
      holder.seen = now();
      for (const offer of offers.values()) {
        const owed = [...offer.shards.values()].filter(shard => !shard.result);
        if (!owed.length || !lease.take(offer.job, runner)) continue;
        offer.runner = runner;
        const token = mintJobToken({ job: offer.job, runner, tree: offer.tree, secret, now: now(), ttlMs: tokenMs });
        return { job: offer.job, tree: offer.tree, shards: owed.map(({ shard, command }) => ({ shard, command })), token };
      }
      return null;
    },

    /**
     * The bundle path for the token's job, only for the tree that job runs.
     * @param {string} token
     * @param {string} tree
     * @returns {string}
     */
    bundle(token, tree) {
      const { offer } = tokenJob(token);
      if (tree !== offer.tree) throw new Refused('PULL_TREE', `the token covers tree ${offer.tree} only; fetch that bundle`);
      return bundle(tree);
    },

    /** Renew the runner's lease on its token's job; false once the lease moved. */
    heartbeat(token) {
      const { scope } = tokenJob(token);
      return lease.renew(scope.job, scope.runner);
    },

    /**
     * Accept one signed result file for the token's job: the receipt cell checks the signature against the runner's
     * registered key, the file must parse, and the board records it in one write. Anything else records nothing.
     * @param {string} token
     * @param {string} shard
     * @param {Buffer} bytes
     * @param {string} [signature]
     * @returns {{ job: string, shard: string, status: number, digest: string }}
     */
    post(token, shard, bytes, signature) {
      const { scope, runner, offer } = tokenJob(token);
      const known = offer.shards.get(shard);
      if (!known) throw new Refused('PULL_SHARD_UNKNOWN', `job ${scope.job} has no shard ${shard}; post only the shards take returned`);
      const signed = checkResult({ bytes, signature, publicKey: runner.publicKey, job: scope.job, shard, tree: offer.tree });
      if (!signed.valid) throw new Refused('PULL_RESULT_INVALID', `the result for shard ${shard} of job ${scope.job} is import.invalid: ${signed.reason}; rerun it and sign with the registered key`);
      const parsed = parseResult(bytes);
      if (!parsed.valid) throw new Refused('PULL_RESULT_INVALID', `the result for shard ${shard} of job ${scope.job} is import.invalid: ${parsed.reason}; rerun it`);
      record(scope.job, shard, { state: 'done', status: parsed.status, digest: parsed.digest, tree: offer.tree, runner: scope.runner, key: signed.keyId, signature });
      known.result = { status: parsed.status, output: parsed.output, digest: parsed.digest };
      return { job: scope.job, shard, status: parsed.status, digest: parsed.digest };
    },
  };
}
