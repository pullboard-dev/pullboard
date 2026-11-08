/** @pullboard-test-input source-tree */
/** @pullboard-test-input package.json */
/** Exact-body verify shims keep the runner worker and move registry closures unchanged [C7,CD60,H16]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsIn } from '../packages/gate/index.js';
import { readPathMap } from '../packages/codemap/index.js';
import { MOVE_CANDIDATE, MOVE_FILE, discovered } from '../packages/kernel/index.js';
import { workingSourceInventory } from '../bin/checks/scan.js';
import { packageFiles } from '../packages/runners/index.js';
import { sourceDirectories } from './machine-source-functions.fixture.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERIFY = new Map([...readPathMap(ROOT)].filter(([, moved]) => moved.startsWith('packages/verify/')));
const IDENTITY = new Map([...VERIFY].map(([old, moved]) => [moved, old]));

/** Follow only literal relative imports from the entries; report the verify files and native modules reached, and which verify files import a process launcher. */
function closure(entries, read) {
  const pending = [...entries], seen = new Set(), native = new Set(), launchers = new Set();
  while (pending.length) {
    const file = pending.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[cm]?js$/u.test(file)) continue;
    for (const specifier of importsIn([read(file)])[0]) {
      // A computed specifier is a runtime loader that names modules from a directory listing, not a literal import.
      if (specifier === '(computed)') continue;
      if (specifier.startsWith('node:') || specifier === 'child_process') {
        native.add(specifier);
        if (/^(node:)?child_process$/u.test(specifier) && VERIFY.has(IDENTITY.get(file) ?? file)) launchers.add(IDENTITY.get(file) ?? file);
      } else {
        assert.ok(specifier.startsWith('.'), `literal relative dependency: ${specifier}`);
        pending.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
      }
    }
  }
  const verify = [...new Set([...seen].map(file => IDENTITY.get(file) ?? file).filter(file => VERIFY.has(file)))].sort();
  return { verify, native: [...native].sort(), launchers: [...launchers].sort() };
}

const WORKER = ['src/runner-worker.js'];
const MOVES = ['packages/moves/src/core/moves', 'packages/moves/src/shell/moves'].flatMap(folder => discovered(readdirSync(join(ROOT, folder)), MOVE_CANDIDATE, MOVE_FILE, 'move').map(file => `${folder}/${file}`));
const SOURCES = new Map(workingSourceInventory(ROOT, sourceDirectories(packageFiles(ROOT))).map(({ file, body }) => [file, body.toString('utf8')]));
/** Read only the bounded working inventory, never a path outside it. */
const read = file => {
  assert.ok(SOURCES.has(file), `closure source belongs to the bounded inventory: ${file}`);
  return SOURCES.get(file);
};

test('clause 1: no module the worker and move registry reach imports child_process, whatever verify files they reach [C7,CD60,H16]', () => {
  assert.ok(closure(WORKER, read).verify.length > 0, 'the walk reaches verify files, so the bar below is not vacuous');
  assert.ok(closure(MOVES, read).verify.length > 0, 'the walk reaches verify files from the move registry too');
  assert.deepEqual(closure(WORKER, read).launchers, [], 'no verify file reachable from the worker imports child_process');
  assert.deepEqual(closure(MOVES, read).launchers, [], 'no verify file reachable from the move registry imports child_process');
});

test('clause 1: a stub module that imports child_process is reported by the closure walk [C7,CD60,H16]', () => {
  const stub = file => file === 'packages/verify/src/core/proof-provenance.js' ? "import { spawn } from 'node:child_process';\nexport const launch = spawn;\n" : read(file);
  assert.ok(closure(MOVES, stub).launchers.length > 0, 'an injected child_process import in a verify module is reported');
  assert.ok(closure(WORKER, stub).launchers.length > 0, 'the worker walk reports it too');
});

test('the broad verify front door fails the closure control [C7,CD60,H16]', () => {
  const broad = file => file === 'packages/verify/src/core/proof-provenance.js' ? "export * from '../../index.js';\n" : SOURCES.has(file) ? read(file) : '';
  const reached = closure(MOVES, broad);
  assert.ok(reached.verify.length > 7, 'the broad index pulls the whole cell into the registry');
  assert.ok(reached.native.includes('node:child_process'), 'and reaches actual process launchers');
  assert.ok(closure(WORKER, broad).verify.length > 2);
});
