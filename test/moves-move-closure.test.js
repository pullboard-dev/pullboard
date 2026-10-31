/** @pullboard-test-input source-tree */
/** @pullboard-test-input package.json */
/** The exact moves shims keep the board-move declaration closure free of the registry loader [C7,CD60,H16]. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsIn } from '../src/module-imports.js';
import { readPathMap } from '../packages/codemap/index.js';
import { workingSourceInventory } from '../bin/checks/scan.js';
import { packageFiles } from '../src/package-files.js';
import { sourceDirectories } from './machine-source-functions.fixture.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHIMS = {
  'src/bar-ready-setting.js': 'packages/moves/src/core/bar-ready-setting.js',
  'src/moves/reopen.js': 'packages/moves/src/core/moves/reopen.js',
  'src/moves/shout.js': 'packages/moves/src/core/moves/shout.js',
};

/** Read the real literal relative closure of every board-move declaration, keyed by canonical old identity. */
function closure(read, identities, opaque = null) {
  const pending = readdirSync(join(ROOT, 'src/moves')).filter(file => file.endsWith('.js')).map(file => `src/moves/${file}`);
  const seen = new Set();
  while (pending.length) {
    const file = pending.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) { JSON.parse(read(file)); continue; } // Imported data is retained, never executed.
    assert.match(file, /\.[cm]?js$/u, `every executable dependency is a JavaScript module: ${file}`);
    for (const specifier of importsIn([read(file)])[0]) {
      if (specifier.startsWith('node:')) continue;
      if (opaque && specifier === '(computed)') { opaque.add(file); continue; }
      assert.ok(specifier.startsWith('.'), `literal relative move dependency: ${specifier}`);
      pending.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
    }
  }
  return [...new Set([...seen].map(file => identities.get(file) ?? file))].sort();
}

test('exact moves shims add no registry loader to the move declaration closure; the front door fails the control [C7,CD60,H16]', () => {
  const sources = new Map(workingSourceInventory(ROOT, sourceDirectories(packageFiles(ROOT)))
    .map(({ file, body }) => [file, body.toString('utf8')]));
  const read = file => {
    assert.ok(sources.has(file), `closure source belongs to the bounded inventory: ${file}`);
    return sources.get(file);
  };
  const identities = new Map([...readPathMap(ROOT)].map(([old, moved]) => [moved, old]));
  for (const [shim, body] of Object.entries(SHIMS)) {
    assert.ok(read(shim).includes(posix.relative(posix.dirname(shim), body)), `${shim} targets its own exact body`);
  }
  const after = closure(read, identities);
  assert.ok(after.includes('src/bar-ready-setting.js') && after.includes('src/moves/reopen.js'), 'the shimmed leaves stay in the closure');
  assert.ok(!after.includes('src/move-registry.js'), 'the registry loader is not reached by any move declaration');
  assert.ok(!after.includes('packages/moves/index.js'), 'the front door is not reached by any move declaration');
  const opaque = new Set();
  const broad = closure(file => file === 'src/bar-ready-setting.js'
    ? "export * from '../packages/moves/index.js';\n" : read(file), identities, opaque);
  assert.notDeepEqual(broad, after, 'the front door cannot substitute for the approved exact shim');
  assert.ok(broad.includes('src/move-registry.js'), 'the negative control reaches the registry loader');
  assert.deepEqual([...opaque], ['packages/moves/src/shell/move-registry.js'], 'the control reaches the registry computed loader');
});
