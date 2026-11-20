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
