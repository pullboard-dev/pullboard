/** The folder throwaway work goes under for cells below config: PULLBOARD_SCRATCH, else os.tmpdir() [C7]. */
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { Refused } from './refused.js';

/**
 * The scratch root a low cell uses. The CLI resolves the `scratch` machine setting into PULLBOARD_SCRATCH once per command,
 * so a cell that cannot import config still lands under the setting.
 * Why a second reader: config sits above these cells in the order, so they cannot import its scratchRoot [C7].
 *
 * @param {Record<string, string | undefined>} [env] - Environment, defaulting to process.env.
 * @returns {string} The realpath of the named root, or os.tmpdir() when none is named.
 */
export function scratchBase(env = process.env) {
  const named = env.PULLBOARD_SCRATCH;
  if (!named) return tmpdir();
  if (!isAbsolute(named) || !existsSync(named) || !statSync(named).isDirectory()) {
    throw new Refused('BAD_SCRATCH_ROOT', `scratch ${named} is not an existing absolute folder; create it, or run pullboard settings scratch <absolute folder> to name another, or remove it to use ${tmpdir()}`);
  }
  return realpathSync(named);
}
