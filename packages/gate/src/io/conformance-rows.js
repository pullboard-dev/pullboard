/** The recorded conformance runs read for a root: the per-stage rows the compatibility page shows [C7]. */
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';
import { conformanceResults } from '../logic/conformance-setups.js';
import { conformanceSetups } from '../logic/conformance-setups.js';

/** Where a root records its conformance runs. */
export const CONFORMANCE_RUNS_FILE = '.pullboard/conformance/runs.json';

/** Whether an executable file of this name sits in one of the directories of the path value. */
function executableOn(fs, pathValue, name) {
  for (const directory of String(pathValue ?? '').split(delimiter)) {
    if (!directory) continue;
    const file = join(directory, name);
    try {
      if (!fs.stat(file).isFile()) continue;
      fs.access(file, fs.constants.X_OK);
      return true;
    } catch { /* not here; try the next directory */ }
  }
  return false;
}

/**
 * The per-language, per-stage rows for a root, from the runs recorded in its conformance runs file.
 * Why: the view has no runs feed; this names it, so every cell reads unknown until something records runs, and a toolchain missing from the path reads unavailable.
 *
 * @param {{ root: string, pathValue?: string }} options root holds .pullboard/conformance/runs.json; pathValue is the PATH the toolchain probe searches
 * @returns {{ language: string, stage: string, outcome: string, run: string | null }[]}
 */
export function conformanceRows({ root, pathValue = '' }) {
  const fs = fileSystemAdapter();
  const file = join(root, CONFORMANCE_RUNS_FILE);
  let runs = [];
  if (fs.exists(file)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFile(file)); } catch { parsed = null; }
    if (!Array.isArray(parsed)) throw new Refused('CONFORMANCE_RUNS', `${file} is not a JSON list of runs`);
    runs = parsed;
  }
  return conformanceResults(conformanceSetups(), runs, name => executableOn(fs, pathValue, name));
}
