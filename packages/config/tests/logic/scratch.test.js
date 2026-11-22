/** @pullboard-test-input source-cell packages/config packages/kernel packages/fs packages/env */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fileSystemAdapter } from '../../../fs/index.js';
import { privateFixtureFiles } from '../../../git/tests/fixtures/child.js';
import { runFixtureChild } from '../../../git/tests/fixtures/child.js';
import { Refused } from '../../../kernel/browser.js';
import { scratchRoot } from '../../src/logic/scratch.js';

const source = new URL('../../src/logic/scratch.js', import.meta.url).href;
const kernelLight = new URL('../../../kernel/light.js', import.meta.url).href;
const fs = fileSystemAdapter();

/** Observe the real child graph before inherited preloads, retaining their complete environment. */
function observeClosure() {
  const files = privateFixtureFiles('pullboard-config-scratch-imports-');
  files.write('observe.mjs', `
import { registerHooks } from 'node:module';
const edges = [];
const loaded = new Set();
globalThis.pullboardScratchImportObservation = { edges, loaded };
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    edges.push([context.parentURL ?? null, result.url]);
    return result;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    loaded.add(url);
    return result;
  },
});
`);
  const observer = pathToFileURL(join(files.root, 'observe.mjs')).href;
  const env = { ...process.env, NODE_OPTIONS: `--import=${observer} ${process.env.NODE_OPTIONS ?? ''}` };
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', `
await import(${JSON.stringify(source)});
const { edges, loaded } = globalThis.pullboardScratchImportObservation;
process.stdout.write(JSON.stringify({ edges, loaded: [...loaded] }));
`], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.context);
  assert.equal(result.signal, null, result.context);
  const observed = JSON.parse(result.stdout);
  const reachable = new Set([source]);
  let size;
  do {
    size = reachable.size;
    for (const [parent, child] of observed.edges) {
      if (reachable.has(parent) && child.startsWith('file:')) reachable.add(child);
    }
  } while (size !== reachable.size);
  assert.ok(observed.loaded.includes(source), 'the exact production entry was loaded');
  for (const url of reachable) assert.ok(observed.loaded.includes(url), `reachable module was observed: ${url}`);
  return [...reachable].sort();
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
