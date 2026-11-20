/** Stage the shared test registries a landing derives from what the item merge moved, so no lane hand-edits them [C7,V24]. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git } from '../../../git/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

const SCRIPT = 'packages/gate/src/io/test/scripts/registries.js';

/**
 * Rebuild the test registries in the merged tree and stage the ones that changed.
 * Why: the deriver runs as the gate's own script in a child process, so no landing module imports the gate door and reaches the CLI through it.
 * A tree whose gate has no such script has nothing to derive.
 * @param {string} root A checkout of the merged tree.
 * @param {string} [base] The commit the merge started from.
 * @param {string} [script] The deriver to run; the tree's own gate script by default.
 * @returns {Promise<string[]>} The staged registry files.
 */
export async function stageTestRegistries(root, base = 'HEAD^1', script = join(root, SCRIPT)) {
  if (!fs.exists(script)) return [];
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--base', base], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const registries = JSON.parse(stdout.trim().split('\n').at(-1));
  if (registries.length) git(root, ['add', '--', ...registries]);
  return registries;
}
