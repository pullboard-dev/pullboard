/** @pullboard-test-input source-cell apps/cli packages/health */
/**
 * pullboard status reaches the health cell only through its light door and the verify cell only through one call-site import, so no heavy barrel loads at startup [C7,#8645].
 * Why static: the modules a command loads are the ones its import statements name, so no process is launched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const STATUS = readFileSync(resolve(REPO, 'apps/cli/src/io/commands/status.js'), 'utf8');
const HEALTH = ['claimHealthProjection', 'releaseBlockingItems', 'staleStateSnapshot'];
const VERIFY = ['currentProofCounters', 'proofCounter', 'ruleProofCounts', 'bindProofRunner', 'reviewQueueLine'];

/** The module path each top-level static import of status.js names, keyed by imported name. */
function importedFrom() {
  const found = new Map();
  for (const match of STATUS.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gmu)) {
    for (const name of match[1].split(',').map(part => part.trim().split(/\s+as\s+/u)[0]).filter(Boolean)) found.set(name, match[2]);
  }
  return found;
}

test('clause 1: status imports every health name through the health light door [C7]', () => {
  const from = importedFrom();
  for (const name of HEALTH) assert.ok(from.get(name)?.endsWith('/packages/health/light.js'), `${name} comes from ${from.get(name)}, not packages/health/light.js`);
});

test('clause 1: status keeps no static import of a health barrel or any verify module [C7]', () => {
  const paths = [...STATUS.matchAll(/^(?:import|export)\s[^;]*?from\s*'([^']*packages\/(?:health|verify)\/[^']*)'/gmu)].map(match => match[1]);
  assert.ok(paths.some(path => path.endsWith('/packages/health/light.js')));
  assert.deepEqual(paths.filter(path => !path.endsWith('/packages/health/light.js')), []);
});

test('clause 1: status takes every verify name from one lazy call-site import inside run [C7]', () => {
  const lazy = STATUS.match(/const \{([^}]*)\} = await import\('[^']*packages\/verify\/index\.js'\);/u);
  assert.ok(lazy, 'no lazy verify import in status.js');
  assert.deepEqual(lazy[1].split(',').map(name => name.trim()).sort(), [...VERIFY].sort());
  assert.ok(STATUS.indexOf(lazy[0]) > STATUS.indexOf('export async function run('), 'the verify import sits outside run');
});

test('clause 1: the health light door exports the names status takes from it [C7]', () => {
  const door = readFileSync(resolve(REPO, 'packages/health/light.js'), 'utf8');
  for (const name of HEALTH) assert.match(door, new RegExp(`\\b${name}\\b`, 'u'), `packages/health/light.js does not export ${name}`);
});
