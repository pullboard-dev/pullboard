#!/usr/bin/env node
/**
 * Forward to the test runner launcher that lives in the app above gate, for item checks frozen on this path.
 * Why: the launcher wires the landing and runners cells into the engine, which gate must not import; the path is read
 * from the repo config (the affectedTests command in pullboard.json) so this file holds no import edge.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../../..');
const { affectedTests } = JSON.parse(readFileSync(resolve(root, 'pullboard.json'), 'utf8'));
const launcher = resolve(root, affectedTests.replace(/^node\s+/u, ''));
const child = spawn(process.execPath, [...process.execArgv, launcher, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
