#!/usr/bin/env node
/** The Pullboard repository's source-only preflight; no browser fixtures run [C7]. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { importStyleViolations } from '../src/static-import-style.js';
import { engineFolderProblems } from '../src/engine-folder.js';
import { declaredProseCommands } from '../src/static-prose-commands.js';
import { doctrineReport } from '../src/doctrine-checks.js';
import { loadConfig } from '../src/config.js';
import { HELP } from '../src/cli.js';
import { PULLBOARD_COMMANDS } from '../src/cockpit.js';

const root = process.cwd();
let failed = false;
const sources = readdirSync(join(root, 'src'), { recursive: true })
  .filter(file => file.endsWith('.js'))
  .map(file => {
    const path = join('src', file);
    return { file: path, source: readFileSync(join(root, path), 'utf8') };
  });
for (const row of importStyleViolations(sources)) {
  console.error(`${row.file}:${row.line}: one import binding per line (${row.count} bindings)`);
  failed = true;
}
for (const row of engineFolderProblems(root)) {
  console.error(`${row.file}:${row.line}: ${row.text}`);
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
