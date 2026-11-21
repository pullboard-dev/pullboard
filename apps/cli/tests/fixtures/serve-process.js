/** Start the production serve command as an OS process from a chosen cwd [C7]. */
import { resolve } from 'node:path';
import { startFixtureChild } from './child.js';

const CLI = resolve(import.meta.dirname, '../../pullboard.js');

/** Wait for a native serve process to print its ready JSON, keeping cleanup with the returned handle. */
export async function startServeProcess(cwd, env, timeoutMs = 30_000) {
  const child = startFixtureChild(process.execPath, [CLI, 'serve', '--port', '0', '--json'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  let stdout = '';
  let stderr = '';
  let ready = false;
  let readyResolve;
  let readyReject;
  const started = new Promise((resolveStarted, rejectStarted) => { readyResolve = resolveStarted; readyReject = rejectStarted; });
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    try {
      const document = JSON.parse(stdout);
      ready = true;
      readyResolve(document);
    } catch { /* wait for the complete JSON document */ }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.once('error', error => readyReject(error));
  child.once('close', (code, signal) => {
    if (!ready) readyReject(new Error(`serve exited before ready (code ${code}, signal ${signal}): ${stderr}`));
  });
  const timer = setTimeout(() => readyReject(new Error(`serve did not print its address: ${stderr}`)), timeoutMs);
  let server;
  try {
    server = await started;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    server,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    },
  };
}
