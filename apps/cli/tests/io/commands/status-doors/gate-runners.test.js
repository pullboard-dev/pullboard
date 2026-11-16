/** @pullboard-test-input source-cell apps/cli packages/gate packages/runners packages/jobs packages/resources */
/**
 * pullboard status reaches the gate, runners, jobs and resources cells only through their light doors, so no heavy barrel loads for the few names it prints [C7,#8647].
 * The gate receipt reader is the exception: gate/light.js is the runner worker's door, so status loads that one name lazily rather than widen the worker bundle.
 * Why static: the modules a command loads are the ones its import statements name, so no process is launched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const STATUS = readFileSync(resolve(REPO, 'apps/cli/src/io/commands/status.js'), 'utf8');
const NAMES = {
  runners: ['readRunnerUtilization', 'runnerDeadlineRuns'],
  jobs: ['stalledGates'],
  resources: ['runnerDeadlineLine'],
};

/** The module path each top-level static import of status.js names, keyed by imported name; multi-line lists count. */
function importedFrom() {
  const found = new Map();
  for (const match of STATUS.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gmu)) {
    for (const name of match[1].split(',').map(part => part.trim().split(/\s+as\s+/u)[0]).filter(Boolean)) found.set(name, match[2]);
  }
  return found;
}

test('clause 1: status imports every runners, jobs and resources name through that package light door [C7]', () => {
  const from = importedFrom();
  for (const [pkg, names] of Object.entries(NAMES)) {
    for (const name of names) assert.ok(from.get(name)?.endsWith(`/packages/${pkg}/light.js`), `${name} comes from ${from.get(name)}, not packages/${pkg}/light.js`);
  }
});

test('clause 1: each light door exports the names status takes from it [C7]', () => {
  for (const pkg of Object.keys(NAMES)) {
    const door = readFileSync(resolve(REPO, `packages/${pkg}/light.js`), 'utf8');
    for (const name of NAMES[pkg]) assert.match(door, new RegExp(`\\b${name}\\b`, 'u'), `packages/${pkg}/light.js does not export ${name}`);
  }
});

test('clause 1: status keeps no static barrel import from the runners, jobs or resources cells; the gate receipt reader loads lazily [C7]', () => {
  assert.doesNotMatch(STATUS, /packages\/(?:runners|jobs|resources)\/index\.js/u);
});
