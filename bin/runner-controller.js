#!/usr/bin/env node
/** Compose the fresh native runner controller with its fixed private-check policy, never request-selected code [C7,V4]. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveRunnerController } from '../packages/runners/index.js';
import { privateCheckEnvelope } from '../apps/runner/index.js';
import { privateCheckPhases } from '../apps/runner/index.js';
import { runnerItemState } from '../packages/resources/index.js';
import { controllerDeadline } from '../packages/resources/index.js';
import { probeRunnerJob } from '../packages/runners/index.js';

/** Importing this module never starts a controller; only its exact direct entry accepts bridge input. */
function isRunnerControllerEntry() {
  if (process.argv[2] !== '--pullboard-runner-controller' || !process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isRunnerControllerEntry()) serveRunnerController({ privateCheckEnvelope, privateCheckPhases, runnerItemState, controllerDeadline, probeRunnerJob })
  .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
