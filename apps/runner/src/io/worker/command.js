/** Run the requested command or trusted private check with byte-exact output accounting [C7]. */
import { beginCleanup } from './cleanup.js';
import { beginPhaseCleanup } from './cleanup.js';
import { clearPhaseCleanup } from './cleanup.js';
import { git } from './git.js';
import { drainOwned } from './process.js';
import { spawnOwned } from './process.js';
import { gateStages } from '../../../../../packages/gate/light.js';
import { stagedScript } from '../../../../../packages/gate/light.js';
import { readPipes } from '../../../../../packages/gate/light.js';
import { fileDenialWatcher } from '../../../../../packages/sandbox/light.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { dirname } from 'node:path';
import { join } from 'node:path';

const fs = fileSystemAdapter();

/** Wait until all bytes written to stdout have passed through the stream before publishing a receipt. */
export async function flushStdout() {
  if (process.stdout.writableNeedDrain) await once(process.stdout, 'drain');
  await new Promise((resolveFlush, rejectFlush) => process.stdout.write('', error => error ? rejectFlush(error) : resolveFlush()));
}

/** Emit command output through one stream while computing the receipt's byte-exact digest. */
export function outputSink(S) {
  const hash = createHash('sha256');
  const wallStart = Date.now();
  let pipeFailed = false;
  let length = 0;
  const write = part => {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    hash.update(bytes);
    length += bytes.length;
    // A lost transport never drains. Discard instead of waiting: a paused command pipe never closes, its group never
    // finishes draining, and with only unref'd timers left the worker exits before releasing its lease (#888).
    if (S.transportLost || process.stdout.destroyed) return Promise.resolve();
    if (!process.stdout.write(bytes)) return Promise.race([once(process.stdout, 'drain'), S.transportGone]);
    return Promise.resolve();
  };
  return { hash, write, get length() { return length; }, get pipeFailed() { return pipeFailed; }, set pipeFailed(value) { pipeFailed = value; }, wallStart };
}

/**
 * Run the exact requested command in its isolated checkout, retaining raw output and real test exit status.
 * A failed command also carries any file denial's evidence, classified here against this checkout (#706).
 */
export async function runCommand(S, spec, root, env, sink, tracker, { continuation = false } = {}) {
  const commandCleanup = continuation ? () => beginPhaseCleanup(S) : () => beginCleanup(S);
  const split = spec.stageMarker ? gateStages(spec.command) : null;
  const pipes = split?.some(stage => stage.pipeline.length > 1) ? fs.mkdtemp(join(dirname(root), 'gate-pipes-')) : null;
  const command = split ? `(\n${stagedScript(split, spec.stageMarker, pipes)}\n) 2>&1` : spec.command;
  let shell = '/bin/sh';
  let args = ['-c', command];
  if (spec.pipefail) {
    const probe = spawnSync(shell, ['-c', 'set -o pipefail'], { env, stdio: 'ignore' });
    if (probe.status === 0) args = ['-c', `set -o pipefail\n${command}`];
    else if (fs.exists('/bin/bash')) { shell = '/bin/bash'; args = ['-o', 'pipefail', '-c', command]; }
    else if (/(?:^|[^|])\|(?:[^|]|$)/u.test(spec.command)) throw new Error('runner shell cannot enforce pipefail');
  }
  const owned = spawnOwned(S, shell, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = owned.child;
  // A surviving descendant can keep stdio open after the command leader exits.
  // Start the budget at exit rather than waiting for those pipes to close.
  child.once('exit', commandCleanup);
  let outputError = null;
  let writes = Promise.resolve();
  const closed = owned.closed;
  const onDrop = () => { sink.pipeFailed = true; S.transportDrop(); };
  const denials = fileDenialWatcher(root);
  const forward = stream => stream.on('data', part => {
    stream.pause();
    if (!outputError) writes = writes.then(() => { denials.push(part); return sink.write(part); }).then(() => stream.resume()).catch(error => { outputError = error; onDrop(); });
  });
  forward(child.stdout); forward(child.stderr);
  let timedOut = false;
  let timeoutDrain;
  const timeout = spec.timeoutMs ? setTimeout(() => {
    timedOut = true; beginCleanup(S);
    timeoutDrain = tracker.stopDescendants().then(() => drainOwned(S, owned, true));
    timeoutDrain.catch(() => {});
  }, spec.timeoutMs) : null;
  const result = await closed;
  clearTimeout(timeout);
  if (timeoutDrain) await timeoutDrain;
  commandCleanup();
  S.cleanupStage = 'command output';
  await writes;
  S.cleanupStage = 'command descendants';
  await tracker.stopDescendants();
  S.cleanupStage = 'command process group';
  await drainOwned(S, owned);
  if (S.transportDrain) await S.transportDrain;
  if (outputError) throw outputError;
  if (sink.pipeFailed) return { code: 1, signal: result.signal ?? 'SIGHUP' };
  if (result.error) throw result.error;
  const code = Number.isInteger(result.code) ? result.code : 1;
  if (continuation && code === 0 && !result.signal && !timedOut && !outputError && !sink.pipeFailed) {
    await tracker.verifyAfterGroups();
    if (!clearPhaseCleanup(S)) throw new Error('intermediate install cleanup could not be verified within its deadline');
  }
  const denial = code === 0 && !result.signal ? null : denials.end();
  let pipeStatuses = pipes ? readPipes(split, pipes, 8 * 1024 ** 2) : null;
  // Accounting beyond this bound fails closed; it never turns an unaccounted failure green.
  if (Buffer.byteLength(JSON.stringify(pipeStatuses)) > 8 * 1024 ** 2) pipeStatuses = null;
  return { code: timedOut ? 1 : code, signal: result.signal ?? null, ...(timedOut ? { timedOut: true } : {}), ...(spec.stageMarker ? { pipeStatuses } : {}), ...(denial ? { denial } : {}) };
}

/** Apply only the frozen declarative guard inside this exact private checkout, never a controller callback. */
async function applyPrivateGuard(S, root, guard, env) {
  if (!guard) return null;
  try {
    const path = join(root, guard.patch ?? guard.path);
    const canonical = fs.realpath(path);
    if (!canonical.startsWith(fs.realpath(root) + '/')) throw new Error('guard escapes its private checkout');
    if (guard.patch) await git(S, root, ['apply', '-R', '--whitespace=nowarn', '--', guard.patch], env);
    else {
      const lines = fs.readFile(path, 'utf8').split('\n');
      if (guard.to > lines.length) throw new Error('guard lines are absent');
      lines.splice(guard.from - 1, guard.to - guard.from + 1);
      fs.writeFile(path, lines.join('\n'));
    }
    return { applied: true, problem: '' };
  } catch { return { applied: false, problem: `guard ${guard.text} cannot be reverted inside the submitted checkout`.slice(0, 4096) }; }
}

/** Execute the trusted phases against one absolute policy deadline, with worker-owned byte boundaries. */
export async function runPrivateCheck(S, spec, root, env, sink, tracker) {
  const mode = spec.trustedMode;
  const phases = { install: null, check: null };
  const guard = await applyPrivateGuard(S, root, mode.guard, env);
  let problem = guard && !guard.applied ? { stage: 'guard', message: guard.problem } : null;
  const deadline = Date.now() + mode.timeoutMs;
  let denial = null;
  /** Capture phase framing outside command output, so candidate text cannot forge a phase receipt. */
  const phase = async (name, command, continuation) => {
    const offset = sink.length;
    const hash = createHash('sha256');
    const phaseSink = Object.create(sink);
    phaseSink.write = part => { const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); hash.update(bytes); return sink.write(bytes); };
    const remaining = deadline - Date.now();
    if (remaining <= 0) { problem = { stage: name, message: `${name} timed out` }; return null; }
    let result;
    try { result = await runCommand(S, { ...spec, command, stageMarker: undefined, timeoutMs: remaining, pipefail: false }, root, env, phaseSink, tracker, { continuation }); }
    catch {
      problem = { stage: name, message: `${name} could not start or its output could not be saved` };
      result = { code: 1, signal: null };
    }
    denial = result.denial ?? denial;
    const value = { offset, length: sink.length - offset, sha256: hash.digest('hex'), code: result.code, signal: result.signal ?? null, timedOut: result.timedOut === true };
    phases[name] = value;
    return value;
  };
  if (!problem && mode.install) await phase('install', mode.install, true);
  const installed = !mode.install || phases.install?.code === 0 && !phases.install.signal && !phases.install.timedOut;
  if (!problem && installed) await phase('check', mode.check, false);
  const last = phases.check ?? phases.install;
  let sourceUnchanged = false;
  if (!mode.guard) {
    try {
      const state = (await git(S, root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], env)).split('\n').filter(Boolean);
      sourceUnchanged = state.includes('# branch.oid ' + spec.commit) && state.every(line => line.startsWith('# '));
    } catch { sourceUnchanged = false; }
  }
  return { code: problem ? 1 : last?.code ?? 1, signal: last?.signal ?? null, ...(denial ? { denial } : {}),
    trustedMode: { kind: 'private-check', version: 1, requestSha256: mode.sha256, phases, guard, sourceUnchanged, ...(problem ? { problem } : {}) } };
}
