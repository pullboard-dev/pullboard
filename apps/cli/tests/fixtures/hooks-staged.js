/** The private staged-diff repository both hook journey files share [S1]. */
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFixtureGit } from './child.js';

/** Make a private real repository for staged-diff hook tests, with cleanup tied to the test. */
export function stagedRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-staged-diff-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Run Git only in this fixture, without the maintainer's identity or configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  return { root, git };
}
