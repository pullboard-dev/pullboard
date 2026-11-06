/** The hand-off stages run on the runner, in order, with their lines in the runner's own log [C7]. */
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** The hand-off stages in the order a gate runs them. */
export const HANDOFF_STAGES = Object.freeze(['authorization', 'doctrine', 'cells', 'composition', 'criterion', 'proof']);

/**
 * Whether the runner checkout is exactly the ticket's commit and tree.
 *
 * @param {string} root - The runner's checkout.
 * @param {{ commit: string, tree: string }} input - The ticket's source.
 * @returns {Promise<void>} Resolves when the checkout is the ticket's source.
 */
async function authorize(root, input) {
  const read = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim();
  if (read(['rev-parse', 'HEAD']) !== input.commit) throw Object.assign(new Error('the runner checkout is not the ticket commit'), { code: 'RUNNER_SOURCE' });
  if (input.tree && read(['rev-parse', 'HEAD^{tree}']) !== input.tree) throw Object.assign(new Error('the runner checkout tree is not the ticket tree'), { code: 'RUNNER_SOURCE' });
}

/**
 * The default stage for a name: authorization checks the source; every other stage runs the shell command the ticket
 * carries for it, and a stage with no command passes. Why commands: the ticket names what to prove, the runner never
 * reads a board.
 *
 * @param {string} name - A stage name from HANDOFF_STAGES.
 * @returns {(root: string, input: object, log: (line: string) => void) => Promise<void>}
 */
function defaultStage(name) {
  if (name === 'authorization') return authorize;
  return async (root, input, log) => {
    const command = input.commands?.[name];
    if (!command) return;
    const run = spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
    for (const line of `${run.stdout ?? ''}${run.stderr ?? ''}`.split(/\r?\n/u).filter(Boolean)) log(`  ${line}`);
    if (run.error || run.status !== 0) throw Object.assign(new Error(`${name} exited ${run.status ?? run.error?.code}`), { code: name === 'proof' ? 'TEST_FAILURE' : 'GATE_RED' });
  };
}

/**
 * Run the stages in order on the runner and stop at the first red. Stage lines go to the runner's log file only; the
 * returned result holds names and timings, never the lines.
 *
 * @param {string} root - The runner's checkout of the ticket commit.
 * @param {{ job: string, commit: string, tree?: string, commands?: object }} input - The ticket.
 * @param {{ logFile: string, stages?: object, now?: () => number }} ports - The runner's log and optional stage overrides.
 * @returns {Promise<{ job: string, commit: string, green: boolean, stages: { name: string, ms: number, state: string }[], failed?: { stage: string, code: string, message: string } }>}
 */
export async function runHandoffStages(root, input, { logFile, stages = {}, now = () => performance.now() }) {
  const log = line => appendFileSync(logFile, `${new Date().toISOString()} handoff ${input.job} ${line}\n`, { mode: 0o600 });
  const done = [];
  for (const name of HANDOFF_STAGES) {
    const started = now();
    log(`stage ${name} start`);
    try {
      await (stages[name] ?? defaultStage(name))(root, input, log);
    } catch (error) {
      const ms = Math.round(now() - started);
      log(`stage ${name} red ${ms}ms ${error.message}`);
      done.push({ name, ms, state: 'red' });
      return { job: input.job, commit: input.commit, green: false, stages: done,
        failed: { stage: name, code: error.code ?? 'GATE_RED', message: String(error.message) } };
    }
    const ms = Math.round(now() - started);
    log(`stage ${name} ok ${ms}ms`);
    done.push({ name, ms, state: 'ok' });
  }
  return { job: input.job, commit: input.commit, green: true, stages: done };
}
