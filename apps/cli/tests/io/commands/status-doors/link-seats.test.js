/** @pullboard-test-input source-cell apps/cli packages/link packages/seats */
/**
 * pullboard status reaches the link and seats cells only through its light door or one call-site import and loads the view's needs summary at its one call site, so none of them loads at startup [C7,#8648].
 * Why static: the modules a command loads are the ones its import statements name, so no process is launched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const STATUS = readFileSync(resolve(REPO, 'apps/cli/src/io/commands/status.js'), 'utf8');
const NAMES = { seats: ['originRepository'] };

/** The module path each top-level static import of status.js names, keyed by imported name; multi-line lists count. */
function importedFrom() {
  const found = new Map();
  for (const match of STATUS.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gmu)) {
    for (const name of match[1].split(',').map(part => part.trim().split(/\s+as\s+/u)[0]).filter(Boolean)) found.set(name, match[2]);
  }
  return found;
}

test('cli.io-commands-status-doors-link-seats.status-imports-the-seats-name-through-the: clause 1: status imports the seats name through the seats light door [C7]', () => {
  const from = importedFrom();
  for (const [pkg, names] of Object.entries(NAMES)) {
    for (const name of names) assert.ok(from.get(name)?.endsWith(`/packages/${pkg}/light.js`), `${name} comes from ${from.get(name)}, not packages/${pkg}/light.js`);
  }
});

test('cli.io-commands-status-doors-link-seats.each-light-door-exports-the-names-status: clause 1: each light door exports the names status takes from it [C7]', () => {
  for (const pkg of Object.keys(NAMES)) {
    const door = readFileSync(resolve(REPO, `packages/${pkg}/light.js`), 'utf8');
    for (const name of NAMES[pkg]) assert.match(door, new RegExp(`\\b${name}\\b`, 'u'), `packages/${pkg}/light.js does not export ${name}`);
  }
});

test('cli.io-commands-status-doors-link-seats.status-loads-the-view-needs-summary-lazily: clause 1: status loads the view needs summary lazily inside run, with no static view import [C7]', () => {
  assert.doesNotMatch(STATUS, /^(?:import|export)\s[^;]*from\s*'[^']*apps\/view\/|^(?:import|export)\s[^;]*from\s*'(?:\.\.\/)+view\//mu);
  const lazy = STATUS.indexOf("const { personNeedsSummary } = await import('../../../../view/needs.js');");
  assert.ok(lazy > STATUS.indexOf('export async function run('), 'the lazy view import is missing or sits outside run');
});

test('cli.io-commands-status-doors-link-seats.status-keeps-no-static-import-of-the: clause 1: status keeps no static import of the link or seats barrel and loads the link status inside run [C7]', () => {
  assert.doesNotMatch(STATUS, /^import\s[^;]*packages\/(?:link|seats)\/index\.js/mu);
  const lazy = STATUS.indexOf("(await import('../../../../../packages/link/index.js')).unlinkedRelayStatus");
  assert.ok(lazy > STATUS.indexOf('export async function run('), 'the lazy link import is missing or sits outside run');
});
