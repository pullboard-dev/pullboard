import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { queueHandoffLaunch } from '../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../packages/resources/index.js';
import { effectiveRunners } from '../../../../packages/runners/index.js';
import { runOnRunnerAsync } from '../../../../packages/runners/index.js';
import { trunkRef } from '../../../../packages/sandbox/index.js';
import { privateCheckEnvelope } from '../../../runner/index.js';
/** The dispatcher's runner step: a hand-off ticket goes to a registered runner and never to a local worker [C7]. */

/** How long a requeued ticket waits before the dispatcher offers it to a runner again. */
export const RUNNER_RETRY_MS = 15_000;

/**
 * Send one runner ticket to the first registered runner that takes it, through the same trusted runner step the gate
 * uses, and record the job's start and the runner in the hand-off folder (runner.json). When no runner is reachable the
 * ticket goes back in line, never dropped. For now the job is the trusted private check that the commit is the ticket
 * commit; the stages run there in a later item.
 *
 * @param {{ job: string, item: number, commit: string, tree: string, main?: string, root: string, commonDir: string, attempts?: number }} launch - The ticket.
 * @param {{ settings?: object, run?: Function, now?: () => number, retryMs?: number }} [ports] - Settings, the runner step and the clock.
 * @returns {Promise<{ runner?: string, requeued?: boolean }>}
 */
export async function dispatchRunnerTicket(launch, { settings = loadMachineSettings(), run = runOnRunnerAsync, now = Date.now, retryMs = RUNNER_RETRY_MS } = {}) {
  const directory = join(launch.commonDir, 'pullboard', 'submit-handoffs', launch.job);
  const shell = `test "$(git rev-parse HEAD)" = ${launch.commit}`;
  const policy = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: shell, timeoutMs: 10 * 60 * 1000,
    policyCommit: launch.main ?? launch.commit, trunk: { ref: trunkRef(launch.root) ?? 'refs/heads/main', commit: launch.main ?? launch.commit } });
  const output = mkdtempSync(join(tmpdir(), 'pullboard-runner-ticket-'));
  const failures = [];
  for (const runner of effectiveRunners(settings)) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, 'runner.json'), JSON.stringify({ version: 1, job: launch.job, runner: runner.host, started: new Date(now()).toISOString() }) + '\n', { mode: 0o600 });
      await run(launch.root, shell, { runner, checkedSource: { commit: launch.commit, tree: launch.tree }, privateCheck: policy,
        metadata: { testStage: 'handoff' }, rawOutputPath: join(output, 'raw.log') });
      return { runner: runner.host };
    } catch (error) { failures.push(`${runner.host}: ${error?.code ?? 'ERROR'} ${error?.message ?? error}`); }
  }
  const attempts = (launch.attempts ?? 0) + 1;
  queueHandoffLaunch({ ...launch, attempts, notBefore: now() + retryMs, lastFailure: failures.join('; ').slice(0, 500) }, await reserveHandoffTicket(launch.job));
  return { requeued: true };
}
