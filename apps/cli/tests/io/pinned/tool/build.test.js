/** @pullboard-test-input apps/cli/pullboard.js */
/** Command entry reads the toolBuild policy with a single Git show [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { selectedToolEntry } from '../../../../src/io/pinned/tool/build.js';
import { toolBuildLocation } from '../../../../src/io/pinned/tool/build.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { fixtureProjectPolicy } from '../../../fixtures/testkit.js';

/** Run a command and return its trimmed output. */
function run(cwd, command, args) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

test('cli.io-pinned-tool-build.selectedtoolentry-reads-the-toolbuild-policy-with-one: clause 1: selectedToolEntry reads the toolBuild policy with one git show per command [C7]', async () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'policy-once-')));
  try {
    const repo = join(box, 'repo');
    mkdirSync(repo);
    run(repo, 'git', ['init', '-q']);
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ toolBuild: { enabled: true } }));
    run(repo, 'git', ['add', '.']);
    run(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
    run(repo, 'git', ['update-ref', 'refs/main-worktree/HEAD', 'HEAD']);
    const realGit = run(box, 'which', ['git']);
    const log = join(box, 'git.log');
    const bin = join(box, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try { await selectedToolEntry(repo, join(repo, 'apps/cli/pullboard.js')); } catch { /* no build is published: only the policy reads matter */ }
    finally { process.env.PATH = path; }
    const shows = readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('show') && line.includes('pullboard.json'));
    assert.equal(shows.length, 1);
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('cli.io-pinned-tool-build.tool-discovery-keeps-symlinked-and-explicitly-selected: tool discovery keeps symlinked and explicitly selected worktrees [C7]', () => {
  const box = privateFixtureFiles('tool-discovery-').root;
  const oldDir = process.env.GIT_DIR, oldWorkTree = process.env.GIT_WORK_TREE;
  try {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    const repo = join(box, 'repo'), nested = join(repo, 'nested'), alias = join(box, 'alias');
    mkdirSync(nested, { recursive: true });
    run(repo, 'git', ['init', '-q']);
    symlinkSync(nested, alias, 'dir');
    assert.equal(toolBuildLocation(box), null, 'a directory outside a worktree has no tool build');
    assert.equal(toolBuildLocation(alias).root, repo, 'a symlink into a worktree finds the board');
    process.env.GIT_DIR = join(repo, '.git');
    process.env.GIT_WORK_TREE = repo;
    assert.equal(toolBuildLocation(box).root, repo, 'an explicit Git selector still reaches its worktree');
  } finally {
    if (oldDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldDir;
    if (oldWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldWorkTree;
    rmSync(box, { recursive: true, force: true });
  }
});

/** A real repo whose pullboard.json holds the given toolBuild setting, with a git wrapper on PATH that logs each call. */
function loggedRepo(box, enabled) {
  const repo = join(box, 'repo');
  mkdirSync(repo);
  run(repo, 'git', ['init', '-q']);
  fixtureProjectPolicy(repo, { config: { toolBuild: { enabled } } });
  run(repo, 'git', ['add', '.']);
  run(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
  run(repo, 'git', ['update-ref', 'refs/main-worktree/HEAD', 'HEAD']);
  const log = join(box, 'git.log'), bin = join(box, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(run(box, 'which', ['git']))} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { repo, bin, calls: () => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } } };
}

/** Ask for the pinned tool build with the logging git first on PATH; returns the answer or the refusal code. */
async function ask(fixture) {
  const path = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${path}`;
  try { return await selectedToolEntry(fixture.repo, join(fixture.repo, 'apps/cli/pullboard.js')); }
  catch (error) { return error.code ?? String(error); }
  finally { process.env.PATH = path; }
}

test('cli.io-pinned-tool-build.repeat-read-no-git: clause 1: a second start at the same main tip and HEAD makes no git call and picks the same answer [C7]', async () => {
  const box = privateFixtureFiles('lookup-repeat-').root;
  try {
    const fixture = loggedRepo(box, false);
    const first = await ask(fixture);
    const spent = fixture.calls();
    assert.ok(spent > 0, 'the first start asks git');
    assert.equal(await ask(fixture), first);
    assert.equal(fixture.calls(), spent, 'the repeat start spawned no git');
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('cli.io-pinned-tool-build.tip-moves-rereads: clause 2: after main or HEAD moves the next start asks git again and picks the new answer [C7]', async () => {
  const box = privateFixtureFiles('lookup-moves-').root;
  try {
    const fixture = loggedRepo(box, false);
    /** Commit the toolBuild setting, moving HEAD and the main checkout's tip together. */
    const settle = (enabled) => {
      fixtureProjectPolicy(fixture.repo, { config: { toolBuild: { enabled } } });
      run(fixture.repo, 'git', ['add', '.']);
      run(fixture.repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', String(enabled)]);
      run(fixture.repo, 'git', ['update-ref', 'refs/main-worktree/HEAD', 'HEAD']);
    };
    assert.equal(await ask(fixture), null);
    const first = fixture.calls();
    settle(true);
    assert.equal(await ask(fixture), 'TOOL_BUILD_REQUIRED', 'the moved tip is read again and now requires a build');
    const second = fixture.calls();
    assert.ok(second > first, 'the moved tip asked git again');
    settle(false);
    assert.equal(await ask(fixture), null, 'the next move is read again and picks the new answer');
    const third = fixture.calls();
    assert.ok(third > second, 'the second move asked git again');
    assert.equal(await ask(fixture), null);
    assert.equal(fixture.calls(), third, 'an unmoved start reuses the answer');
  } finally { rmSync(box, { recursive: true, force: true }); }
});
