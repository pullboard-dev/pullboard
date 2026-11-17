/** @pullboard-test-input packages/gate/src/io/static/registry.js packages/gate/data/ceilings/cells-edges.json apps/cli/src/io/static/checks.js */
/** @pullboard-world-pin: the clauses read the registry source, the committed ceiling and the CLI entry to prove the app paths are handed in. */
/** The static registry names no apps/ path, takes the app files and the spec-check command from its caller, and its ceiling row is gone [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  STATIC_STAGE_CHECKS,
  STATIC_TREE_CHECKS,
} from '../src/io/static/registry.js';

const FILE = 'packages/gate/src/io/static/registry.js';
const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('gate.app-edges-io.registry-js-names-apps-path: clause 1: registry.js names no apps/ path [C7]', () => {
  assert.doesNotMatch(read(FILE), /apps\//u);
});

test('gate.app-edges-io.ceiling-holds-packageapps-row-registry: clause 1: the ceiling holds no packageApps row for registry.js [C7]', () => {
  assert.equal(JSON.parse(read('packages/gate/data/ceilings/cells-edges.json')).packageApps[FILE], undefined);
});

test('gate.app-edges-io.cli-static-entry-owns-app: clause 1: the CLI static entry owns the app paths and the spec-check command it hands in [C7]', () => {
  const entry = read('apps/cli/src/io/static/checks.js');
  for (const path of ['apps/cli/src/logic/help.js', 'apps/relay/src/io/deploy', 'apps/cli/index.js']) assert.ok(entry.includes(`'${path}'`), path);
  assert.match(entry, /specCheck: Object\.freeze\(\['apps\/cli\/pullboard\.js', 'spec', 'check'\]\)/u);
  assert.match(entry, /const scope = \{ changed: [^}]*apps: JSON\.parse/u);
  assert.match(entry, /runStaticTreeRegistry\(process\.argv\[1\], scope\)/u);
});

test('gate.app-edges-io.class-needs-app-paths-handed: clause 1: a class that needs app paths and is handed none fails loudly instead of passing [C7]', () => {
  for (const name of ['relay-boundary', 'prose-commands']) {
    const check = STATIC_TREE_CHECKS.find(row => row.name === name);
    assert.match(check.run('/nowhere', [], { cache: () => ({}) })[0], /the caller passed no app paths/u, name);
  }
  assert.match(STATIC_STAGE_CHECKS.find(row => row.name === 'spec-ids').run('/nowhere')[0], /the caller passed no app paths/u);
});
