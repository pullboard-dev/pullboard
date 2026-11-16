/** What `pullboard --version` answers when a git hook asks, so hooks one release back keep running (#7760, R4). */
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { hookStanding } from '../../../../../packages/commits/light.js';

/**
 * The version a hook's probe is told. A hook script refuses any binary whose version differs from its own `want`,
 * and a script written by the last release cannot be changed, so inside a git hook (git always sets GIT_EXEC_PATH
 * there; a person's shell does not) a repo whose installed hooks are exactly one release back hears their own
 * version and goes on to run this release's rules. Anything else, including every ordinary call, gets the truth.
 *
 * @param {string} release This release.
 * @param {{ cwd: string, env: Record<string, string | undefined> }} where
 * @returns {string}
 */
export function hookProbeVersion(release, { cwd, env }) {
  if (!env.GIT_EXEC_PATH) return release;
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    const hooks = join(folder, '.githooks');
    if (existsSync(hooks)) {
      const scripts = readdirSync(hooks).map((name) => { try { return readFileSync(join(hooks, name), 'utf8'); } catch { return ''; } });
      const standing = hookStanding(release, scripts);
      return standing.state === 'accepted' ? standing.versions[0] : release;
    }
    if (dirname(folder) === folder) return release;
  }
}
