import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('items.claim.folder-identity-gone: clause 1: src/item-folder-identity.js is gone and no tracked file imports it [C7,#3554]', () => {
  const listed = spawnSync('git', ['ls-files', '--', 'src/item-folder-identity.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.stdout, '', 'the shim is deleted');
  const found = spawnSync('git', ['grep', '-l', '-E', '-e', "from[[:space:]]+['\"][^'\"]*src/item-folder-identity\\.js['\"]", '--', '*.js', ':(exclude)packages/codemap/data/plan/'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(found.status, 1, `git grep finds no importer, got ${found.status}: ${found.stdout}`);
});

test('items.claim.plan-and-edges-pass: clause 2: the cells plan check and the cells edges check pass, the edges check without the light-door cold-load measure that its own tests prove [C7,#3554]', () => {
  for (const script of ['packages/codemap/src/io/cells/scripts/plan.js', 'packages/gate/src/io/edges.js']) execFileSync(process.execPath, [script, ...(script.endsWith('plan.js') ? ['--check'] : ['--no-cold-load'])], { cwd: ROOT, stdio: 'pipe' });
});
