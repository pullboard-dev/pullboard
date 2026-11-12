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
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { selectedToolEntry } from '../../../../src/io/pinned/tool/build.js';

/** Run a command and return its trimmed output. */
function run(cwd, command, args) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

test('clause 1: selectedToolEntry reads the toolBuild policy with one git show per command [C7]', async () => {
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
