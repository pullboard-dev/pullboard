/**
 * Settle a fixture's pulled landing: under pull `land --json` offers a runner land job and returns at once, so a journey
 * that asserts what the landing did waits here for the job's receipt and reads it in the shape the inline landing printed
 * (`landed`, `batch.tip`, `batch.state`) [P7,C7,#5821].
 *
 * Why one helper: the inline landing ran in the coordinator's own process and is going with controller dispatch; journeys
 * change `result.x` to `(await settleLand(box, result)).x` instead of each reading the job queue its own way.
 */
import { landJobs } from './board.js';
import { reviveFixtureLocalRunner } from '../runner/local-start.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { CLI_ENTRY } from '../runner/entry.js';

// Budget: how long a fixture waits for the loopback local runner to post one land job's receipt; a hang ceiling only.
const SETTLE_MS = 180_000;

/** The receipt's outcome as the inline batch state: a landing either landed or blocked its items. */
function batchState(outcome) {
  return outcome === 'landed' ? 'landed' : 'blocked';
}

/**
 * Wait for one land job's receipt on the box's board, starting the fixture's local runner if a gate switch stopped it.
 *
 * @param {{ repo: string, env: object }} box - The fixture project.
 * @param {string} job - The offered land job id.
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<{ id: string, items: number[], receipt: object }>}
 */
export function settledLandJob(box, job, { deadlineMs = SETTLE_MS } = {}) {
  reviveFixtureLocalRunner(box.repo, box.env, { entry: CLI_ENTRY });
  return whenRunnerSettles(box.env, () => { const found = landJobs(box).find(entry => entry.id === job); return found?.receipt ? found : null; },
    { deadlineMs, what: `land job ${job}` });
}

/** The offered land job's id: `offered` on a forced landing's result, else the id plain `land` says it offered. */
function offeredJob(landed) {
  if (landed?.offered) return landed.offered;
  const said = (landed?.messages ?? []).map(line => /offered (?:forced )?land job (\S+) for /u.exec(String(line))?.[1]).find(Boolean);
  return said ?? null;
}

/**
 * Settle a land result: an inline landing (it has a `batch`) or one that offered nothing comes back as is; an offered
 * land job is waited for and comes back with the receipt in the inline shape, plus `landJob` with the raw receipt.
 *
 * @param {{ repo: string, env: object }} box - The fixture project.
 * @param {object} landed - The parsed `land --json` document.
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<object>} `{ ...landed, landed: number[], returned, batch: { tip, state, items }, landJob }`.
 */
export async function settleLand(box, landed, options) {
  const offered = offeredJob(landed);
  if (!offered || landed.batch) return landed;
  const job = await settledLandJob(box, offered, options);
  const { receipt } = job;
  return { ...landed, landed: receipt.landed ?? [], returned: receipt.returned ?? [],
    batch: { tip: receipt.trunk ?? null, state: batchState(receipt.outcome), outcome: receipt.outcome, items: job.items.map(id => ({ id })) },
    landJob: { id: job.id, receipt } };
}
