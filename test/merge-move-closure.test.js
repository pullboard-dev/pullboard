/** @pullboard-test-input source-tree */
/** @pullboard-test-input package.json */
/** @pullboard-world-pin reads this test's own source to prove it pins no digest. Move discovery reads the exact moved conflict body, keeping the accepted dependencies [C7,CD60,H16]. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsIn } from '../packages/gate/index.js';
import { readPathMap } from '../packages/codemap/index.js';
import { workingSourceInventory } from '../bin/checks/scan.js';
import { packageFiles } from '../packages/runners/index.js';
import { sourceDirectories } from './machine-source-functions.fixture.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MOVED = 'packages/merge/src/shell/trunk-conflict.js';

/** Read the real relative closure, retaining native imports and a canonical identity for moved bodies. */
function closure(read, identities) {
  const pending = ['packages/moves/src/core/moves', 'packages/moves/src/shell/moves'].flatMap(folder => readdirSync(join(ROOT, folder)).filter(file => file.endsWith('.js'))
    .map(file => `${folder}/${file}`));
  const seen = new Set(), native = new Set();
  while (pending.length) {
    const file = pending.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) {
      JSON.parse(read(file)); // Imported data is retained in the closure, never parsed as executable JavaScript.
      continue;
    }
    assert.match(file, /\.[cm]?js$/u, 'every executable dependency is a JavaScript module');
    for (const specifier of importsIn([read(file)])[0]) {
      if (specifier.startsWith('node:')) native.add(specifier);
      else {
        assert.ok(specifier.startsWith('.'), `literal relative move dependency: ${specifier}`);
        pending.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
      }
    }
  }
  return { files: [...new Set([...seen].map(file => identities.get(file) ?? file))].sort(),
    native: [...native].sort() };
}

test('conflict shim preserves the accepted main move closure and the broad index fails the control [C7,CD60,H16]', () => {
  const sources = new Map(workingSourceInventory(ROOT, sourceDirectories(packageFiles(ROOT)))
    .map(({ file, body }) => [file, body.toString('utf8')]));
  const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  /** Read only exact finite inventory bytes, with the one explicit JSON data input retained. */
  const read = file => {
    if (file === 'package.json') return manifest;
    assert.ok(sources.has(file), `closure source belongs to the bounded inventory: ${file}`);
    return sources.get(file);
  };
  const identities = new Map([...readPathMap(ROOT)].map(([old, moved]) => [moved, old]));
  const movedExport = "export { CONFLICT_ENGINE } from '../../../../src/trunk-conflict-engine.js';";
  assert.ok(read(MOVED).includes(movedExport), 'the moved body re-exports the same engine leaf');
  const before = closure(file => file === MOVED ? read(MOVED).replace(movedExport, 'export { CONFLICT_ENGINE };') : read(file), identities);
  const after = closure(read, identities);
  assert.deepEqual(after, before, 'the exact moved body adds no dependency or native capability');
  assert.ok(!importsIn([read(MOVED)])[0].includes('node:child_process'), 'the moved conflict body itself imports no process launcher');
  const broad = closure(file => file === MOVED
    ? "export * from '../../index.js';\n" : read(file), identities);
  assert.notDeepEqual(broad, before, 'the broad index cannot substitute for the exact moved body');
  assert.ok(broad.native.includes('node:child_process'), 'the negative control reaches actual process launchers');
});

test('clause 1: this file pins no hash digest of the live conflict body or package.json [C7,CD60,H16]', () => {
  const own = readFileSync(new URL(import.meta.url), 'utf8');
  assert.doesNotMatch(own, /\b[0-9a-f]{64}\b/u, 'no 64-hex digest literal remains');
  assert.doesNotMatch(own, new RegExp(['create' + 'Hash', 'sha' + '256'].join('|'), 'u'), 'no hashing of the live implementation body remains');
});
