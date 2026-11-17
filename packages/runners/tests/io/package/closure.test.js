/** @pullboard-test-input source-cell packages/resources packages/runners */
/** The hand-off folder prune carries a complete runner import closure [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runnerPackage } from '../../../src/io/package.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const prune = 'packages/resources/src/io/handoff/prune.js';

test('runners.closure.handoff-folder-prune-js-opens-the: clause 1: handoff-folder-prune.js opens the database through a static node:sqlite import, not createRequire [C7]', () => {
  const source = readFileSync(resolve(root, prune), 'utf8');
  assert.match(source, /import \{ DatabaseSync \} from 'node:sqlite';/u);
  assert.doesNotMatch(source, /createRequire/u);
  assert.match(source, /new DatabaseSync\(file, \{ readOnly: true \}\)/u);
});

test('runners.closure.the-runner-package-closure-for-handoff: clause 2: the runner package closure for handoff-folder-prune.js resolves with no unavailable file [C7]', () => {
  const { files } = runnerPackage(root, prune);
  assert.ok(Object.hasOwn(files, prune));
});
