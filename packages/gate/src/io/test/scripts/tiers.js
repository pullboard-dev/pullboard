#!/usr/bin/env node
/** Regenerate or check the reviewed test-tier manifest [C7,CS4,CD44,CD47]. */
import { resolve } from 'node:path';
import { writeTestTiers } from '../../../../index.js';

const args = process.argv.slice(2);
if (args.some(arg => arg.startsWith('-') && arg !== '--check') || args.filter(arg => !arg.startsWith('-')).length > 1) {
  process.stderr.write('usage: node packages/gate/src/io/test/scripts/tiers.js [--check] [project-root]\n');
  process.exitCode = 1;
} else {
  const root = resolve(args.find(arg => !arg.startsWith('-')) ?? '.');
  const result = writeTestTiers(root, { check: args.includes('--check') });
  if (!result.ok) process.stderr.write('packages/gate/data/tests/tiers.json is stale; run node packages/gate/src/io/test/scripts/tiers.js\n');
  else process.stdout.write(`${result.manifest.files.length} test files classified${result.unchanged ? '; unchanged' : ''}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
