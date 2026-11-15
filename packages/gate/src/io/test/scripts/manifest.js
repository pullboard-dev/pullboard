#!/usr/bin/env node
/** Write the generated test manifest: every test file's kind, cost and what it spawns [C7]. */
import { runManifestCommand } from '../manifest.js';

const { status, stdout, stderr } = runManifestCommand(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = status;
