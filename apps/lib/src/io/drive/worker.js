#!/usr/bin/env node
/** The hand-off worker as a child that runs the drive cell's drainLoop on one job until its terminal step [C7]. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  closeBoard,
  openBoard,
} from '../../../index.js';
import { drainLoop } from '../../../../../packages/drive/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { createTransport } from '../../../../../packages/transport/index.js';
import { sharedTransport } from '../../../../../packages/transport/index.js';

const ENTRY = fileURLToPath(import.meta.url);

/**
 * Start a drive worker child for one job. The child opens the board file, calls driveOnce until the job reaches its
 * verdict, prints one `step <phase> <transition>` line per drive and exits 0; it exits 3 when another driver holds
 * the job's live lease.
 *
 * Why: the worker holds no state of its own, so its death loses nothing: a child respawned with the same owner
 * renews the lease and continues from the job's last written step, and after 2 minutes any driver can.
 *
 * With `local: true` the runner is this machine: the shard runs under a local `sh` with the worker's environment,
 * through the same result-file protocol a remote runner uses. The submit hand-off worker runs its gate this way.
 *
 * @param {{ file: string, job: string, owner: string, repo?: string, runner?: { host: string, root?: string },
 *   plan?: { shard: string, command: string }[], intervalMs?: number, local?: boolean }} options
 * @param {{ env?: NodeJS.ProcessEnv, stdio?: import('node:child_process').StdioOptions }} [spawnOptions]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnDriveWorker(options, { env = environmentAdapter().all(), stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  for (const field of ['file', 'job', 'owner']) {
    if (typeof options?.[field] !== 'string' || !options[field]) throw new Refused('DRIVE_WORKER', `a drive worker needs { ${field} }: pass the board file, the job id and the driver id`);
  }
  return spawn(process.execPath, [ENTRY, JSON.stringify(options)], { env, stdio });
}

/**
 * The transport a child drives through: this machine's own `sh` for a local runner, else the shared SSH transport.
 *
 * @param {boolean} local
 * @returns {ReturnType<typeof createTransport>}
 */
function workerTransport(local) {
  if (!local) return sharedTransport();
  const sh = () => spawn('sh', [], { env: environmentAdapter().all(), stdio: ['pipe', 'pipe', 'pipe'] });
  return createTransport({ open: sh, launch: (runner, script) => spawn('sh', ['-c', script], { env: environmentAdapter().all(), stdio: ['ignore', 'pipe', 'pipe'] }) });
}

/**
 * The child's body: open the board, drain the job, close the runner channels and the board, and set the exit code.
 *
 * @param {string} argument - The JSON options spawnDriveWorker passed.
 * @returns {Promise<void>}
 */
async function main(argument) {
  const { file, job, local = false, ...options } = JSON.parse(argument ?? '{}');
  if (local) options.tooling = false;
  const board = openBoard(file);
  const transport = workerTransport(local);
  try {
    const last = await drainLoop(board.db, job, { ...options, transport,
      onStep: result => process.stdout.write(`step ${result.phase} ${result.transition ?? '-'}\n`) });
    process.exitCode = last.code === 'JOB_LEASED' ? 3 : 0;
  } finally {
    transport.close();
    closeBoard(board);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
