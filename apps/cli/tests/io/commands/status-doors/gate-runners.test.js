/** @pullboard-test-input source-cell apps/cli packages/gate packages/runners packages/jobs packages/resources */
/**
 * pullboard status loads the gate, runners, jobs and resources readers it prints lazily, and the light doors the runner worker bundles export none of them, so no status-only module widens the worker closure [C7,#8647].
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

test('clause 1: status loads every gate, runners, jobs and resources reader lazily from that package front door [C7]', () => {
  for (const [pkg, names] of Object.entries(NAMES)) {
    for (const name of names) {
      assert.match(STATUS, new RegExp(`const \\{[^}]*\\b${name}\\b[^}]*\\} = await import\\('[./]+/packages/${pkg}/index\\.js'\\)`, 'u'), `${name} loads lazily from packages/${pkg}/index.js`);
    }
  }
});

test('clause 1: no light door exports a name only status reads [C7]', () => {
  for (const pkg of Object.keys(NAMES)) {
    const door = readFileSync(resolve(REPO, `packages/${pkg}/light.js`), 'utf8');
    for (const name of NAMES[pkg]) assert.doesNotMatch(door, new RegExp(`\\b${name}\\b`, 'u'), `packages/${pkg}/light.js exports ${name}, which widens the runner worker closure`);
  }
});

test('clause 1: status keeps no static import from the gate, runners, jobs or resources cells [C7]', () => {
  assert.doesNotMatch(STATUS, /^import[^\n]*packages\/(?:gate|runners|jobs|resources)\/(?:index|light)\.js/mu);
});
