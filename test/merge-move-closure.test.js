/** @pullboard-test-input source-tree */
/** @pullboard-test-input package.json */
/** Move discovery reads the exact moved conflict body, keeping the accepted dependencies [C7,CD60,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const pending = readdirSync(join(ROOT, 'src/moves')).filter(file => file.endsWith('.js'))
    .map(file => `src/moves/${file}`);
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
  // Reconstruct only module operands; the digest pins every other accepted main byte.
  const original = read(MOVED).replace(/(from\s+)(['"])(\.[^'"]+)\2/gu, (_, prefix, quote, specifier) => {
    const relative = posix.relative('src', posix.normalize(posix.join(posix.dirname(MOVED), specifier)));
    return prefix + quote + (relative.startsWith('.') ? relative : `./${relative}`) + quote;
  });
  const canonicalExport = "export { CONFLICT_ENGINE } from './trunk-conflict-engine.js';";
  assert.ok(original.includes(canonicalExport), 'the re-export names the unchanged canonical engine leaf');
  const acceptedBody = original.replace(canonicalExport, 'export { CONFLICT_ENGINE };');
  assert.equal(createHash('sha256').update(acceptedBody).digest('hex'), '9d4b4fcb4eea3966b06aab1aa44fd79498a376c45527b9d1a8183b45d4806452',
    'the unchanged conflict implementation is the accepted 4417733 main body');
  const movedExport = "export { CONFLICT_ENGINE } from '../../../../src/trunk-conflict-engine.js';";
  assert.ok(read(MOVED).includes(movedExport), 'the moved body re-exports the same engine leaf');
  const before = closure(file => file === MOVED ? read(MOVED).replace(movedExport, 'export { CONFLICT_ENGINE };') : read(file), identities);
  const after = closure(read, identities);
  assert.deepEqual(after, before, 'the exact moved body adds no dependency or native capability');
  assert.ok(!after.native.includes('node:child_process'));
  const broad = closure(file => file === MOVED
    ? "export * from '../../index.js';\n" : read(file), identities);
  assert.notDeepEqual(broad, before, 'the broad index cannot substitute for the exact moved body');
  assert.ok(broad.native.includes('node:child_process'), 'the negative control reaches actual process launchers');
});
