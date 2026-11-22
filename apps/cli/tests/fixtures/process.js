/** Awaited production CLI calls with isolated output and serialized process-global environment [C7,A1]. */
import { Readable } from 'node:stream';
import { main } from './native.js';
import { installedMain } from './native.js';
import { HOOK_WORKER } from '../../index.js';
import { launchRelaySender } from '../../index.js';

let pending = Promise.resolve();

/**
 * Run work after every earlier awaited in-process call, and hold later ones until it settles.
 * Why: scripts and CLI calls both touch process-global environment, cwd and streams [C7,#8251].
 */
export function serializeInProcess(work) {
  const run = pending.then(work);
  pending = run.then(() => undefined, () => undefined);
  return run;
}

/** Restore an exact environment, including absent keys; never remove identity markers selectively. */
function restoreEnvironment(saved) {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) process.env[key] = value;
}

/**
 * Capture a command function using the same stream interface as the real binary. Calls sharing this
 * module serialize because legacy handlers still consult process.env. Callers must await completion;
 * unrelated tests must not mutate process globals concurrently with an explicit environment call.
 * Unexpected exceptions propagate after restoration, rather than becoming a fabricated CLI refusal.
 */
export function captureCommandInProcess(command, argv, { cwd = process.cwd(), env, input = '', personChannel } = {}) {
  const args = [...argv];
  const environment = env === undefined ? undefined : { ...env };
  const run = pending.then(async () => {
    const saved = { ...process.env };
    const directory = process.cwd();
    const exitCode = process.exitCode;
    let stdout = '', stderr = '';
    const stdin = Readable.from([input]);
    try {
      if (environment !== undefined) restoreEnvironment(environment);
      const status = await command(args, { cwd, stdin, hookWorker: HOOK_WORKER, hookTimeoutMs: 30_000, launchRelaySender, loadNativeBoard: () => import('../../../lib/index.js'),
        stdout: { isTTY: false, write(text) { stdout += String(text); return true; } },
        stderr: { isTTY: false, write(text) { stderr += String(text); return true; } },
        ...(personChannel === undefined ? {} : { personChannel }) });
      return { status, code: status, stdout, stderr, out: stdout, err: stderr, signal: null, failure: null };
    } finally {
      stdin.destroy();
      restoreEnvironment(saved);
      if (process.cwd() !== directory) process.chdir(directory);
      process.exitCode = exitCode;
    }
  });
  pending = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Run actual production dispatch, including parsing, identity, ordered writes and refusals.
 * installedRoot selects the packed installation's public CLI, board and outbox doors, with its own worker paths.
 * The native composition helper declares every installed dependency for complete source selection.
 */
export function runCliInProcess(argv, { installedRoot, ...options } = {}) {
  if (installedRoot === undefined) return captureCommandInProcess(main, argv, options);
  return captureCommandInProcess((args, streams) => installedMain(installedRoot, args, streams), argv, options);
}
