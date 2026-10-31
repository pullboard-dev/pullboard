/** @pullboard-test-input source-tree */
/** @pullboard-test-input package.json */
/** Exact-body verify shims keep the runner worker and move registry closures unchanged [C7,CD60,H16]. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsIn } from '../src/module-imports.js';
import { readPathMap } from '../packages/codemap/index.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERIFY = new Map([...readPathMap(ROOT)].filter(([, moved]) => moved.startsWith('packages/verify/')));
const IDENTITY = new Map([...VERIFY].map(([old, moved]) => [moved, old]));

/** Follow only literal relative imports from the entries; report the verify files and native modules reached. */
function closure(entries, read) {
  const pending = [...entries], seen = new Set(), native = new Set();
  while (pending.length) {
    const file = pending.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[cm]?js$/u.test(file)) continue;
    for (const specifier of importsIn([read(file)])[0]) {
      if (specifier.startsWith('node:')) native.add(specifier);
      else {
        assert.ok(specifier.startsWith('.'), `literal relative dependency: ${specifier}`);
        pending.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
      }
    }
  }
  const verify = [...new Set([...seen].map(file => IDENTITY.get(file) ?? file).filter(file => VERIFY.has(file)))].sort();
  return { verify, native: [...native].sort() };
}

const WORKER = ['src/runner-worker.js'];
const MOVES = readdirSync(join(ROOT, 'src/moves')).filter(file => file.endsWith('.js')).map(file => `src/moves/${file}`);
const read = file => readFileSync(join(ROOT, file), 'utf8');

test('the worker and move registry reach exactly the verify files they reached before the move [C7,CD60,H16]', () => {
  assert.deepEqual(closure(WORKER, read).verify, ['src/proof-provenance.js', 'src/quarantine-verdict.js']);
  assert.deepEqual(closure(MOVES, read).verify, ['src/bar-check.js', 'src/bar-corrections.js', 'src/proof-provenance.js',
    'src/quarantine-verdict.js', 'src/required-review-family.js', 'src/review-policy.js', 'src/review-tier.js']);
  assert.ok(!closure(MOVES, read).native.includes('node:child_process'), 'the registry gained no process launcher');
});

test('the broad verify front door fails the closure control [C7,CD60,H16]', () => {
  const broad = file => file === 'src/proof-provenance.js' ? "export * from '../packages/verify/index.js';\n" : read(file);
  const reached = closure(MOVES, broad);
  assert.ok(reached.verify.length > 7, 'the broad index pulls the whole cell into the registry');
  assert.ok(reached.native.includes('node:child_process'), 'and reaches actual process launchers');
  assert.ok(closure(WORKER, broad).verify.length > 2);
});
