/** Cross-lane source edits qualify only when static imports are the sole changed tokens [L3,C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importOnlyChange } from '../../../../packages/commits/light.js';
import { submissionPaths } from '../../../../packages/sandbox/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const BIN = join(import.meta.dirname, '../../pullboard.js');

/** Create a private initialized board with independently owned core and view files. */
function nativeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-cross-lane-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shims = join(dir, 'bin'), root = join(dir, 'main'), lane = join(dir, 'lane');
  mkdirSync(shims); mkdirSync(root);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { PATH: `${shims}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Cross-lane Fixture', GIT_AUTHOR_EMAIL: 'cross-lane@example.invalid',
    GIT_COMMITTER_NAME: 'Cross-lane Fixture', GIT_COMMITTER_EMAIL: 'cross-lane@example.invalid',
    HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'board-home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home') });
  const git = (cwd, ...args) => runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  const cli = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  assert.equal(cli(root, 'init').status, 0);
  const config = { spec: 'SPEC.md', practice: 'PRACTICE.md', gate: '', lease: '2h', verify: { policy: 'any' },
    lanes: { core: { owns: ['core/'], specs: ['L3'] }, view: { owns: ['view/'], specs: ['L3'] } }, shared: [] };
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n\n## L · Limits\n- L3 [approved, must] Lanes own their paths. | gate: any\n');
  mkdirSync(join(root, 'core')); mkdirSync(join(root, 'view'));
  writeFileSync(join(root, 'core', 'file.js'), 'export const value = 1;\n');
  writeFileSync(join(root, 'view', 'test.js'), "import { value } from '../core/file.js';\nassert.equal(value, 1);\n");
  assert.equal(git(root, 'add', '-A').status, 0);
  const seeded = git(root, 'commit', '-q', '-m', 'chore: seed private fixture [L3]');
  assert.equal(seeded.status, 0, seeded.stderr);
  const base = git(root, 'rev-parse', 'HEAD').stdout.trim();
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'core/fixture', lane).status, 0);
  const joined = cli(lane, 'join', 'core', '--model', 'gpt-6-luna');
  assert.equal(joined.status, 0, joined.stderr + joined.stdout);
  return { root, lane, base, git };
}

test('only valid static import bindings and module specifiers may change [L3,C7]', () => {
  assert.equal(importOnlyChange("import { oldName } from './old.js';\nrun();\n", "import { newName } from './new.js';\nrun();\n"), true);
  assert.equal(importOnlyChange("import './old.js';\n", "import './new.js';\n"), true);
  assert.equal(importOnlyChange("import x from './x.js';\ncheck(true);\n", "import y from './y.js';\ncheck(false);\n"), false);
  assert.equal(importOnlyChange("import('./old.js');\n", "import('./new.js');\n"), false);
  assert.equal(importOnlyChange("export { value } from './old.js';\n", "export { value } from './new.js';\n"), false);
  assert.equal(importOnlyChange("import x from './x.js';\n", "import x from './x.js';\n// changed\n"), false);
  assert.equal(importOnlyChange("import x from './x.js';\n", "import { from } from './x.js';\n"), true);
  assert.equal(importOnlyChange(Buffer.from([0x69, 0x6d, 0x70, 0x6f, 0x72, 0x74, 0xff]), "import x from './x.js';"), false);
});

test('a core commit may repoint a view import, while a changed assertion is refused by line [L3,C7]', t => {
  const box = nativeFixture(t);
  const file = join(box.lane, 'view', 'test.js');
  assert.equal(box.git(box.lane, 'mv', 'core/file.js', 'core/renamed.js').status, 0);
  writeFileSync(file, "import { value } from '../core/renamed.js';\nassert.equal(value, 1);\n");
  assert.equal(box.git(box.lane, 'add', 'view/test.js').status, 0);
  const allowed = box.git(box.lane, 'commit', '-m', 'test: repoint view import [L3]');
  assert.equal(allowed.status, 0, allowed.stderr);
  const candidate = box.git(box.lane, 'rev-parse', 'HEAD').stdout.trim();
  const seen = [];
  assert.ok(submissionPaths(box.lane, { item_lane: 'core', item_claim_head: box.base,
    item_frozen: JSON.stringify({ policy: { commit: box.base } }) }, candidate,
  { mainCommit: box.base, onMechanicalPaths: paths => seen.push(...paths) }).includes('view/test.js'));
  assert.deepEqual(seen, ['view/test.js'], 'submit policy reports the cross-lane path for reviewer visibility');

  writeFileSync(file, "import { value } from '../core/renamed.js';\nassert.equal(value, 2);\n");
  assert.equal(box.git(box.lane, 'add', 'view/test.js').status, 0);
  const refused = box.git(box.lane, 'commit', '-m', 'test: alter view assertion [L3]');
  assert.notEqual(refused.status, 0, 'the installed pre-commit hook refuses the unrelated assertion edit');
  assert.match(refused.stdout + refused.stderr, /view\/test\.js.*at view\/test\.js:2/u);
});
