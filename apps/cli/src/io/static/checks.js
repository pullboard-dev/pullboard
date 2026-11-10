#!/usr/bin/env node
/** The Pullboard repository's source-only preflight; no browser fixtures run [C7]. */
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { changedStaticFailures } from '../../../../../packages/gate/index.js';
import { viewPureGate } from './view.js';

// Only the executable composes higher CLI services; importing this module does not run the preflight.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const root = process.cwd();
if (process.argv[2] === '--changed-files') {
  // One list for the gate and the pre-commit hook: packages/gate/src/io/changed/scripts/static.js.
  const failures = changedStaticFailures(root, process.argv.slice(3));
  if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exitCode = 1; }
} else {
// The view-pure class needs the view app's test roles, so the CLI adds it here; gate's registry names no app [V32].
const tree = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(new URL('../../../../../packages/gate/bin/static.js', import.meta.url)), root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const failures = [...(tree.status === 0 ? JSON.parse(tree.stdout) : [`packages/gate/bin/static.js:1: the static tree registry could not run: ${tree.stderr.trim().split('\n').at(-1)}`]), ...viewPureGate(root).failures.map(row => `${row.path}:${row.line}: ${row.text}`)];
for (const row of failures) console.error(row);
const failed = failures.length > 0;
if (!failed) console.log('static style, prose declarations, clock budgets and doctrine hold');
process.exitCode = failed ? 1 : 0;
}
}
