/** Run an observational comparison in a detached, pinned copy of the executing tools [V4,C7]. */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The file a comparison worker records its pid in; the restart plan reads the same name [C7]. */
export const COMPARISON_WORKER_RECORD = 'worker.json';

/**
 * Take the shared per-tooling tools snapshot before the builder can change branches; the request supplies no verdict authority.
 * Why: every comparison copied the whole tools tree, 1,273 folders in one audit; two comparisons at one tooling now share one folder [C7].
 *
 * @param {object} request origin, commonDir, toolRoot, entry, item, source and digest
 * @param {{ snapshot: (toolRoot: string, job: string, commonDir: string) => string, spawnWorker?: Function }} deps snapshot is the shared per-tooling tools folder the submit hand-off also uses; spawnWorker is a test seam
 * @returns {Promise<{ job: string }>}
 */
export async function launchComparisonWorker({ origin, commonDir, toolRoot, entry, item, source, digest }, { snapshot, spawnWorker = spawn }) {
  const job = randomUUID();
  const directory = join(commonDir, 'pullboard', 'review-comparisons', job);
  const tools = snapshot(toolRoot, job, commonDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const request = join(directory, 'request.json');
  writeFileSync(request, JSON.stringify({ origin, tools, entry, item, source, digest }) + '\n', { mode: 0o600 });
  const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
  try {
    const worker = spawnWorker(process.execPath, [join(tools, relative(toolRoot, fileURLToPath(import.meta.url))), request],
      { cwd: origin, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
    await once(worker, 'spawn');
    writeFileSync(join(directory, COMPARISON_WORKER_RECORD), JSON.stringify({ pid: worker.pid, source, digest }) + '\n', { mode: 0o600 });
    worker.unref();
  } finally { closeSync(log); }
  return { job };
}

/** Invoke the ordinary diagnostic with source filters; the shared tools snapshot stays for the sweep to retire [C7]. */
function work(requestFile) {
  const request = JSON.parse(readFileSync(requestFile, 'utf8'));
  const tools = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  if (!basename(tools).startsWith('pullboard-handoff-tools-') || realpathSync(tools) !== realpathSync(request.tools)) throw new Error('comparison worker needs its own pinned tools');
  const result = spawnSync(process.execPath, [join(tools, request.entry), 'verify', String(request.item), '--compare', '--json'],
    { cwd: request.origin, env: { ...process.env, PULLBOARD_COMPARE_SOURCE: request.source, PULLBOARD_COMPARE_DIGEST: request.digest },
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 }); // budget: whole background diagnostic ceiling, including runner admission.
  writeFileSync(join(dirname(requestFile), 'result.json'), JSON.stringify({ code: result.status, output: result.stdout, error: result.error?.message ?? result.stderr }) + '\n', { mode: 0o600 });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) work(process.argv[2]);
