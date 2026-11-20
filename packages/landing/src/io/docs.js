/** Run candidate-owned documentation generation only in the about-to-be-gated landing tree [B3,C7]. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { GENERATED_DOC_PATHS } from '../../../merge/index.js';
/** The mechanical-conflict reader, reached through the landing front door by the pulled offer's freshness check. */
export { mechanicalConflictFiles } from '../../../merge/index.js';

/** Snapshot only known regular output files; generator output can never choose what landing stages. */
function contents(root, file) {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Refused('LAND_MERGE', `generated documentation ${file} must be a regular file; restore it and retry landing`);
  return readFileSync(path);
}

/** Refresh outputs after every merge/allocation, including clean merges that have no textual conflict. */
export function refreshLandingDocs(root) {
  if (!existsSync(join(root, 'apps/cli/src/io/generated/docs.js')) || !existsSync(join(root, 'docs/tools/update-docs.js'))) return [];
  const before = new Map(GENERATED_DOC_PATHS.map(file => [file, contents(root, file)]));
  const result = spawnSync(process.execPath, ['docs/tools/update-docs.js'], {
    cwd: root, env: cleanGitEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Refused('LAND_MERGE', 'node docs/tools/update-docs.js failed in the merged tree; repair its source declarations and retry landing');
  return GENERATED_DOC_PATHS.filter(file => {
    const after = contents(root, file), previous = before.get(file);
    if (after === null) throw new Refused('LAND_MERGE', `documentation generator omitted ${file}; repair the generator and retry landing`);
    return previous === null || !previous.equals(after);
  });
}
