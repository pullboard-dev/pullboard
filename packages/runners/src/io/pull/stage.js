/** Queue a pull job from a locally staged folder: row.json is written by a JS call here, then the folder ships whole as one tar stream [C7,#8820]. */
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pullJobId } from './scripts.js';
import { stageRunnerJob } from './scripts.js';
import { rootWord } from './scripts.js';
import { createSshAdapter } from '../adapter/ssh.js';
import { runnerStatusDir } from './ssh.js';
import { mkdirSync } from 'node:fs';

/** Every ssh call in this file goes through the ssh runner adapter. */
const sshAdapter = createSshAdapter();

/**
 * The script that receives a staged folder: stdin is its tar. The tar lands outside queue/, unpacks into queue/.tmp-<id>,
 * and the folder is renamed whole only when the tar and the input are exactly the lengths sent, as enqueueScript does.
 *
 * @param {{ root?: string }} runner
 * @param {{ id: string, frameBytes: number, tarBytes: number, agent?: string }} job
 * @returns {string} The POSIX script.
 */
export function stagedEnqueueScript(runner, { id, frameBytes, tarBytes, agent = '' }) {
  pullJobId(id);
  for (const bytes of [frameBytes, tarBytes]) if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid pull frame length');
  return `set -e
umask 077
R=${rootWord(runner)}
mkdir -p "$R/queue" "$R/running" "$R/done"
for d in queue running done; do
  if [ -e "$R/$d/${id}" ]; then echo "duplicate job ${id}" >&2; exit 4; fi
done
P="$R/.stage-${id}.tar"
T="$R/queue/.tmp-${id}"
rm -rf "$T"
cat > "$P"
N=$(wc -c < "$P" | tr -d ' ')
if [ "$N" != ${tarBytes} ]; then rm -f "$P"; echo "frame was cut short" >&2; exit 3; fi
mkdir "$T"
tar -xf "$P" -C "$T"
rm -f "$P"
N=$(wc -c < "$T/input" | tr -d ' ')
if [ "$N" != ${frameBytes} ]; then rm -rf "$T"; echo "frame was cut short" >&2; exit 3; fi
mv "$T" "$R/queue/${id}"
${agent ? `( ${agent}\n) </dev/null >/dev/null 2>&1 &\n` : ''}echo "queued ${id}"
`;
}

/** A private folder under the runner status folder, where staged jobs wait to ship. */
function stagingParent(dir = runnerStatusDir()) {
  const parent = join(dir, 'staged');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return parent;
}

/**
 * Queue one job like enqueueRunnerJob, from a staged local folder shipped whole.
 *
 * @param {{ host: string, root?: string }} runner
 * @param {{ id: string, row: object, frame: Buffer, command?: string, agent?: string, now?: number }} job
 * @param {object} [options] `ssh`, `env`, `dir` and `timeoutMs` for the ssh call.
 * @returns {Promise<void>} Settles when the runner has the folder; rejects with `RUNNER_PULL_SCRIPT`.
 */
export async function enqueueStagedJob(runner, { id, row, frame, command, agent, now }, options = {}) {
  const staged = stageRunnerJob({ id, row, frame, command, now, parent: stagingParent(options.dir) });
  try {
    const tar = `${staged.dir}.tar`;
    const made = spawnSync('tar', ['-cf', tar, '-C', staged.dir, ...staged.files], { encoding: 'utf8' });
    if (made.status !== 0) throw Object.assign(new Error(`could not stage job ${id}: ${(made.stderr ?? '').trim() || `tar status ${made.status}`}`), { code: 'RUNNER_PULL_SCRIPT', status: made.status, transport: false });
    try {
      const run = await sshAdapter.run(runner, stagedEnqueueScript(runner, { id, frameBytes: frame.length, tarBytes: statSync(tar).size, agent }), { ...options, stdin: { file: tar } });
      if (run.status !== 0 || run.error) {
        const detail = run.error ?? (run.stderr.trim().split('\n').at(-1) || `status ${run.status}`);
        throw Object.assign(new Error(`could not queue job ${id} on ${runner.host}: ${detail}`), { code: 'RUNNER_PULL_SCRIPT', status: run.status, transport: run.error !== null || run.status === 255 });
      }
    } finally { rmSync(tar, { force: true }); }
  } finally { rmSync(staged.dir, { recursive: true, force: true }); }
}
