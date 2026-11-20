/** Run candidate-owned documentation generation only in the about-to-be-gated landing tree [B3,C7]. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { GENERATED_DOC_PATHS } from '../../../merge/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';
const fs = fileSystemAdapter();
/** The mechanical-conflict reader, reached through the landing front door by the pulled offer's freshness check. */
export { mechanicalConflictFiles } from '../../../merge/index.js';

/** Snapshot only known regular output files; generator output can never choose what landing stages. */
function contents(root, file) {
  const path = join(root, file);
  if (!fs.exists(path)) return null;
  if (!fs.lstat(path).isFile()) throw new Refused('LAND_MERGE', `generated documentation ${file} must be a regular file; restore it and retry landing`);
  return fs.readFile(path, null);
}

/** Refresh outputs after every merge/allocation, including clean merges that have no textual conflict. */
export function refreshLandingDocs(root) {
  if (!fs.exists(join(root, 'apps/cli/src/io/generated/docs.js')) || !fs.exists(join(root, 'docs/tools/update-docs.js'))) return [];
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
