/** @pullboard-test-input source-tree */
/** The exact conflict shim exception preserves accepted move discovery dependencies [C7,CD60,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsIn } from '../src/module-imports.js';
import { readPathMap } from '../packages/codemap/index.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGINAL = 'src/trunk-conflict.js';
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
  const read = file => readFileSync(join(ROOT, file), 'utf8');
  const identities = new Map([...readPathMap(ROOT)].map(([old, moved]) => [moved, old]));
  // Reconstruct only module operands; the digest pins every other accepted main byte.
  const original = read(MOVED).replace(/(from\s+)(['"])(\.[^'"]+)\2/gu, (_, prefix, quote, specifier) => {
    const relative = posix.relative('src', posix.normalize(posix.join(posix.dirname(MOVED), specifier)));
    return prefix + quote + (relative.startsWith('.') ? relative : `./${relative}`) + quote;
  });
  assert.equal(createHash('sha256').update(original).digest('hex'), 'bc4ef60283c22fda3a2c5cf43fc9b8017e4ff4fa86826d58c420683584b8ca63',
    'the unchanged conflict implementation is the accepted 4417733 main body');
  const before = closure(file => file === ORIGINAL ? original : read(file), identities);
  const after = closure(read, identities);
  assert.deepEqual(after, before, 'the exact moved-body shim adds no dependency or native capability');
  assert.ok(!after.native.includes('node:child_process'));
  const broad = closure(file => file === ORIGINAL
    ? "export * from '../packages/merge/index.js';\n" : read(file), identities);
  assert.notDeepEqual(broad, before, 'the broad index cannot substitute for the approved narrow shim');
  assert.ok(broad.native.includes('node:child_process'), 'the negative control reaches actual process launchers');
});
