/** Probe a runner's pinned worker health and hand the canonical runner operations to the gate [C7]. */
import { validateRunner } from './gate-policy-load.js';
import { runOnRunner } from './runner-dispatch.js';
import { runOnRunnerAsync } from './runner-dispatch.js';
import { localRunnerDescriptor } from './runner-load.js';
import { sampleRunnerLoad } from './runner-load.js';
import { carriedRunnerTrunk } from './runner-policy.js';
import { remoteWorkerCommand } from './runner-remote-tooling.js';
import { shellWord } from './runner-remote-tooling.js';
import { sshEnvironment } from './runner-remote-tooling.js';
import { trustedTooling } from './runner-remote-tooling.js';
import { probeRunnerTransport } from './runner-transport.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Ask the pinned real worker to prove readiness plus the exact failed job's completed cleanup. */
export async function probeRunnerHealth(runner, previous) {
  runner = validateRunner(runner);
  const { worker, tooling, runtime } = trustedTooling();
  const nonce = randomUUID();
  const request = { nonce, previous, ...(runner.root ? { root: runner.root } : {}) };
  const remote = remoteWorkerCommand(runner, worker, tooling, runtime,
    ' --health ' + shellWord(Buffer.from(JSON.stringify(request)).toString('base64')));
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=2', '--', runner.host, remote];
  const child = spawn('ssh', args, { env: sshEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', timedOut = false, error = null, kill;
  /** Bound the health connection and fully observe its close before releasing recovery ownership. */
  const stop = () => { child.kill('SIGTERM'); kill ??= setTimeout(() => child.kill('SIGKILL'), 500); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 5_000);
  child.stdout.on('data', bytes => { output = (output + bytes).slice(0, 4097); if (output.length > 4096) stop(); });
  child.stderr.resume();
  child.once('error', failure => { error = failure.code ?? failure.name; });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(kill);
  let reply;
  try { reply = JSON.parse(output); } catch { /* Unknown or foreign replies do not attest health. */ }
  const workerReady = !error && !timedOut && result.code === 0 && !result.signal
    && reply?.version === 1 && reply.nonce === nonce && reply.worker === true;
  return { healthy: Boolean(workerReady && reply.cleanup === true), step: !workerReady ? 'worker readiness' : 'cleanup',
    reason: workerReady ? reply.reason : 'pinned worker did not answer health request', ...result, timedOut, error };
}

/** Supply canonical late-bound runner operations to an actual higher gate composition root. */
export function runnerExecutionServices(front = { runOnRunner, runOnRunnerAsync, probeRunnerHealth }) {
  return Object.freeze({ runOnRunner: front.runOnRunner, runOnRunnerAsync: front.runOnRunnerAsync, sampleRunnerLoad, localRunnerDescriptor,
    carriedRunnerTrunk, probeRunnerTransport, probeRunnerHealth: front.probeRunnerHealth });
}
