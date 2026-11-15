/** Contract: the in-process Git stand-in answers the scripted sequence journeys use exactly as real Git does [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { cleanGitEnvironment } from '../../index.js';
import { createMemoryGitAdapter } from '../../index.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';

/** Run the same scripted sequence through a `system` ({ git, write }) and return what it observed. */
function script(system) {
  const seen = [];
  let tick = 0;
  /** Run git, keep its exit status and (unless the output is prose) its stdout, and return stdout. */
  const step = (args, { keep = true, commit = false } = {}) => {
    const date = `${1_700_000_000 + tick++} +0000`;
    const env = commit ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
    const result = system.git(args, env);
    seen.push([args.join(' '), result.status, keep ? result.stdout : null]);
    return result.stdout.trim();
  };
  step(['init', '-q', '-b', 'main'], { keep: false });
  step(['config', 'user.name', 'Contract Agent'], { keep: false });
  step(['config', 'user.email', 'agent@example.test'], { keep: false });
  system.write('a.txt', 'one\n');
  system.write('web/b.txt', 'two\n');
  system.write('web/deep/c.txt', 'three\n');
  system.write('sp ace.txt', 'four\n');
  step(['add', '-A']);
  step(['commit', '-q', '-m', 'chore: set up'], { commit: true });
  const first = step(['rev-parse', 'HEAD']);
  step(['rev-parse', 'HEAD^{tree}']);
  step(['commit', '-q', '-m', 'chore: nothing to commit'], { keep: false, commit: true });
  step(['branch', 'web/one']);
  step(['branch', '--show-current']);
  step(['rev-parse', 'web/one', 'refs/heads/main']);

  step(['switch', '-q', 'web/one']);
  step(['branch', '--show-current']);
  system.write('web/b.txt', 'two changed\n');
  system.write('web/c.txt', 'new\n');
  step(['add', '-A']);
  step(['commit', '-q', '-m', 'feat(web): change [G1]'], { commit: true });
  step(['rev-parse', 'HEAD', 'HEAD^', 'HEAD^{tree}']);

  step(['switch', '-q', 'main']);
  system.write('a.txt', 'one changed\n');
  system.write('web/deep/c.txt', null);
  step(['add', '-A']);
  step(['commit', '-q', '-m', 'fix: main moves on'], { commit: true });
  step(['merge', '-q', '--ff-only', 'web/one'], { keep: false });

  step(['switch', '-q', 'web/one']);
  step(['merge', '-q', '--no-edit', 'main'], { commit: true });
  step(['rev-parse', 'HEAD', 'HEAD^1', 'HEAD^2', 'HEAD^{tree}']);
  step(['merge', '-q', '--ff-only', 'main'], { commit: true });
  step(['merge', '-q', '--no-edit', 'main'], { commit: true });

  step(['switch', '-q', 'main']);
  step(['merge', '-q', '--ff-only', 'web/one']);
  step(['rev-parse', 'HEAD', 'main', 'web/one']);
  step(['diff', '--no-renames', '--name-only', '-z', first, 'main']);
  step(['merge-base', '--is-ancestor', first, 'main'], { keep: false });
  step(['merge-base', '--is-ancestor', 'main', first], { keep: false });

  step(['switch', '-q', '-c', 'web/two']);
  system.write('web/two.txt', 'two\n');
  step(['add', '-A']);
  step(['commit', '-q', '-m', 'feat(web): second'], { commit: true });
  step(['switch', '-q', 'main']);
  system.write('a.txt', null);
  step(['add', '-A']);
  step(['commit', '-q', '-m', 'chore: drop a'], { commit: true });
  step(['merge', '-q', '--no-edit', 'web/two'], { commit: true });
  step(['rev-parse', 'HEAD', 'HEAD^2', 'HEAD^{tree}']);
  step(['diff', '--no-renames', '--name-only', '-z', first, 'HEAD']);

  step(['switch', '-q', '--detach', first]);
  step(['rev-parse', 'HEAD']);
  step(['branch', '--show-current']);
  step(['symbolic-ref', '--quiet', 'HEAD'], { keep: false });
  step(['switch', '-q', 'main']);
  step(['rev-parse', '--verify', '--quiet', 'missing'], { keep: false });
  return seen;
}

/** Real Git in a throwaway directory, with the machine's own configuration shut out. */
function realSystem(t) {
  const files = privateFixtureFiles('pullboard-git-journey-');
  const root = files.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = { ...cleanGitEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  return {
    git(args, env) {
      const done = runFixtureChild('git', args, { cwd: root, env: { ...base, ...identity(), ...env }, encoding: 'utf8' });
      return { status: done.status, stdout: done.stdout ?? '' };
    },
    write(path, body) {
      if (body === null) rmSync(join(root, path));
      else files.write(path, body);
    },
  };
}

/** The same identity for both implementations, so object ids can match. */
function identity() {
  return { GIT_AUTHOR_NAME: 'Contract Agent', GIT_AUTHOR_EMAIL: 'agent@example.test', GIT_COMMITTER_NAME: 'Contract Agent', GIT_COMMITTER_EMAIL: 'agent@example.test' };
}

/** The in-process stand-in, fed the same arguments and environment. */
function memorySystem() {
  const root = resolve('/virtual/pullboard-git-journey');
  const adapter = createMemoryGitAdapter([]);
  return {
    git(args, env) {
      const done = adapter.spawnSync(args, { cwd: root, env: { ...identity(), ...env }, encoding: 'utf8' });
      return { status: done.status, stdout: done.stdout };
    },
    write: (path, body) => adapter.write(root, path, body === null ? null : Buffer.from(body)),
  };
}

test('git.stand-in.journey-sequence: [C7] the in-process Git gives the same statuses, ids and diff names as real Git for init, commit, branch, switch, merge, rev-parse and diff', t => {
  const real = script(realSystem(t));
  const stand = script(memorySystem());
  assert.ok(real.length > 40, 'the script ran its steps');
  assert.deepEqual(stand.map(([args]) => args), real.map(([args]) => args));
  for (const [index, [args, status, stdout]] of real.entries()) {
    assert.equal(stand[index][1], status, `exit status of git ${args}`);
    assert.equal(stand[index][2], stdout, `output of git ${args}`);
  }
  assert.ok(real.some(([args, status]) => args.startsWith('merge -q --ff-only') && status !== 0), 'a diverged fast-forward refuses in both');
  assert.ok(real.some(([args, status]) => args.startsWith('commit') && status === 1), 'an empty commit refuses in both');
});

test('git.stand-in.journey-bounds: [C7] the stand-in refuses what it does not model and never guesses a clock', () => {
  const adapter = createMemoryGitAdapter([]);
  const root = resolve('/virtual/pullboard-git-bounds');
  const run = (...args) => adapter.spawnSync(args, { cwd: root, env: identity(), encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  adapter.write(root, 'a.txt', 'a\n');
  run('add', '-A');
  assert.throws(() => run('commit', '-q', '-m', 'x'), /DATE/u, 'a clock is never guessed');
  assert.throws(() => run('rebase', 'main'), { code: 'GIT_ADAPTER_UNSUPPORTED' });
  assert.throws(() => run('switch', '-q', 'main'), /uncommitted/u);
});
