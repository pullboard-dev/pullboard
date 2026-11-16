/** @pullboard-test-input source-cell apps/cli packages/health packages/verify */
/**
 * pullboard status reaches the health and verify cells only through their light doors, so no heavy barrel loads for the few names it prints [C7,#8645].
 * Why static: the modules a command loads are the ones its import statements name, so no process is launched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const STATUS = readFileSync(resolve(REPO, 'apps/cli/src/io/commands/status.js'), 'utf8');
const NAMES = {
  health: ['claimHealthProjection', 'releaseBlockingItems', 'staleStateSnapshot'],
  verify: ['currentProofCounters', 'proofCounter', 'ruleProofCounts', 'bindProofRunner', 'reviewQueueLine'],
};

/** The module path each top-level static import of status.js names, keyed by imported name. */
function importedFrom() {
  const found = new Map();
  for (const match of STATUS.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gmu)) {
    for (const name of match[1].split(',').map(part => part.trim().split(/\s+as\s+/u)[0]).filter(Boolean)) found.set(name, match[2]);
  }
  return found;
}

test('clause 1: status imports every health and verify name through that package light door [C7]', () => {
  const from = importedFrom();
  for (const [pkg, names] of Object.entries(NAMES)) {
    for (const name of names) assert.ok(from.get(name)?.endsWith(`/packages/${pkg}/light.js`), `${name} comes from ${from.get(name)}, not packages/${pkg}/light.js`);
  }
});

test('clause 1: status keeps no static import of a health or verify barrel [C7]', () => {
  const barrels = [...STATUS.matchAll(/^(?:import|export)\s[^;]*?from\s*'([^']*packages\/(?:health|verify)\/[^']*)'/gmu)].map(match => match[1]);
  assert.ok(barrels.length > 0);
  assert.deepEqual(barrels.filter(path => !path.endsWith('/light.js')), []);
});

test('clause 1: each light door exports the names status takes from it [C7]', () => {
  for (const pkg of Object.keys(NAMES)) {
    const door = readFileSync(resolve(REPO, `packages/${pkg}/light.js`), 'utf8');
    for (const name of NAMES[pkg]) assert.match(door, new RegExp(`\\b${name}\\b`, 'u'), `packages/${pkg}/light.js does not export ${name}`);
  }
});
