/** Synthetic Git commits must survive different invoking identities (I13,A10). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXED_TIME, isolatedEnv } from './demo-env.mjs';

test('demo Git commits reproduce across homes and inherited emails [I13,A10]', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pullboard-demo-identity-'));
  const commits = [];
  try {
    for (const name of ['first', 'second']) {
      const repo = join(base, name);
      await mkdir(repo);
      const env = isolatedEnv(join(base, name + '-home'), join(base, 'clock.mjs'), {
        ...process.env, EMAIL: name + '@ambient.invalid',
        GIT_AUTHOR_EMAIL: name + '@author.invalid', GIT_COMMITTER_EMAIL: name + '@committer.invalid',
      });
      /** Run actual Git with the same environment as the disposable demo. */
      const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', name + '@config.invalid');
      await writeFile(join(repo, 'demo.txt'), 'The same synthetic board.\n');
      git('add', 'demo.txt');
      git('commit', '-q', '-m', 'chore: initialize demo board');
      const identity = git('show', '-s', '--format=%an|%ae|%cn|%ce|%aI|%cI');
      assert.equal(identity, 'Pullboard demo|demo@pullboard.invalid|Pullboard demo|demo@pullboard.invalid|' +
        FIXED_TIME.replace('.000Z', 'Z') + '|' + FIXED_TIME.replace('.000Z', 'Z'));
      commits.push(git('rev-parse', 'HEAD'));
    }
    assert.equal(commits[0], commits[1], 'home, inherited EMAIL and local Git identity cannot change the demo commit');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
