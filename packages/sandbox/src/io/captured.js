/** Bounded asynchronous child execution with the same result fields as spawnSync [C7,V4]. */
import { spawn } from 'node:child_process';

/** Drain an owned child before returning its status, including timeout, output-limit and caller cancellation. */
export async function spawnCaptured(command, args, options) {
  const grouped = process.platform !== 'win32';
  const { signal, onSpawn, onOutput, ...spawnOptions } = options;
  signal?.throwIfAborted();
  const child = spawn(command, args, { ...spawnOptions, detached: grouped, timeout: undefined });
  onSpawn?.(child);
  const output = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let error;
  let timer;
  let cancelTimer;
  /** Signal only this invocation's process group, never another check or the parent. */
  const stop = () => {
    try { if (grouped) process.kill(-child.pid, options.killSignal ?? 'SIGKILL'); else child.kill(options.killSignal ?? 'SIGKILL'); }
    catch (failure) { if (failure.code !== 'ESRCH') error ??= failure; }
  };
  /** Give a cancelled command a short graceful shutdown before stopping its still-owned process group. */
  const cancel = () => {
    try { if (grouped) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); }
    catch (failure) { if (failure.code !== 'ESRCH') error ??= failure; }
    cancelTimer = setTimeout(stop, 500);
    cancelTimer.unref?.();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  for (const name of ['stdout', 'stderr']) child[name]?.setEncoding('utf8').on('data', part => {
    onOutput?.();
    sizes[name] += Buffer.byteLength(part);
    if (sizes[name] <= (options.maxBuffer ?? 1024 * 1024)) output[name].push(part);
    else { error ??= Object.assign(new Error('child output exceeded maxBuffer'), { code: 'ENOBUFS' }); stop(); }
  });
  child.once('error', failure => { error ??= failure; });
  child.stdin?.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure; });
  child.stdin?.end(options.input ?? '');
  if (options.timeout) timer = setTimeout(() => {
    error ??= Object.assign(new Error('child timed out'), { code: 'ETIMEDOUT' });
    stop();
  }, options.timeout);
  try {
    const result = await new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
    return { ...result, stdout: output.stdout.join(''), stderr: output.stderr.join(''), ...(error ? { error } : {}) };
  } finally { clearTimeout(timer); clearTimeout(cancelTimer); signal?.removeEventListener('abort', cancel); }
}
