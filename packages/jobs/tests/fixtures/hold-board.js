/** Hold a board file's write lock from another thread of this process, so a test can prove how a synchronous writer waits [C7]. */
import { Worker } from 'node:worker_threads';

const HOLDER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
db.exec('BEGIN IMMEDIATE');
parentPort.postMessage('held');
setTimeout(() => { db.exec('COMMIT'); db.close(); }, workerData.holdMs);
`;

/**
 * Start a thread that takes BEGIN IMMEDIATE on `file`, and commits after `holdMs`.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} file
 * @param {number} holdMs
 * @returns {Promise<void>} Resolves once the lock is held.
 */
export async function holdBoard(t, file, holdMs) {
  const worker = new Worker(HOLDER, { eval: true, workerData: { file, holdMs } });
  t.after(() => worker.terminate());
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
}
