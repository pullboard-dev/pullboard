/** Run an observational comparison in a detached, pinned copy of the executing tools [V4,C7]. */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
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
 * Record a comparison request and detach its worker; the request supplies no verdict authority. A cold shared tools
 * snapshot is built by the detached worker from the recorded commit, so the caller never waits for the copy.
 * Why: every comparison copied the whole tools tree, 1,273 folders in one audit; two comparisons at one tooling now share one folder,
 * and runner jobs, each with a fresh temp folder, copied it before submit returned, 0.9-1.3 s of a 24 s bar (#5752) [C7].
 *
 * @param {object} request origin, commonDir, toolRoot, entry, item, source and digest
 * @param {{ snapshot: (toolRoot: string, job: string, commonDir: string) => string, plan?: (toolRoot: string) => ({ tools: string, commit: string } | null), snapshotModule?: string, spawnWorker?: Function }} deps snapshot is the shared per-tooling tools folder the submit hand-off also uses; plan names that folder and its commit without copying, and snapshotModule is the module URL exporting snapshot that the worker loads to build it; spawnWorker is a test seam
 * @returns {Promise<{ job: string }>}
 */
export async function launchComparisonWorker({ origin, commonDir, toolRoot, entry, item, source, digest }, { snapshot, plan, snapshotModule, spawnWorker = spawn }) {
  const job = randomUUID();
  const directory = join(commonDir, 'pullboard', 'review-comparisons', job);
  const target = plan && snapshotModule ? plan(toolRoot) : null;
  // The commit is pinned now, before the builder can change branches; the worker builds from it, not the working tree.
  const deferred = target !== null && !existsSync(target.tools);
  const tools = deferred ? target.tools : snapshot(toolRoot, job, commonDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const request = join(directory, 'request.json');
  writeFileSync(request, JSON.stringify({ origin, tools, entry, item, source, digest,
    ...deferred ? { commonDir, toolRoot, toolsCommit: target.commit, snapshotModule } : {} }) + '\n', { mode: 0o600 });
  const script = fileURLToPath(import.meta.url);
  const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
  try {
    const worker = spawnWorker(process.execPath, deferred ? [script, request, '--prepare'] : [join(tools, relative(toolRoot, script)), request],
      { cwd: origin, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
    await once(worker, 'spawn');
    writeFileSync(join(directory, COMPARISON_WORKER_RECORD), JSON.stringify({ pid: worker.pid, source, digest }) + '\n', { mode: 0o600 });
    worker.unref();
  } finally { closeSync(log); }
  return { job };
}

/**
 * Run a child to its end without blocking, collecting stdout; leased callers must keep their timers firing.
 *
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
async function runChild(args, options) {
  const child = spawn(process.execPath, args, options);
  let stdout = ''; let stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

/**
 * Build the recorded shared tools snapshot from its pinned commit, then run the comparison from it as usual; a failed
 * build still writes result.json, so nothing waits on a comparison that never ran [C7].
 *
 * @param {string} requestFile
 * @param {{ runTools?: (args: string[], options: object) => Promise<{ status: number | null }> }} [deps] runTools is a test seam for the run from the built folder
 * @returns {Promise<void>}
 */
export async function prepareComparison(requestFile, { runTools = runChild } = {}) {
  const request = JSON.parse(readFileSync(requestFile, 'utf8'));
  // The build runs in a child that imports the snapshot module, so this file's import graph stays literal.
  const args = [request.toolRoot, basename(dirname(requestFile)), request.commonDir, { rebuild: { tools: request.tools, commit: request.toolsCommit } }];
  const built = await runChild(['--input-type=module', '-e',
    `import { toolsSnapshot } from ${JSON.stringify(request.snapshotModule)}; process.stdout.write(toolsSnapshot(...${JSON.stringify(args)}));`],
  { cwd: request.origin, stdio: ['ignore', 'pipe', 'pipe'] });
  if (built.status !== 0 || built.stdout !== request.tools) {
    writeFileSync(join(dirname(requestFile), 'result.json'), JSON.stringify({ code: 1, output: '', error: `tools snapshot failed: ${built.stderr}` }) + '\n', { mode: 0o600 });
    process.exitCode = 1;
    return;
  }
  const result = await runTools([join(built.stdout, relative(request.toolRoot, fileURLToPath(import.meta.url))), requestFile],
    { cwd: request.origin, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No top-level await: a CommonJS require of this module's graph would refuse it.
  if (process.argv[3] === '--prepare') prepareComparison(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
  else work(process.argv[2]);
}
