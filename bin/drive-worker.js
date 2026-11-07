#!/usr/bin/env node
/** The hand-off worker as a child that runs the drive cell's drainLoop on one job until its terminal step [C7]. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeBoard, openBoard } from '../apps/lib/index.js';
import { drainLoop } from '../packages/drive/index.js';
import { Refused } from '../packages/kernel/index.js';
import { sharedTransport } from '../packages/transport/index.js';

const ENTRY = fileURLToPath(import.meta.url);

/**
 * Start a drive worker child for one job. The child opens the board file, calls driveOnce until the job reaches its
 * verdict, prints one `step <phase> <transition>` line per drive and exits 0; it exits 3 when another driver holds
 * the job's live lease.
 *
 * Why: the worker holds no state of its own, so its death loses nothing: a child respawned with the same owner
 * renews the lease and continues from the job's last written step, and after 2 minutes any driver can.
 *
 * @param {{ file: string, job: string, owner: string, repo?: string, runner?: { host: string, root?: string },
 *   plan?: { shard: string, command: string }[], intervalMs?: number }} options
 * @param {{ env?: NodeJS.ProcessEnv, stdio?: import('node:child_process').StdioOptions }} [spawnOptions]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnDriveWorker(options, { env = process.env, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  for (const field of ['file', 'job', 'owner']) {
    if (typeof options?.[field] !== 'string' || !options[field]) throw new Refused('DRIVE_WORKER', `a drive worker needs { ${field} }: pass the board file, the job id and the driver id`);
  }
  return spawn(process.execPath, [ENTRY, JSON.stringify(options)], { env, stdio });
}

/**
 * The child's body: open the board, drain the job, close the runner channels and the board, and set the exit code.
 *
 * @param {string} argument - The JSON options spawnDriveWorker passed.
 * @returns {Promise<void>}
 */
async function main(argument) {
  const { file, job, ...options } = JSON.parse(argument ?? '{}');
  const board = openBoard(file);
  try {
    const last = await drainLoop(board.db, job, { ...options,
      onStep: result => process.stdout.write(`step ${result.phase} ${result.transition ?? '-'}\n`) });
    process.exitCode = last.code === 'JOB_LEASED' ? 3 : 0;
  } finally {
    sharedTransport().close();
    closeBoard(board);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
