/** The scratch root: one place for all throwaway folders, os.tmpdir() when unset [C7]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { Refused } from '../../../kernel/light.js';
import { environmentAdapter } from '../../../env/index.js';

const fs = fileSystemAdapter();

/**
 * The folder throwaway work goes under: the `scratch` machine setting, else PULLBOARD_SCRATCH, else os.tmpdir().
 * Why refuse a relative or missing root: a throwaway folder that lands somewhere the person did not name, or
 * is silently recreated elsewhere, would hide what filled their disk.
 *
 * @param {{ scratch?: unknown } | null | undefined} [settings] - Parsed machine settings.
 * @param {Record<string, string | undefined>} [env] - Environment, defaulting to process.env.
 * @returns {string} The realpath of the named root, or os.tmpdir() when neither is set.
 */
export function scratchRoot(settings, env) {
  const named = settings?.scratch ?? (environmentAdapter(env).get('PULLBOARD_SCRATCH') || undefined);
  if (named === undefined || named === '') return tmpdir();
  if (typeof named !== 'string' || !isAbsolute(named)) {
    throw new Refused('BAD_SCRATCH_ROOT', `scratch must be an absolute folder path, got ${JSON.stringify(named)}; run pullboard settings scratch <absolute folder>, or remove it to use ${tmpdir()}`);
  }
  if (!fs.exists(named) || !fs.stat(named).isDirectory()) {
    throw new Refused('BAD_SCRATCH_ROOT', `scratch ${named} is not an existing folder; create it, or run pullboard settings scratch <absolute folder> to name another, or remove it to use ${tmpdir()}`);
  }
  return fs.realpath(named);
}
