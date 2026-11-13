#!/usr/bin/env node
/**
 * Forward to the test runner launcher that lives in the app above gate, for item checks frozen on this path.
 * Why: the launcher wires the landing and runners cells into the engine, which gate must not import; the path is a
 * plain string spawned by Node, so this file holds no import edge. The child names this shim as the runner its Chrome
 * guardian watches, so a SIGKILL of the shim frees Chrome the way a SIGKILL of the runner did.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../../..');
const launcher = resolve(root, 'apps/cli/src/io/run/tests.js');
const child = spawn(process.execPath, [...process.execArgv, launcher, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PULLBOARD_RUN_SHIM_PID: String(process.pid) },
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
