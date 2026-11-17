import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';

/**
 * Copy each phase's timing profile JSON into the job's kept folder as a plain file, and name it on the row as
 * `profileKept`. The kept file keeps the profile's own name, which the gate already makes unique per phase, so no
 * second naming scheme exists. A row with no profile, or whose profile file has vanished, comes back unchanged.
 * Why a copy: the profile lives in the job's scratch folder, which is removed after the job, while the kept folder
 * is what the board reads back [C7].
 *
 * @param {string} folder - The job's kept folder.
 * @param {Array<{ profilePath?: string }>} phases - The phase rows, each maybe with a profilePath.
 * @returns {Array<object>} The rows, with profileKept set on those whose profile was copied.
 */
export function keepPhaseProfiles(folder, phases) {
  return (Array.isArray(phases) ? phases : []).map(phase => {
    const source = phase?.profilePath;
    if (typeof source !== 'string' || !source || !existsSync(source)) return phase;
    const name = basename(source);
    try { copyFileSync(source, join(folder, name)); } catch { return phase; }
    return { ...phase, profileKept: name };
  });
}
