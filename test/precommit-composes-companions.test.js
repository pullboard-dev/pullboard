/** A self-hosted pre-commit runs from the staged index with the item's companions applied, never the working tree [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const HOOK_MODULE = pathToFileURL(resolve(import.meta.dirname, '../bin/hook-composed.js')).href;
const SHIM_IMPORT = "import { value } from '../web/shim.js';\nexport default value;\n";
const REPOINT = 'diff --git a/api/serve.js b/api/serve.js\n--- a/api/serve.js\n+++ b/api/serve.js\n@@ -1,2 +1,2 @@\n'
  + "-import { value } from '../web/shim.js';\n+import { value } from '../web/real.js';\n export default value;\n";

/** Capture a real successful CLI command. */
function run(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

/** Write fixture files under a checkout. */
function write(root, files) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
}

/**
 * A project that hosts its own CLI the way pullboard does: its pre-commit runs bin/pullboard.js from the checkout,
 * and that entry loads api/serve.js, which imports web/shim.js. A web item deletes the shim; its api companion
 * repoints the importer.
 */
function fixture() {
  const box = helpers.project('true');
  write(box.repo, {
    'web/real.js': 'export const value = 1;\n',
    'web/shim.js': "export * from './real.js';\n",
    'api/serve.js': SHIM_IMPORT,
    'bin/pullboard.js': `const { runComposedHook } = await import(${JSON.stringify(HOOK_MODULE)});\n`
      + 'const composed = await runComposedHook(process.argv[1], process.argv.slice(2), { cwd: process.cwd(), env: process.env });\n'
      + 'if (composed !== null) process.exit(composed);\n'
      + "await import('../api/serve.js');\n",
    '.selfhooks/pre-commit': `#!/bin/sh\nroot=$(git rev-parse --show-toplevel)\nexec "${process.execPath}" "$root/bin/pullboard.js" hook pre-commit\n`,
  });
  chmodSync(join(box.repo, '.selfhooks/pre-commit'), 0o755);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed a self-hosted entry and a shim');
  const api = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', api, '-b', 'api/one');
  const author = run(box, api, 'join', 'api').id;
  const item = run(box, box.repo, 'add', 'web', 'Delete the web shim', '--specs', 'G1').item.item_id;
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const claimed = run(box, box.web, 'claim', String(item));
  const builder = claimed.itemFolder ?? box.web;
  const source = box.git(builder, 'rev-parse', 'HEAD').trim();
  const patch = join(box.dir, 'repoint.patch');
  writeFileSync(patch, REPOINT);
  run(box, box.repo, 'patch', 'attach', String(item), patch, '--key', 'repoint', '--author', author, '--source', source);
  box.git(box.repo, 'config', 'core.hooksPath', '.selfhooks');
  return { box, builder };
}

test('a staged shim deletion commits cleanly when its attached companion repoints the importer [C7]', () => {
  const { box, builder } = fixture();
  box.git(builder, 'rm', '-q', 'web/shim.js');
  const committed = box.tryGit(builder, 'commit', '-q', '-m', 'refactor(web): delete the shim [G1]');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}${committed.failure ?? ''}`);
  assert.equal(readFileSync(join(builder, 'api/serve.js'), 'utf8'), SHIM_IMPORT, 'the importer in the working tree is untouched');
  assert.equal(box.git(builder, 'show', 'HEAD:api/serve.js').trim(), SHIM_IMPORT.trim(), 'the companion is checked, never committed');
  assert.notEqual(box.tryGit(builder, 'cat-file', '-e', 'HEAD:web/shim.js').status, 0, 'the shim deletion is committed');
});

test('control: the same entry run from the working tree crashes on the deleted shim [C7]', () => {
  const { box, builder } = fixture();
  box.git(builder, 'rm', '-q', 'web/shim.js');
  const crashed = spawnSync(process.execPath, [join(builder, 'bin/pullboard.js'), 'hook', 'pre-commit'],
    { cwd: builder, env: { ...box.env, PULLBOARD_HOOK_COMPOSED: '1' }, encoding: 'utf8' });
  assert.notEqual(crashed.status, 0);
  assert.match(crashed.stderr, /ERR_MODULE_NOT_FOUND/u);
});
