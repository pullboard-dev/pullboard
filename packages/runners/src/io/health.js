/** Probe a runner's pinned worker health and hand the canonical runner operations to the gate [C7]. */
import { validateRunner } from '../../../config/index.js';
import { runOnRunner } from './dispatch.js';
import { runOnRunnerAsync } from './dispatch.js';
import { ownedTransportCompletion } from './dispatch.js';
import { localRunnerDescriptor } from './load.js';
import { sampleRunnerLoad } from './load.js';
import { carriedRunnerTrunk } from './policy.js';
import { remoteWorkerLaunch } from './tooling/remote.js';
import { shellWord } from './tooling/remote.js';
import { spawnSsh } from '../../../transport/index.js';
import { sshEnvironment } from './tooling/remote.js';
import { trustedTooling } from './tooling/remote.js';
import { probeRunnerTransport } from './probe.js';
import { recoveryIdentity } from '../../../resources/index.js';
import { effectiveRunners } from './slots.js';
import { refreshRunnerMeasurements } from './slots.js';
import { transportText } from './result.js';
import { stopLeakedRunnerJobs } from './leaked.js';
import { randomUUID } from 'node:crypto';

/** How long a health probe may take: an SSH round trip plus, on first contact after a landing, one runtime install. */
export const HEALTH_PROBE_MS = 20_000;

/** Write the tooling capsule as the probe's whole stdin; a closed pipe is the transport's failure to report, not a throw. */
function sendCapsule(child, capsule) {
  child.stdin.on('error', () => {});
  child.stdin.end(capsule);
}

/** Ask only the pinned worker whether this exact startup owner still exists; no reply certifies cleanup. */
export async function probeRunnerJob(runner, identity, { signal } = {}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(identity?.job ?? '') || !recoveryIdentity(identity?.recovery)
    || identity.job !== identity.recovery.request) return { state: 'unknown' };
  runner = validateRunner(runner);
  const { worker, tooling, runtime } = trustedTooling(), nonce = randomUUID();
  const request = { nonce, job: identity.job, recovery: identity.recovery, ...(runner.root ? { root: runner.root } : {}) };
  const { command: remote, input: capsule } = remoteWorkerLaunch(runner, worker, tooling, runtime,
    ' --health ' + shellWord(Buffer.from(JSON.stringify(request)).toString('base64')));
  const child = spawnSsh(['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=2', '--', runner.host, remote], { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  sendCapsule(child, capsule);
  const transport = ownedTransportCompletion(child, { termMs: 500, drainMs: 500 });
  let output = '', invalid = false;
  const abort = () => { invalid = true; transport.stop(); };
  // Budget: four seconds for the pinned observation plus one second to settle owned transport and inherited pipes.
  const timer = setTimeout(abort, 4_000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 4096) { output = ''; abort(); } });
  child.stderr.resume();
  child.once('error', abort);
  try {
    const result = await transport.wait();
    let reply;
    try { reply = JSON.parse(output); } catch { return { state: 'unknown' }; }
    const exact = !invalid && !result.forced && result.status === 0 && !result.signal && reply?.version === 1
      && reply.worker === true && reply.nonce === nonce && reply.job === identity.job && reply.cleanup === false
      && recoveryIdentity(reply.recovery) && ['request', 'nonce', 'tooling', 'launchFence'].every(key => reply.recovery[key] === identity.recovery[key]);
    if (!exact || !['running', 'gone', 'unknown'].includes(reply.state)) return { state: 'unknown' };
    if (reply.state !== 'unknown' && (!Number.isSafeInteger(reply.owner?.pid) || reply.owner.pid < 1
      || typeof reply.owner.started !== 'string' || !Number.isFinite(Date.parse(reply.owner.started)))) return { state: 'unknown' };
    return { state: reply.state, job: identity.job, recovery: identity.recovery, owner: reply.owner };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); transport.dispose(); }
}

/** Ask the pinned worker for exact cleanup or an explicitly requested idle and writable proof. */
export async function probeRunnerHealth(runner, previous, { idle = false, restart = false, stopLeaked = false, liveJobs = [] } = {}) {
  runner = validateRunner(runner);
  if (stopLeaked) return stopLeakedRunnerJobs(runner, { liveJobs });
  const { worker, tooling, runtime } = trustedTooling();
  const nonce = randomUUID();
  // An idle proof names the controller's live jobs on this host, so they cost only their own slots (runner-orphan-holders.js).
  const request = { nonce, ...(idle || restart ? { idle: true, ...(previous === undefined ? {} : { previous }), ...(idle && liveJobs.length ? { liveJobs } : {}) } : { previous }), ...(runner.root ? { root: runner.root } : {}) };
  const { command: remote, input: capsule } = remoteWorkerLaunch(runner, worker, tooling, runtime,
    (restart ? ' --restart ' : ' --health ') + shellWord(Buffer.from(JSON.stringify(request)).toString('base64')));
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=2', '--', runner.host, remote];
  const child = spawnSsh(args, { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  sendCapsule(child, capsule);
  let output = '', stderr = '', stderrBytes = 0, timedOut = false, error = null, failure = null, kill;
  /** Bound the health connection and fully observe its close before releasing recovery ownership. */
  const stop = () => { child.kill('SIGTERM'); kill ??= setTimeout(() => child.kill('SIGKILL'), 500); };
  // A first contact after a landing installs the new runtime before it answers; 5 s left the largest runner out for a day [C7].
  const timer = setTimeout(() => { timedOut = true; stop(); }, HEALTH_PROBE_MS);
  child.stdout.on('data', bytes => { output = (output + bytes).slice(0, 4097); if (output.length > 4096) stop(); });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; stderr = (stderr + bytes).slice(-8192); });
  child.once('error', problem => { error = problem.code ?? problem.name; failure = { code: error, message: transportText(problem.message) }; });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(kill);
  let reply;
  try { reply = JSON.parse(output); } catch { /* Unknown or foreign replies do not attest health. */ }
  const workerReady = !error && !timedOut && result.code === 0 && !result.signal
    && reply?.version === 1 && reply.nonce === nonce && reply.worker === true;
  const reason = workerReady ? reply.reason : 'pinned worker did not answer health request';
  if (restart && !(workerReady && reply.idle === true && reply.writable === true))
    process.stderr.write('pullboard runner-restart refused runner=' + JSON.stringify(runner.host)
      + ' root=' + JSON.stringify(runner.root ?? '(default runner root)') + ' reason=' + JSON.stringify(transportText(reason)) + '\n');
  return { healthy: Boolean(workerReady && (idle || restart ? reply.idle === true && reply.writable === true : reply.cleanup === true)),
    ...(!workerReady ? { diagnostic: { host: runner.host, at: new Date().toISOString(), workerReady: false,
      exitCode: result.code, signal: result.signal, timedOut, error: failure,
      stderr: transportText(stderr), stderrBytes, responseBytes: Buffer.byteLength(output) } } : {}),
    ...(workerReady && reply.idleRequired === true ? { idleRequired: true } : {}),
    ...(idle || restart ? { idle: workerReady && reply.idle === true, writable: workerReady && reply.writable === true } : {}),
    ...(restart && workerReady ? { restarted: Array.isArray(reply.restarted) ? reply.restarted.filter(Number.isSafeInteger).slice(0, 32) : [] } : {}),
    ...(restart && workerReady ? { signalAttempts: Array.isArray(reply.signalAttempts) && reply.signalAttempts.every(row =>
      Number.isSafeInteger(row?.pid) && row.pid > 0 && ['SIGTERM', 'SIGKILL'].includes(row.signal))
      ? reply.signalAttempts.map(row => ({ pid: row.pid, signal: row.signal })) : [] } : {}),
    step: !workerReady ? 'worker readiness' : idle || restart ? 'idle proof' : 'cleanup',
    reason, ...result, timedOut, error };
}

/** Supply canonical late-bound runner operations to an actual higher gate composition root. */
export function runnerExecutionServices(front = { runOnRunner, runOnRunnerAsync, probeRunnerHealth }) {
  return Object.freeze({ runOnRunner: front.runOnRunner, runOnRunnerAsync: front.runOnRunnerAsync, sampleRunnerLoad, localRunnerDescriptor,
    carriedRunnerTrunk, probeRunnerTransport, probeRunnerHealth: front.probeRunnerHealth, effectiveRunners, refreshRunnerMeasurements });
}
