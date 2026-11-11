#!/usr/bin/env node
/** Compose the fresh native runner controller with its fixed private-check policy, never request-selected code [C7,V4]. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  privateCheckEnvelope,
  privateCheckPhases,
} from '../../index.js';
import { PULL_MODES } from '../../../../packages/runners/index.js';
import { servePullController } from '../../../../packages/runners/index.js';
import { serveRunnerController } from '../../../../packages/runners/index.js';
import { runnerItemState } from '../../../../packages/resources/index.js';
import { runnerItemSources } from '../../../../packages/resources/index.js';
import { controllerDeadline } from '../../../../packages/resources/index.js';
import { probeRunnerJob } from '../../../../packages/runners/index.js';

/** Importing this module never starts a controller; only its exact direct entry accepts bridge input. */
function isRunnerControllerEntry() {
  if (process.argv[2] !== '--pullboard-runner-controller' || !process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

/** A pulled job's short submit, serve-need or finish process: it carries the private-check policy only, never a lease or a watch [C7,#5465]. */
const pullMode = PULL_MODES.includes(process.argv[3]) ? process.argv[3] : null;

// The runner agent's start command lives beside the worker; a controller without it still serves, and its jobs wait for an agent started by hand.
const agent = pullMode === '--submit' ? await import('./agent.js').catch(() => null) : null;

if (isRunnerControllerEntry()) (pullMode ? servePullController(pullMode, { privateCheckEnvelope, privateCheckPhases, agentStart: root => agent?.runnerAgentStartCommand(root) })
  : serveRunnerController({ privateCheckEnvelope, privateCheckPhases, runnerItemState, runnerItemSources, controllerDeadline, probeRunnerJob }))
  .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
