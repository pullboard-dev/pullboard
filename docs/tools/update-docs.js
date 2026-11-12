#!/usr/bin/env node
/** Regenerate committed declaration-derived documentation, or check it without writing [C7]. */
import { fileURLToPath } from 'node:url';
const { openBoard } = await import('../../apps/lib/index.js');
import { generatedDocDrift } from '../../apps/cli/index.js';
import { generatedDocs } from '../../apps/cli/index.js';
import { writeGeneratedDocs } from '../../apps/cli/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
if (!(args.length === 0 || args.length === 1 && ['--check', '--json'].includes(args[0])
    || args.length === 2 && args[0] === '--print')) {
  throw new Error('usage: node docs/tools/update-docs.js [--check | --json | --print <generated-path>]');
}
const outputs = generatedDocs(root, { openBoard });
if (args[0] === '--print') {
  if (!outputs.has(args[1])) throw new Error('print needs an exact generated documentation path');
  process.stdout.write(outputs.get(args[1]));
} else if (args[0] === '--check') {
  const stale = generatedDocDrift(root, outputs);
  if (stale.length) {
    process.stderr.write(`Generated documentation is stale: ${stale.join(', ')}; run node docs/tools/update-docs.js\n`);
    process.exitCode = 1;
  }
} else {
  const changed = writeGeneratedDocs(root, outputs);
  if (args[0] === '--json') console.log(JSON.stringify({ changed }));
  else for (const file of changed) console.log(`generated ${file}`);
}
