#!/usr/bin/env node
/** Re-parent a machine dispatcher before its short-lived command launcher exits [C7]. */
import { spawnReachable } from '../../../../../jobs/index.js';

const { entry, cwd, env, log } = JSON.parse(process.argv[2] ?? '{}');
if (!entry || !cwd || !env) throw new Error('dispatcher launch details are required');
// The dispatcher starts where it can reach the runners, whichever app ran the command that launched it (#5699).
const { pid } = await spawnReachable(process.execPath, [entry], { cwd, env, ...(log ? { log } : {}) });
if (pid) process.stdout.write(String(pid));
else { process.stderr.write('the dispatcher did not start\n'); process.exitCode = 1; }
