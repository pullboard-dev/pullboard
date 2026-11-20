#!/usr/bin/env node
/** Re-parent a machine dispatcher before its short-lived command launcher exits [C7]. */
import { spawn } from 'node:child_process';
import { fileSystemAdapter } from '../../../../../fs/index.js';

const fs = fileSystemAdapter();

const { entry, cwd, env, log } = JSON.parse(process.argv[2] ?? '{}');
if (!entry || !cwd || !env) throw new Error('dispatcher launch details are required');
const out = log ? fs.open(log, 'a', 0o600) : 'ignore';
const dispatcher = spawn(process.execPath, [entry], { cwd, detached: true, stdio: ['ignore', out, out], env });
if (log) fs.close(out);
dispatcher.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
dispatcher.once('spawn', () => {
  process.stdout.write(String(dispatcher.pid));
  dispatcher.unref();
});
