/** The runner job's hand-off branch: the ticket's stages run in the job's checkout and report names, timings and failures only [C7]. */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The stage entry lives in accepted main's tree; a runner holds it as a checkout of the ticket's pinned main. */
const STAGE_ENTRY = 'apps/cli/src/io/runner/handoff/child.js';

/**
 * Run a hand-off ticket's stages in the job checkout and shape the job's result.
 * Why a child: the doctrine, cells, composition and failure readers reach the whole repository, far past the worker
 * capsule's file and byte bounds, so the stage entry of accepted main runs them in its own process, which also means the
 * runner runs accepted code for those stages, never the candidate's. The stage lines land in the runner's own log file
 * (handoff.log under the runner root) and the receipt carries no log line, only each stage's name, duration and state
 * plus the failure account of a red.
 *
 * @param {object} spec - The validated work specification; spec.handoff is the ticket's stage input.
 * @param {string} root - The job's checkout of the ticket commit.
 * @param {string} runnerRoot - The runner's own state directory, where the stage log lives.
 * @param {{ entry?: string }} [ports] - The stage entry file, when not read from the ticket's pinned main.
 * @returns {Promise<{ code: number, signal: null, handoff: object }>}
 */
export async function runHandoffJob(spec, root, runnerRoot, { entry } = {}) {
  const input = { ...spec.handoff, job: spec.id, commit: spec.commit, tree: spec.tree, main: spec.main ?? spec.handoff.main };
  const result = await runStageEntry(entry ?? mainEntry(input.main, root), { root, input, logFile: join(runnerRoot, 'handoff.log') });
  return { code: result.green ? 0 : 1, signal: null, handoff: { green: result.green, stages: result.stages, ...(result.failed ? { failed: result.failed } : {}) } };
}

/** The stage entry of the ticket's pinned main, checked out beside the job checkout. */
function mainEntry(main, root) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(main ?? '')) throw Object.assign(new Error('the ticket pins no main to read the stage code from'), { code: 'RUNNER_SOURCE' });
  const tree = join(root, '..', 'handoff-main');
  if (!existsSync(tree) && spawnSync('git', ['worktree', 'add', '--detach', '--force', tree, main], { cwd: root, encoding: 'utf8' }).status !== 0) {
    throw Object.assign(new Error('the runner could not check out the ticket main for the stage code'), { code: 'RUNNER_SOURCE' });
  }
  if (!existsSync(join(tree, STAGE_ENTRY))) throw Object.assign(new Error('the ticket main has no hand-off stage code yet'), { code: 'RUNNER_SOURCE' });
  return join(tree, STAGE_ENTRY);
}

/** Run the stage entry as a node process: the ticket goes in on stdin, one JSON result comes out on stdout. */
function runStageEntry(entry, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { cwd: request.root, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      try { resolve(JSON.parse(out)); } catch { reject(Object.assign(new Error(`the hand-off stage entry ended ${status} without a result`), { detail: err.slice(0, 2000) })); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
