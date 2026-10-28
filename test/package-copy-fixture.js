/** Commit complete shipped-source fixtures without exceeding the native staged-diff scan bound [C7]. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { copyPackageFiles } from '../src/package-files.js';

// Leave room for diff headers and one added-line marker per byte below the native 8 MiB limit.
const COMMIT_SOURCE_BYTES = 3 * 1024 * 1024;

/** Copy every manifest path and commit bounded groups through the fixture's ordinary Git hooks. */
export function copyCommittedPackageFiles(box, source) {
  const files = copyPackageFiles(source, box.repo);
  let batch = [];
  let bytes = 0;
  /** Commit only this batch, retaining hook checks and all copied paths in the final source tree. */
  function commitBatch() {
    if (!batch.length) return;
    box.git(box.repo, 'add', '--', ...batch);
    box.git(box.repo, 'commit', '-q', '-m', 'test: commit shipped fixture source');
    batch = [];
    bytes = 0;
  }
  for (const file of files) {
    const size = statSync(join(box.repo, file)).size;
    if (bytes + size > COMMIT_SOURCE_BYTES) commitBatch();
    batch.push(file);
    bytes += size;
  }
  commitBatch();
  return files;
}
