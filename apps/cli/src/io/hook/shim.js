/**
 * The commit hook shim: the CLI entry runs a commit hook as a child of this small process, which writes a start row
 * timed from its own process start and an end row when the hook exits, and stops the hook and every process it
 * started after HOOK_TIMEOUT_MS with a next step. Why: seat timing began after imports, so the untimed span (node start,
 * imports, the static check) held the 8- and 20-minute hooks nobody could measure (#5719). Only node: built-ins load
 * before the hook starts; the seat timing door loads while it runs.
 */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** The hooks the shim wraps: the commit hooks. pre-push runs the gate, which may rightly take longer. */
export const SHIMMED_HOOKS = ['pre-commit', 'pre-merge-commit', 'commit-msg'];
/** How long a commit hook may run before the shim stops it. */
export const HOOK_TIMEOUT_MS = 120_000;
/** Set in the hook's own environment, so the child runs the hook rather than wrapping it again. */
export const HOOK_SHIM_ENV = 'PULLBOARD_HOOK_SHIM';

/**
 * The process ids under `root`, deepest first, read from one ps listing; none when ps cannot answer.
 *
 * @param {number} root
 * @returns {number[]}
 */
export function descendants(root) {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (listed.status !== 0) return [];
  const children = new Map();
  for (const line of listed.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found = [];
  const walk = (pid) => { for (const child of children.get(pid) ?? []) { walk(child); found.push(child); } };
  walk(root);
  return found;
}

/**
 * The hook's environment: marked as shimmed, and, when a staged static check is named, with the VM modules it needs
 * through NODE_OPTIONS, so the hook process and a composed child of it can run that check in process.
 */
function hookEnv(env) {
  const options = env.PULLBOARD_HOOK_STATIC ? `${env.NODE_OPTIONS ?? ''} --experimental-vm-modules --disable-warning=ExperimentalWarning`.trim() : env.NODE_OPTIONS;
  return { ...env, [HOOK_SHIM_ENV]: '1', ...(options === undefined ? {} : { NODE_OPTIONS: options }) };
}

/** Whether this command line is a commit hook the shim should wrap, and is not already inside one. */
export function wantsHookShim(args, env) {
  return args[0] === 'hook' && SHIMMED_HOOKS.includes(args[1]) && !env[HOOK_SHIM_ENV];
}

/**
 * Run one commit hook as a child process, timed whole, and return its exit code. The child starts first, so the seat
 * lookup and timing imports overlap its start instead of adding to the commit.
 *
 * @param {string} entry the CLI entry file the child runs
 * @param {string[]} args hook, the hook name, then git's arguments
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, stderr: { write(text: string): unknown }, timeoutMs?: number, startedAt?: number }} options
 * @returns {Promise<number>}
 */
export function runHookShim(entry, args, { cwd, env, stderr, timeoutMs = HOOK_TIMEOUT_MS, startedAt = Math.floor(performance.timeOrigin) }) {
  const hook = args[1];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env: hookEnv(env), stdio: 'inherit' });
    // The start row carries the shim's process start, whenever it is written.
    const timing = import('../../../../../packages/seats/light.js').then(({ appendSeatTiming, timingSeat }) => {
      const binding = timingSeat(cwd);
      const base = { version: 1, id: randomUUID(), seat: binding?.seat ?? null, item: binding?.item ?? null, kind: 'hook', command: `hook ${hook}`, pid: process.pid, start: startedAt };
      if (binding) appendSeatTiming(binding.file, { ...base, phase: 'start' });
      return { binding, base, appendSeatTiming };
    }, () => ({ binding: null }));
    let timedOut = false;
    let settled = false;
    /** Signal the hook and every process it started, a composed child included, deepest first; any may be gone. */
    const stop = (signal) => {
      for (const pid of [...descendants(child.pid), child.pid]) { try { process.kill(pid, signal); } catch { /* already exited */ } }
    };
    const forward = (signal) => () => stop(signal);
    const forwarded = ['SIGTERM', 'SIGHUP'].map((signal) => [signal, forward(signal)]);
    for (const [signal, handler] of forwarded) process.on(signal, handler);
    const timer = setTimeout(() => { timedOut = true; stop('SIGKILL'); }, timeoutMs);
    /** Write the end row and settle once, whichever way the hook ended. */
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [signal, handler] of forwarded) process.removeListener(signal, handler);
      if (timedOut) {
        const seconds = Math.round(timeoutMs / 1000);
        stderr.write(`pullboard ${hook}: [HOOK_TIMEOUT] the ${hook} hook ran past ${seconds} s and was stopped; nothing was committed\n`
          + `next: commit again; if it stops again, run pullboard shout coordinator --kind blocker "${hook} hook stopped after ${seconds} s"\n`);
      }
      const end = Date.now();
      timing.then(({ binding, base, appendSeatTiming }) => {
        if (binding) appendSeatTiming(binding.file, { ...base, phase: 'end', end, durationMs: Math.max(0, end - startedAt), exit: code, timedOut });
        resolve(code);
      });
    };
    child.once('error', (error) => { stderr.write(`pullboard ${hook}: could not start the hook: ${error.message}\n`); settle(1); });
    child.once('exit', (code, signal) => settle(timedOut || signal ? 1 : code ?? 1));
  });
}
