#!/usr/bin/env node
/** Compose the fresh native runner controller with its fixed private-check policy, never request-selected code [C7,V4]. */
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';
import {
  privateCheckEnvelope,
  privateCheckPhases,
} from '../../index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { PULL_MODES } from '../../../../packages/runners/index.js';
import { servePullController } from '../../../../packages/runners/index.js';

/** Importing this module never starts a controller; only its exact direct entry accepts bridge input. */
function isRunnerControllerEntry() {
  if (process.argv[2] !== '--pullboard-runner-controller' || !process.argv[1]) return false;
  try { return fileSystemAdapter().realpath(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

/** A pulled job's short submit, serve-need or finish process: it carries the private-check policy only, never a lease or a watch [C7,#5465]. */
const pullMode = PULL_MODES.includes(process.argv[3]) ? process.argv[3] : null;

// The runner agent's start command lives beside the worker; a controller without it still serves, and its jobs wait for an agent started by hand.
const agent = pullMode === '--submit' ? await import('./agent.js').catch(() => null) : null;

if (isRunnerControllerEntry()) {
  // Pull is the only transport; a controller started without a pull mode has nothing to serve.
  (pullMode ? servePullController(pullMode, { privateCheckEnvelope, privateCheckPhases, agentStart: root => agent?.runnerAgentStartCommand(root) })
    : Promise.reject(new Refused('RUNNER_CONTROLLER_PULL_ONLY', 'the SSH runner controller is retired; start it with a pull mode as its first argument')))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
