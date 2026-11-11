/** The runner-channel registry: connect(runner) reuses one live channel per runner from its adapter [C7]. */
import { Refused } from '../../../kernel/light.js';
import { channelKey } from '../logic/frames.js';
import { probeStanding } from '../logic/quarantine.js';
import { sshAdapter } from './ssh.js';

// Budget: a runner's health lease lasts two minutes, the same lapse that frees a job's lease (design §3).
const LEASE_MS = 120_000;

/**
 * Build a transport over a runner adapter. An adapter has open(runner), which returns a channel with startShard,
 * fetchResult, resetShard, alive, onLost and close, and probe(runner). The SSH push adapter is the default; a pull
 * adapter for hosted sandboxes plugs in the same way (design §10). Passing open or launch builds the SSH adapter
 * over those process seams.
 *
 * Why: every gate on a runner shares one channel, so the Mac holds one connection per runner instead of one
 * controller and ssh session per gate; the probe never rides the channel, so a busy or wedged channel cannot fake
 * a healthy runner and a failed probe never ends the gates still using it. Runner health is a lease any adapter
 * renews with heartbeat(runner); the SSH adapter renews it by a good probe. A lost channel hands its unfinished
 * shards to requeue and keeps the runner; only two failed probes at least 30 s apart quarantine it.
 *
 * @param {{ adapter?: object, requeue?: (lost: { runner: object, reason: string, unfinished: object[] }) => void,
 *   now?: () => number, leaseMs?: number, open?: Function, launch?: Function, timeoutMs?: number,
 *   probeTimeoutMs?: number }} [options]
 * @returns {{ connect: Function, probe: Function, heartbeat: Function, standing: Function, channels: Function, close: Function }}
 */
export function createTransport({ adapter, requeue = () => {}, now = Date.now, leaseMs = LEASE_MS, ...processes } = {}) {
  const runners = adapter ?? sshAdapter({ now, ...processes });
  const live = new Map();
  const health = new Map();

  /** The runner's health record: its lease and its probe answers since the last good one. */
  const healthOf = key => {
    if (!health.has(key)) health.set(key, { until: 0, probes: [] });
    return health.get(key);
  };

  /**
   * Hand the shards a lost channel started and never read back to the requeue port; the runner stays registered.
   * Why: a channel ends for reasons that say nothing about the runner, and its shards keep running there and
   * write their result files, so a requeued shard that is already done is read, never rerun (design §3).
   */
  const lostChannel = (runner, unfinished, refusal) => {
    try { requeue({ runner, reason: refusal.message, unfinished: [...unfinished.values()] }); }
    catch { /* A requeue port's own failure is the driver's to see; the channel is already gone. */ }
  };

  /** The runner's live channel, opened on first use and replaced only after it is lost. */
  function connect(runner) {
    const key = channelKey(runner);
    const existing = live.get(key);
    if (existing?.alive) return existing;
    const channel = runners.open(runner);
    const unfinished = new Map();
    const start = channel.startShard.bind(channel), read = channel.fetchResult.bind(channel);
    channel.startShard = async spec => {
      const started = await start(spec);
      if (started.state !== 'done') unfinished.set(`${spec.job}/${spec.shard}`, { job: spec.job, shard: spec.shard });
      return started;
    };
    channel.fetchResult = async spec => {
      const result = await read(spec);
      if (result.state === 'done' || result.state === 'import.invalid') unfinished.delete(`${spec.job}/${spec.shard}`);
      return result;
    };
    channel.unfinished = () => [...unfinished.values()];
    live.set(key, channel);
    channel.onLost(refusal => {
      if (live.get(key) === channel) live.delete(key);
      if (unfinished.size) lostChannel(runner, unfinished, refusal);
    });
    return channel;
  }

  /** Renew the runner's health lease, as any adapter's proof of life does. */
  function heartbeat(runner) {
    const record = healthOf(channelKey(runner));
    record.until = now() + leaseMs;
    record.probes = [];
  }

  /**
   * The adapter's own check that the runner answers, apart from its channel; for SSH it is how the lease renews.
   * A failure is recorded, and only two failures at least 30 s apart, with no answer between, quarantine.
   */
  async function probe(runner) {
    const key = channelKey(runner);
    const answer = await runners.probe(runner);
    if (answer.ok) heartbeat(runner);
    else healthOf(key).probes.push({ ok: false, at: answer.at ?? now() });
    return answer;
  }

  /** The runner's standing: its lease, whether it is live, its failed probes, and whether it is quarantined. */
  function standing(runner) {
    const record = healthOf(channelKey(runner));
    const { quarantined, failures, since } = probeStanding(record.probes);
    return { host: runner.host, until: record.until, live: now() < record.until, failures, since, quarantined };
  }

  return {
    connect,
    probe,
    heartbeat,
    standing,
    /** The live channels, one per runner host. */
    channels: () => [...live.values()],
    /** Close every live channel. */
    close() { for (const channel of [...live.values()]) channel.close(); live.clear(); },
  };
}

let shared = null;

/** The process-wide transport over SSH, made on first use so importing the cell starts nothing. */
export function sharedTransport() {
  shared ??= createTransport();
  return shared;
}

/** The runner's one reused channel on the process-wide transport. */
export function connect(runner) {
  return sharedTransport().connect(runner);
}

/** A probe of the runner on the process-wide transport, separate from its channel. */
export function probe(runner) {
  return sharedTransport().probe(runner);
}

/** The channel a shard call goes to: a channel itself, or the runner's channel on the process-wide transport. */
function channelFor(target) {
  if (typeof target?.startShard === 'function') return target;
  if (typeof target?.host === 'string') return connect(target);
  throw new Refused('TRANSPORT_CHANNEL', 'a shard call needs a channel from connect(runner) or a runner with a host');
}

/**
 * Start one shard on the runner: its job and command files are written there and the command runs detached, so its
 * result file is written whether or not this channel or its driver is still there; a shard already started or done
 * is left alone. Resolves { state: started | running | done, job, shard }.
 */
export function startShard(target, spec) {
  return channelFor(target).startShard(spec);
}

/**
 * Read a shard's result file, checked against the digest a done step recorded when given. Resolves
 * { state: absent | running }, { state: done, status, output, digest }, or { state: import.invalid, reason, digest,
 * reset: true } after the shard's files are removed so it reads as not started.
 */
export function fetchResult(target, spec) {
  return channelFor(target).fetchResult(spec);
}
