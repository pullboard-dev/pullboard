import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive } from '../../../../../packages/drive/index.js';

/**
 * Stop the review comparison workers still running in a sandbox's repositories, each by its recorded pid.
 * Why: a green pulled gate now submits on the board host and detaches a comparison worker, as an inline submit did;
 * left running it keeps writing into the sandbox, so its removal retried while blocking the test's main thread past
 * the runner's 30 s file-exit timeout, though every case passed [C7,#8011]. A worker that recorded its result is done.
 *
 * @param {string} dir - The sandbox folder; its repositories sit one level down.
 * @returns {number} How many workers were signalled.
 */
export function stopComparisonWorkers(dir) {
  let stopped = 0;
  let repos = [];
  try { repos = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name)); } catch { return 0; }
  for (const repo of repos) {
    const base = join(repo, '.git', 'pullboard', 'review-comparisons');
    if (!existsSync(base)) continue;
    for (const job of readdirSync(base)) {
      if (existsSync(join(base, job, 'result.json'))) continue;
      let pid = null;
      try { pid = Number(JSON.parse(readFileSync(join(base, job, 'worker.json'), 'utf8')).pid); } catch { continue; }
      if (!Number.isSafeInteger(pid) || pid <= 1 || !processAlive(pid)) continue;
      // The worker leads its own process group (detached), so the group signal also ends the check it runs.
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* it has exited */ } }
      stopped += 1;
    }
  }
  return stopped;
}
