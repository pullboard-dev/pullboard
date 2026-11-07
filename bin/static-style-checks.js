#!/usr/bin/env node
/** The Pullboard repository's source-only preflight; no browser fixtures run [C7]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { styleSources } from '../packages/codemap/index.js';
import { importStyleViolations } from '../packages/gate/index.js';
import { engineFolderProblems } from '../packages/state/index.js';
import { declaredProseCommands } from '../apps/cli/index.js';
import { doctrineReport } from '../packages/doctrine/index.js';
import { loadConfig } from '../packages/config/index.js';
import { HELP } from '../apps/cli/index.js';
import { PULLBOARD_COMMANDS } from '../apps/cli/index.js';
import { viewPureGate } from './checks/view-pure.js';
import { testWaitReport } from './checks/test-waits.js';
import { testWaitGrowth } from './checks/test-waits.js';
import { fixtureProblems } from './checks/test-fixtures.js';
import { boardWriteIoProblems } from './checks/board-write-io.js';
import { relayBoundaryProblems } from './checks/relay-boundary.js';
import { cellsEdgeProblems } from './checks/cells-edges.js';
import { changedStaticFailures } from './checks/changed-static.js';

// Only the executable composes higher CLI services; importing this module does not run the preflight.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const root = process.cwd();
if (process.argv[2] === '--changed-files') {
  // One list for the gate and the pre-commit hook: bin/checks/changed-static.js.
  const failures = changedStaticFailures(root, process.argv.slice(3));
  if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exitCode = 1; }
} else {
let failed = false;
const waitBaseline = JSON.parse(readFileSync(join(root, 'bin/checks/test-waits-baseline.json'), 'utf8'));
for (const row of testWaitGrowth(testWaitReport(root), waitBaseline)) {
  console.error(`${row.path}:${row.line}: ${row.text}`);
  failed = true;
}
for (const row of fixtureProblems(root, join(root, 'bin/checks/test-fixtures.json'))) {
  console.error(`${row.path}:${row.line}: ${row.text}`);
  failed = true;
}
const sources = styleSources(root);
const relaySources = readdirSync(join(root, 'relay'), { withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?js$/u.test(entry.name)).map(entry => ({ file: `relay/${entry.name}`, source: readFileSync(join(root, 'relay', entry.name), 'utf8') }));
for (const row of relayBoundaryProblems([...sources, ...relaySources])) {
  console.error(`${row.file}:${row.line}: ${row.text}`);
  failed = true;
}
for (const row of cellsEdgeProblems(root)) {
  console.error(`${row.path}:${row.line}: ${row.text}`);
  failed = true;
}
for (const row of importStyleViolations(sources)) {
  console.error(`${row.file}:${row.line}: one import binding per line (${row.count} bindings)`);
  failed = true;
}
for (const row of engineFolderProblems(root)) {
  console.error(`${row.file}:${row.line}: ${row.text}`);
  failed = true;
}
for (const row of viewPureGate(root).failures) {
  console.error(`${row.path}:${row.line}: ${row.text}`);
  failed = true;
}
for (const row of boardWriteIoProblems(sources)) {
  console.error(`${row.file}:${row.line}: external I/O inside a board write: ${row.call} (${row.chain.join(' -> ')})`);
  failed = true;
}
const declared = [...declaredProseCommands(HELP)].sort();
const actual = [...PULLBOARD_COMMANDS].sort();
if (JSON.stringify(declared) !== JSON.stringify(actual)) {
  const line = readFileSync(join(root, 'src/cockpit.js'), 'utf8').split('\n').findIndex(row => row.includes('export const PULLBOARD_COMMANDS')) + 1;
  console.error(`src/cockpit.js:${Math.max(1, line)}: prose command declaration differs from the CLI help catalog`);
  failed = true;
}
const clock = spawnSync(process.execPath, ['test/wall-clock-budgets.js'], { cwd: root, encoding: 'utf8' });
if (clock.stdout) process.stdout.write(clock.stdout);
if (clock.stderr) process.stderr.write(clock.stderr);
if (clock.status !== 0) failed = true;
for (const row of doctrineReport(root, loadConfig(root))) {
  if (!row.holds) {
    console.error(`doctrine ${row.id}: ${row.state}\n${row.problems.join('\n')}`);
    failed = true;
  }
}
if (!failed) console.log('static style, prose declarations, clock budgets and doctrine hold');
process.exitCode = failed ? 1 : 0;
}
}
