/** First-run guidance on private Git repos, including unrelated files setup must not stage [I1,I2]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild as spawnSync, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Run setup in an isolated repository, without invoking any installed test tools. */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-newcomer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PULLBOARD_HOME: join(root, '.private-home') };
  /** Read a private Git command's result without inheriting the maintainer's configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  /** Preserve CLI output so guidance is checked exactly as a newcomer receives it. */
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  return { root, env, git, run };
}

test('init ends with a working staging line for exactly its own writes [I1,I2,D1,D2]', (t) => {
  const box = project(t);
  writeFileSync(join(box.root, '.env.local'), 'LOCAL=1\n');
  writeFileSync(join(box.root, 'notes.txt'), 'keep this out of the initial commit\n');
  writeFileSync(join(box.root, '.gitignore'), '.claude/\n');
  mkdirSync(join(box.root, '.githooks'));
  writeFileSync(join(box.root, '.githooks', 'pre-commit'), '#!/bin/sh\n# My hook\n');
  mkdirSync(join(box.root, '.claude', 'skills', 'pullboard-run'), { recursive: true });
  writeFileSync(join(box.root, '.claude', 'skills', 'pullboard-run', 'SKILL.md'), '# My existing guide\n');
  writeFileSync(join(box.root, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(box.root, 'AGENTS.md'), '# My instructions\n');
  const result = box.run('init');
  assert.equal(result.status, 0, result.stderr);
  const command = result.stdout.trimEnd().split('\n').at(-1);
  assert.match(command, /^git add -f -- /);
  const staged = spawnSync('sh', ['-c', command], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  assert.deepEqual(box.git('diff', '--cached', '--name-only').split('\n'), [
    '.claude/settings.json',
    '.claude/skills/pullboard-decompose/SKILL.md',
    '.claude/skills/pullboard-plan/SKILL.md',
    '.claude/skills/pullboard-signoff/SKILL.md',
    '.claude/skills/pullboard-spec-review/SKILL.md',
    '.claude/skills/pullboard-verify/SKILL.md',
    '.githooks/commit-msg', '.githooks/pre-merge-commit', '.githooks/pre-push',
    '.gitignore',
    'AGENTS.md', 'DOCTRINE.md', 'SPEC.md', 'pullboard.json',
  ]);
  assert.equal(readFileSync(join(box.root, '.env.local'), 'utf8'), 'LOCAL=1\n');
  assert.equal(readFileSync(join(box.root, '.githooks', 'pre-commit'), 'utf8'), '#!/bin/sh\n# My hook\n');
  box.git('reset', '-q');
  const rerun = box.run('init');
  assert.equal(rerun.status, 0, rerun.stderr);
  const secondStage = rerun.stdout.trimEnd().split('\n').at(-1);
  assert.doesNotMatch(secondStage, /^git add -f -- /, 'idempotent setup writes and stages nothing on its second run');
  assert.equal(box.git('diff', '--cached', '--name-only'), '');
});

test('init detects language gates and gives an example in the same ecosystem [I1,I2]', (t) => {
  const cases = [
    ['pyproject.toml', '[project]\nname = "example"\n', 'pytest'],
    ['pytest.ini', '', 'pytest'],
    ['setup.cfg', '[tool:pytest]\n', 'pytest'],
    ['go.mod', 'module example.test/project\n', 'go test ./...'],
    ['Cargo.toml', '[package]\nname = "example"\nversion = "0.1.0"\n', 'cargo test'],
    ['package.json', JSON.stringify({ scripts: { test: 'node --test' } }), 'npm test'],
  ];
  for (const [file, text, gate] of cases) {
    const box = project(t);
    writeFileSync(join(box.root, file), text);
    const result = box.run('init');
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).gate, gate, file);
    assert.ok(readFileSync(join(box.root, 'SPEC.md'), 'utf8').includes(`| gate: ${gate}\n`), file);
    assert.doesNotMatch(result.stdout, /no gate yet/);
  }
  const mixed = project(t);
  writeFileSync(join(mixed.root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  writeFileSync(join(mixed.root, 'go.mod'), 'module example.test/project\n');
  assert.equal(mixed.run('init').status, 0);
  assert.equal(JSON.parse(readFileSync(join(mixed.root, 'pullboard.json'), 'utf8')).gate, 'go test ./...');
});

test('bare pullboard starts with the tour and init pointer; explicit help and JSON stay usable [I1,I2]', (t) => {
  const box = project(t);
  const bare = box.run();
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout.split('\n')[0], 'New here? pullboard tour, then pullboard init.');
  assert.ok(bare.stdout.includes('pullboard next'));
  assert.ok(!box.run('help').stdout.startsWith('New here?'));
  const document = JSON.parse(box.run('--json').stdout);
  assert.equal(typeof document.help, 'string');
  assert.ok(document.help.includes('pullboard init'));
});
