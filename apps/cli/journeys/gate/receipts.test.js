/** The pre-commit lane guard recognizes accepted-main changes staged without MERGE_HEAD [L3,C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const BIN = join(import.meta.dirname, '../../pullboard.js');

/** Create isolated main and core worktrees with Pullboard's real installed commit hooks. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-precommit-merged-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shims = join(dir, 'bin'), main = join(dir, 'main'), lane = join(dir, 'lane');
  mkdirSync(shims);
  mkdirSync(main);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Merged Main Fixture', GIT_AUTHOR_EMAIL: 'merged-main@example.invalid',
    GIT_COMMITTER_NAME: 'Merged Main Fixture', GIT_COMMITTER_EMAIL: 'merged-main@example.invalid',
    HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'board-home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  });
  const git = (cwd, ...args) => runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  const cli = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(git(main, 'init', '-q', '-b', 'main').status, 0);
  assert.equal(cli(main, 'init').status, 0, 'the native CLI initializes the private fixture and installs hooks');
  writeFileSync(join(main, 'pullboard.json'), JSON.stringify({
    spec: 'SPEC.md', practice: 'PRACTICE.md', gate: '', lease: '2h', verify: { policy: 'any' },
    lanes: { core: { owns: ['core/'], specs: ['L3'] }, view: { owns: ['view/'], specs: ['L3'] } }, shared: [],
  }, null, 2));
  writeFileSync(join(main, 'SPEC.md'), '# Fixture\n\n## L · Limits\n- L3 [approved, must] Lane ownership is enforced. | gate: any\n');
  mkdirSync(join(main, 'core'));
  mkdirSync(join(main, 'view'));
  writeFileSync(join(main, 'core', 'file.js'), 'export const owned = true;\n');
  writeFileSync(join(main, 'view', 'file.js'), 'export const accepted = false;\n');
  assert.equal(git(main, 'add', '-A').status, 0);
  const seed = git(main, 'commit', '-q', '-m', 'chore: seed the private fixture [L3]');
  assert.equal(seed.status, 0, seed.stderr);
  assert.equal(git(main, 'worktree', 'add', '-q', '-b', 'core/fixture', lane).status, 0);
  const joined = cli(lane, 'join', 'core', '--model', 'gpt-6-luna', '--family', 'openai');
  assert.equal(joined.status, 0, joined.stderr + joined.stdout);
  return { main, lane, git };
}

/** Stage a change on main that the lane integrates without creating MERGE_HEAD. */
function squashAcceptedMain(box) {
  writeFileSync(join(box.main, 'view', 'file.js'), 'export const accepted = true;\n');
  assert.equal(box.git(box.main, 'add', 'view/file.js').status, 0);
  const mainCommit = box.git(box.main, 'commit', '-q', '-m', 'chore: accepted main change [L3]');
  assert.equal(mainCommit.status, 0, mainCommit.stderr);
  const squash = box.git(box.lane, 'merge', '--squash', 'main');
  assert.equal(squash.status, 0, squash.stderr + squash.stdout);
  assert.notEqual(box.git(box.lane, 'rev-parse', '--verify', 'MERGE_HEAD').status, 0,
    'squash integration leaves no merge-head marker for the hook to inspect');
  writeFileSync(join(box.lane, 'core', 'file.js'), 'export const owned = false;\n');
  assert.equal(box.git(box.lane, 'add', 'core/file.js').status, 0);
}

test('a lane may commit an accepted-main squash together with its own change [L3,C7]', t => {
  const box = fixture(t);
  squashAcceptedMain(box);
  const commit = box.git(box.lane, 'commit', '-m', 'feat(core): keep accepted main change [L3]');
  assert.equal(commit.status, 0, `${commit.stderr}\n${commit.stdout}`);
});

test('the accepted-main allowance does not permit a builder edit to the same foreign file [L3,C7]', t => {
  const box = fixture(t);
  squashAcceptedMain(box);
  writeFileSync(join(box.lane, 'view', 'file.js'), 'export const accepted = false;\nexport const builder = true;\n');
  assert.equal(box.git(box.lane, 'add', 'view/file.js').status, 0);
  const commit = box.git(box.lane, 'commit', '-m', 'feat(core): alter a foreign file [L3]');
  assert.notEqual(commit.status, 0, 'the real installed pre-commit hook refuses the changed foreign object');
  assert.match(commit.stdout + commit.stderr, /outside the core lane: view\/file\.js/u);
});

/** Create the mixed accepted-main and deleted-shim case seen in the archived #1673 merge. */
function mixedMainAndShim(t) {
  const box = fixture(t);
  writeFileSync(join(box.main, 'core', 'new.js'), 'export const value = 1;\n');
  writeFileSync(join(box.main, 'core', 'old.js'), "export { value } from '../../../../packages/gate/tests/io/new.js';\n");
  writeFileSync(join(box.main, 'view', 'file.js'), "import { value } from '../../../../packages/gate/tests/core/old.js';\nexport const accepted = value;\n");
  assert.equal(box.git(box.main, 'add', '-A').status, 0);
  assert.equal(box.git(box.main, 'commit', '-q', '-m', 'chore: add forwarding shim [L3]').status, 0);
  assert.equal(box.git(box.lane, 'merge', '--ff-only', 'main').status, 0);
  assert.equal(box.git(box.lane, 'rm', 'core/old.js').status, 0);
  assert.equal(box.git(box.lane, 'commit', '-q', '-m', 'feat(core): remove shim [L3]').status, 0);
  writeFileSync(join(box.main, 'view', 'file.js'), "import { value } from '../../../../packages/gate/tests/core/old.js';\nexport const accepted = value;\nexport const mainChange = true;\n");
  assert.equal(box.git(box.main, 'add', 'view/file.js').status, 0);
  assert.equal(box.git(box.main, 'commit', '-q', '-m', 'chore: change view on main [L3]').status, 0);
  const merge = box.git(box.lane, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(merge.status, 0, merge.stderr + merge.stdout);
  writeFileSync(join(box.lane, 'view', 'file.js'), "import { value } from '../../../../packages/gate/tests/core/new.js';\nexport const accepted = value;\nexport const mainChange = true;\n");
  assert.equal(box.git(box.lane, 'add', 'view/file.js').status, 0);
  return box;
}

test('a merge accepts main lines plus the deleted-shim import repoint [L3,C7]', t => {
  const box = mixedMainAndShim(t);
  const commit = box.git(box.lane, 'commit', '-m', 'feat(core): merge accepted main [L3]');
  assert.equal(commit.status, 0, commit.stderr + commit.stdout);
});

test('a merge still refuses a builder edit beside the deleted-shim import repoint [L3,C7]', t => {
  const box = mixedMainAndShim(t);
  writeFileSync(join(box.lane, 'view', 'file.js'), "import { value } from '../../../../packages/gate/tests/core/new.js';\nexport const accepted = value;\nexport const mainChange = true;\nexport const foreignEdit = true;\n");
  assert.equal(box.git(box.lane, 'add', 'view/file.js').status, 0);
  const commit = box.git(box.lane, 'commit', '-m', 'feat(core): edit a foreign file [L3]');
  assert.notEqual(commit.status, 0);
  assert.match(commit.stdout + commit.stderr, /outside the core lane: view\/file\.js/u);
});

/** A lane and main both change core/file.js, and main also adds more text than the scan limit allows. */
function bigTrunkMerge(t) {
  const box = fixture(t);
  writeFileSync(join(box.lane, 'core', 'file.js'), 'export const owned = "lane";\n');
  assert.equal(box.git(box.lane, 'commit', '-qam', 'feat(core): lane change [L3]').status, 0);
  writeFileSync(join(box.main, 'core', 'file.js'), 'export const owned = "main";\n');
  // Each commit stays under the scan limit on main; together they pass it.
  for (const part of [1, 2, 3]) {
    writeFileSync(join(box.main, 'view', `big-${part}.txt`), `part ${part}\n${'ordinary text\n'.repeat(250_000)}`);
    assert.equal(box.git(box.main, 'add', '-A').status, 0);
    const moved = box.git(box.main, 'commit', '-q', '-m', 'chore: trunk moves a lot [L3]');
    assert.equal(moved.status, 0, moved.stderr + moved.stdout);
  }
  const merge = box.git(box.lane, 'merge', '--no-commit', '--no-ff', 'main');
  assert.notEqual(merge.status, 0, 'core/file.js conflicts');
  return box;
}

test('clause 1: a merge of a trunk that moved past the scan limit scans only the small resolution [L3,C7]', t => {
  const box = bigTrunkMerge(t);
  writeFileSync(join(box.lane, 'core', 'file.js'), 'export const owned = "both";\n');
  assert.equal(box.git(box.lane, 'add', '-A').status, 0);
  const commit = box.git(box.lane, 'commit', '-m', 'feat(core): merge main [L3]');
  assert.equal(commit.status, 0, commit.stderr + commit.stdout);
});

test('clause 1: a merge resolution that itself exceeds the scan limit is still refused [L3,C7]', t => {
  const box = bigTrunkMerge(t);
  writeFileSync(join(box.lane, 'core', 'file.js'), 'ordinary text\n'.repeat(700_000));
  assert.equal(box.git(box.lane, 'add', '-A').status, 0);
  const commit = box.git(box.lane, 'commit', '-m', 'feat(core): merge main [L3]');
  assert.notEqual(commit.status, 0);
  assert.match(commit.stdout + commit.stderr, /DIFF_TOO_LARGE/u);
});

test('clause 1: a merge whose trunk added past the scan limit to a file the lane also changed passes [L3,C7]', t => {
  const box = fixture(t);
  const laneFile = join(box.lane, 'core', 'file.js');
  writeFileSync(laneFile, '// lane\n' + readFileSync(laneFile, 'utf8'));
  assert.equal(box.git(box.lane, 'commit', '-qam', 'feat(core): lane change [L3]').status, 0);
  for (const part of [1, 2, 3]) {
    const file = join(box.main, 'core', 'file.js');
    writeFileSync(file, readFileSync(file, 'utf8') + `part ${part}\n${'ordinary text\n'.repeat(250_000)}`);
    assert.equal(box.git(box.main, 'commit', '-qam', 'chore: trunk grows the file [L3]').status, 0);
  }
  const merge = box.git(box.lane, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(merge.status, 0, merge.stderr + merge.stdout);
  const commit = box.git(box.lane, 'commit', '-m', 'feat(core): merge main [L3]');
  assert.equal(commit.status, 0, commit.stderr + commit.stdout);
});
