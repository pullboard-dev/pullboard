/** Run an observational comparison in a detached, pinned copy of the executing tools [V4,C7]. */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { constants } from 'node:fs';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Snapshot tools before the builder can change branches; the request supplies no verdict authority. */
export async function launchComparisonWorker({ origin, commonDir, toolRoot, entry, item, source, digest }) {
  const job = randomUUID();
  const directory = join(commonDir, 'pullboard', 'review-comparisons', job);
  const tools = mkdtempSync(join(tmpdir(), 'pullboard-compare-tools-'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  cpSync(toolRoot, tools, { recursive: true, mode: constants.COPYFILE_FICLONE,
    filter: path => !['.git', 'node_modules'].includes(relative(toolRoot, path).split('/')[0]) });
  const request = join(directory, 'request.json');
  writeFileSync(request, JSON.stringify({ origin, tools, entry, item, source, digest }) + '\n', { mode: 0o600 });
  const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
  try {
    const worker = spawn(process.execPath, [join(tools, relative(toolRoot, fileURLToPath(import.meta.url))), request],
      { cwd: origin, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
    await once(worker, 'spawn');
    writeFileSync(join(directory, 'worker.json'), JSON.stringify({ pid: worker.pid, source, digest }) + '\n', { mode: 0o600 });
    worker.unref();
  } catch (error) { rmSync(tools, { recursive: true, force: true }); throw error; }
  finally { closeSync(log); }
  return { job };
}

/** Invoke the ordinary diagnostic with source filters and retire only this worker's own tool snapshot. */
function work(requestFile) {
  const request = JSON.parse(readFileSync(requestFile, 'utf8'));
  const tools = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  if (!basename(tools).startsWith('pullboard-compare-tools-') || realpathSync(tools) !== realpathSync(request.tools)) throw new Error('comparison worker needs its own pinned tools');
  try {
    const result = spawnSync(process.execPath, [join(tools, request.entry), 'verify', String(request.item), '--compare', '--json'],
      { cwd: request.origin, env: { ...process.env, PULLBOARD_COMPARE_SOURCE: request.source, PULLBOARD_COMPARE_DIGEST: request.digest },
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 }); // budget: whole background diagnostic ceiling, including runner admission.
    writeFileSync(join(dirname(requestFile), 'result.json'), JSON.stringify({ code: result.status, output: result.stdout, error: result.error?.message ?? result.stderr }) + '\n', { mode: 0o600 });
    process.exitCode = result.status ?? 1;
  } finally { rmSync(request.tools, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) work(process.argv[2]);
