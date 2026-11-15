#!/usr/bin/env node
/** Write the generated test manifest: every test file's kind, cost and what it spawns [C7]. */
import { resolve } from 'node:path';
import { TEST_MANIFEST_FILE } from '../manifest.js';
import { writeTestManifest } from '../manifest.js';
import { TEST_KINDS } from '../../../logic/test/manifest.js';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = at >= 0 ? args[at + 1] : TEST_MANIFEST_FILE;
const rest = args.filter((arg, index) => index !== at && index !== at + 1);
if (rest.some(arg => arg.startsWith('-')) || rest.length > 1 || (at >= 0 && !out)) {
  process.stderr.write('usage: node packages/gate/src/io/test/scripts/manifest.js [--out file] [project-root]\n');
  process.exitCode = 1;
} else {
  const { manifest } = writeTestManifest(resolve(rest[0] ?? '.'), { out });
  const counts = Object.fromEntries(TEST_KINDS.map(kind => [kind, manifest.files.filter(row => row.kind === kind).length]));
  process.stdout.write(`${manifest.files.length} test files; ${TEST_KINDS.map(kind => `${counts[kind]} ${kind}`).join(', ')}; ${manifest.files.filter(row => row.cost.ms !== null).length} with a recorded runtime\n`);
}
