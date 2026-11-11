/** @pullboard-test-input source-tree */
/** @pullboard-test-input package.json */
/** @pullboard-world-pin reads this test's own source to prove it pins no digest. Move discovery reads the exact moved conflict body, keeping the accepted dependencies [C7,CD60,H16]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  join,
  posix,
} from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsIn } from '../../../../packages/gate/index.js';
import { readPathMap } from '../../../../packages/codemap/index.js';
import { workingSourceInventory } from '../../../../packages/gate/src/io/scan.js';
import { packageFiles } from '../../../../packages/runners/index.js';
import { sourceDirectories } from '../../../../packages/gate/tests/fixtures/functions.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MOVED = 'packages/merge/src/io/trunk/conflict.js';
// The reopen move reads the conflict predicate through the merge core door, which re-exports this body.
const REOPEN = 'packages/moves/src/logic/moves/reopen.js';
const CARRIAGE = 'packages/merge/src/logic/carriage.js';

/** Read the real relative closure, retaining native imports and a canonical identity for moved bodies. */
function closure(read, identities) {
  const pending = ['packages/moves/src/logic/moves', 'packages/moves/src/io/moves'].flatMap(folder => readdirSync(join(ROOT, folder)).filter(file => file.endsWith('.js'))
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

test('the conflict predicate stays on the light core door in the accepted main move closure [C7,CD60,H16]', () => {
  const sources = new Map(workingSourceInventory(ROOT, sourceDirectories(packageFiles(ROOT)))
    .map(({ file, body }) => [file, body.toString('utf8')]));
  const manifest = readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8');
  /** Read only exact finite inventory bytes, with the one explicit JSON data input retained. */
  const read = file => {
    if (file === 'package.json') return manifest;
    assert.ok(sources.has(file), `closure source belongs to the bounded inventory: ${file}`);
    return sources.get(file);
  };
  const identities = new Map([...readPathMap(ROOT)].map(([old, moved]) => [moved, old]));
  // The conflict engine is passed in by its store caller, so merge never imports the state cell and no cell cycle forms [R27].
  assert.ok(!importsIn([read(MOVED)])[0].some(specifier => /(?:^|\/)state\//u.test(specifier)), 'the moved conflict body imports nothing from the state cell');
  const before = closure(read, identities);
  assert.ok(!importsIn([read(MOVED)])[0].includes('node:child_process'), 'the moved conflict body itself imports no process launcher');
  assert.ok(before.files.includes(identities.get(CARRIAGE) ?? CARRIAGE), 'the move closure reaches the exact conflict predicate through the core door');
  assert.deepEqual(importsIn([read(CARRIAGE)])[0], [], 'the conflict predicate imports nothing, so it adds no process launcher to the move closure');
  // Other moves already reach the merge index, so a broad-index control can no longer differ; the reopen move's own merge import is pinned instead.
  assert.deepEqual(importsIn([read(REOPEN)])[0].filter(specifier => /(?:^|\/)merge\//u.test(specifier)), ['../../../../merge/light.js'],
    'the reopen move reads the merge cell only through its light core door');
});

test('clause 1: this file pins no hash digest of the live conflict body or package.json [C7,CD60,H16]', () => {
  const own = readFileSync(new URL(import.meta.url), 'utf8');
  assert.doesNotMatch(own, /\b[0-9a-f]{64}\b/u, 'no 64-hex digest literal remains');
  assert.doesNotMatch(own, new RegExp(['create' + 'Hash', 'sha' + '256'].join('|'), 'u'), 'no hashing of the live implementation body remains');
});
