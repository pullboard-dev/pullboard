/** The npm adapter: one real form over an injected spawn, one fake form over a table, one contract between them (#1429) [C7]. */
import { isAbsolute } from 'node:path';

/** The one refusal both forms raise for a relative dir or a missing cache. */
function refuse(dir, cache) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    throw Object.assign(new Error(`[NPM_CI_INPUT] npm ci runs in an absolute directory, got ${JSON.stringify(dir)}; pass an absolute path`), { name: 'Refused', code: 'NPM_CI_INPUT' });
  }
  if (typeof cache !== 'string' || cache === '') {
    throw Object.assign(new Error('[NPM_CI_INPUT] npm ci needs a cache folder; pass { cache: <absolute path> }'), { name: 'Refused', code: 'NPM_CI_INPUT' });
  }
}

/** The real form: run `npm ci --cache <cache>` in dir through the injected spawn (spawnSync shape). Returns { code, stderr }. */
export function createNpmAdapter(spawnImpl) {
  if (typeof spawnImpl !== 'function') throw new TypeError('npm adapter needs a spawn function');
  return Object.freeze({
    async ci(dir, { cache } = {}) {
      refuse(dir, cache);
      const result = await spawnImpl('npm', ['ci', '--cache', cache], { cwd: dir, encoding: 'utf8' });
      return { code: result.status ?? 1, stderr: String(result.stderr ?? '') };
    },
  });
}

/** The fake form: answers each dir from a table of { code, stderr } and answers a failure for any other dir. Returns { code, stderr }. */
export function createFakeNpmAdapter(table = {}) {
  return Object.freeze({
    async ci(dir, { cache } = {}) {
      refuse(dir, cache);
      const answer = table[dir];
      return answer ? { code: answer.code, stderr: answer.stderr } : { code: 1, stderr: 'npm ci: no project in this directory' };
    },
  });
}
