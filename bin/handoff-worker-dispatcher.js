#!/usr/bin/env node
/** Keep machine handoff admission separate from the gate's exact process-identity provider [C7]. */
import { exactStart } from '../packages/gate/index.js';
import { drainHandoffQueue } from '../packages/resources/index.js';

try { await drainHandoffQueue({ startOf: exactStart }); }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
