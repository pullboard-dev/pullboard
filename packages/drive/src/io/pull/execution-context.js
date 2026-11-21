/** Measure the executable and trusted archive used by a pulled test without granting reuse [C7]. */
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../../fs/index.js';

const disk = fileSystemAdapter();
const HASH = /^[a-f0-9]{64}$/u;
const OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Hash the actual Node binary and the content-addressed archive plus exact bootstrap and entry bytes. */
export async function measureExecutionContext({ git, cwd, argv, input, executable = process.execPath, read = path => disk.readFile(path, null) }) {
  if (!git || !Array.isArray(argv) || (argv[0] !== 'node' && argv[0] !== executable)
      || !argv.every(value => typeof value === 'string') || !OBJECT.test(input?.main ?? '') || typeof input?.entry !== 'string') return null;
  try {
    // The bootstrap uses installed tooling when this marker is absent. Until that tree can be measured, it is unknown.
    const marker = await git.run(cwd, ['cat-file', '-e', `${input.main}:packages/items/index.js`]);
    if (marker.status !== 0) return null;
    const tree = await git.run(cwd, ['rev-parse', '--verify', `${input.main}^{tree}`]);
    if (tree.status !== 0 || !OBJECT.test(tree.stdout.trim())) return null;
    const runtime = createHash('sha256').update(read(executable)).digest('hex');
    // Git's tree object commits to every path, mode and blob of the archive, including nested trees.
    const tooling = createHash('sha256').update(JSON.stringify({ version: 1, archiveTree: tree.stdout.trim(), bootstrap: argv.slice(1), entry: input.entry })).digest('hex');
    return { version: 1, runtime, tooling };
  } catch { return null; }
}

/** Match only complete measurements against separately supplied, complete expected pins. */
export function matchesExecutionContext(observed, expected) {
  return observed?.version === 1 && expected?.version === 1
    && HASH.test(observed.runtime ?? '') && HASH.test(observed.tooling ?? '')
    && HASH.test(expected.runtime ?? '') && HASH.test(expected.tooling ?? '')
    && observed.runtime === expected.runtime && observed.tooling === expected.tooling;
}
