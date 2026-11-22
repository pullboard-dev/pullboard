/** @pullboard-test-input source-cell packages/config */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fileSystemAdapter } from '../../../fs/index.js';
import { Refused } from '../../../kernel/browser.js';
import { observeColdClosure } from '../fixtures/scratch-imports.js';
import { scratchRoot } from '../../src/logic/scratch.js';

const source = new URL('../../src/logic/scratch.js', import.meta.url).href;
const kernelLight = new URL('../../../kernel/light.js', import.meta.url).href;
const fs = fileSystemAdapter();

/** Observe the real child graph before inherited preloads, retaining their complete environment. */
function observeClosure() {
  const { loaded, reachable } = observeColdClosure(source, privateFixtureFiles('pullboard-config-scratch-imports-'));
  assert.ok(loaded.includes(source), 'the exact production entry was loaded');
  for (const url of reachable) assert.ok(loaded.includes(url), `reachable module was observed: ${url}`);
  return reachable;
}

test('config.logic-scratch-root.cold-closure: scratchRoot avoids the broad kernel light door [C7]', t => {
  const reachable = observeClosure();
  t.diagnostic(JSON.stringify({ entry: source, count: reachable.length, reachable }));
  assert.ok(!reachable.includes(kernelLight), 'the actual source-rooted closure excludes kernel/light.js');
});

test('config.logic-scratch-root.paths: defaults and existing absolute roots retain their paths [C7]', () => {
  const files = privateFixtureFiles('pullboard-config-scratch-paths-');
  assert.equal(scratchRoot(undefined, {}), tmpdir());
  assert.equal(scratchRoot({ scratch: '' }, {}), tmpdir());
  assert.equal(scratchRoot({ scratch: files.root }, {}), fs.realpath(files.root));
  assert.equal(scratchRoot(undefined, { PULLBOARD_SCRATCH: files.root }), fs.realpath(files.root));
  assert.equal(scratchRoot({ scratch: files.root }, { PULLBOARD_SCRATCH: 'ignored-relative' }), fs.realpath(files.root));
  const alias = join(files.root, 'alias');
  fs.symlink(files.root, alias, 'dir');
  assert.equal(scratchRoot({ scratch: alias }, {}), fs.realpath(files.root));
});

test('config.logic-scratch-root.policy-refusals: invalid roots retain their refusal code and identity [C7]', () => {
  const files = privateFixtureFiles('pullboard-config-scratch-refusals-');
  files.write('not-a-directory', 'fixture');
  for (const scratch of ['relative', join(files.root, 'missing'), join(files.root, 'not-a-directory'), 12]) {
    assert.throws(() => scratchRoot({ scratch }, {}), error => {
      assert.ok(error instanceof Refused);
      assert.equal(error.code, 'BAD_SCRATCH_ROOT');
      assert.match(error.message, /scratch/u);
      return true;
    });
  }
});
