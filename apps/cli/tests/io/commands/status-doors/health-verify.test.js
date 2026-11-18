/** @pullboard-test-input source-cell apps/cli packages/health */
/**
 * pullboard status reaches the health and verify cells only through one call-site import each, so no heavy barrel loads at startup [C7,#8645].
 * The health names left the health light door (11a333c0c1 put them there): they pull the store index, and the door's cold load went over its 100 ms budget.
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

/** The names a lazy `await import(...)` of one cell barrel destructures in status.js, with the match. */
function lazyImport(cell) {
  const lazy = STATUS.match(new RegExp(`const \\{([^}]*)\\} = await import\\('[^']*packages\\/${cell}\\/index\\.js'\\);`, 'u'));
  return lazy && { text: lazy[0], names: lazy[1].split(',').map(name => name.trim()).sort() };
}

test('cli.io-commands-status-doors-health-verify.status-takes-every-health-name-from-one: clause 1: status takes every health name from one lazy call-site import inside run [C7]', () => {
  const lazy = lazyImport('health');
  assert.ok(lazy, 'no lazy health import in status.js');
  assert.deepEqual(lazy.names, [...HEALTH].sort());
  assert.ok(STATUS.indexOf(lazy.text) > STATUS.indexOf('export async function run('), 'the health import sits outside run');
});

test('cli.io-commands-status-doors-health-verify.status-keeps-no-static-import-of-any: clause 1: status keeps no static import of any health or verify module [C7]', () => {
  const paths = [...STATUS.matchAll(/^(?:import|export)\s[^;]*?from\s*'([^']*packages\/(?:health|verify)\/[^']*)'/gmu)].map(match => match[1]);
  assert.deepEqual(paths, []);
  const from = importedFrom();
  for (const name of HEALTH) assert.equal(from.get(name), undefined, `${name} is imported statically from ${from.get(name)}`);
});

test('cli.io-commands-status-doors-health-verify.status-takes-every-verify-name-from-one: clause 1: status takes every verify name from one lazy call-site import inside run [C7]', () => {
  const lazy = lazyImport('verify');
  assert.ok(lazy, 'no lazy verify import in status.js');
  assert.deepEqual(lazy.names, [...VERIFY].sort());
  assert.ok(STATUS.indexOf(lazy.text) > STATUS.indexOf('export async function run('), 'the verify import sits outside run');
});

test('cli.io-commands-status-doors-health-verify.the-health-light-door-re-exports-none: clause 1: the health light door re-exports none of the names status loads lazily [C7]', () => {
  const door = readFileSync(resolve(REPO, 'packages/health/light.js'), 'utf8');
  for (const name of HEALTH) assert.doesNotMatch(door, new RegExp(`\\b${name}\\b`, 'u'), `packages/health/light.js still exports ${name}`);
});
