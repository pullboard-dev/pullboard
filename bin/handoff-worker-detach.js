#!/usr/bin/env node
/** Re-parent a machine dispatcher before its short-lived command launcher exits [C7]. */
import { spawn } from 'node:child_process';

const { entry, cwd, env } = JSON.parse(process.argv[2] ?? '{}');
if (!entry || !cwd || !env) throw new Error('dispatcher launch details are required');
const dispatcher = spawn(process.execPath, [entry], { cwd, detached: true, stdio: 'ignore', env });
dispatcher.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
dispatcher.once('spawn', () => {
  process.stdout.write(String(dispatcher.pid));
  dispatcher.unref();
});
