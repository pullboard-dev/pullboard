#!/usr/bin/env node
/** The journey-cut freeze script: move, convert or delete test files from the manifest's tags; `--dry-run` only prints the plan [C7]. */
import { runFreezeCommand } from '../freeze.js';

const { status, stdout, stderr } = runFreezeCommand(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = status;
