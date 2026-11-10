/** pullboard loop: declare a recurring job's cadence, record each run, and list the jobs [D1,C7]. */
import { COORDINATOR } from '../../../../packages/config/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { recurringJobs } from '../../../../packages/store/index.js';

/**
 * Run pullboard loop declare <name> --every 10m --owner <seat or lane>, loop ran <name>, or loop to list.
 * Declaring is the coordinator's or the person's from the main checkout; ran is any joined seat's.
 *
 * @param {{ ctx: any, words: string[], values: any, withBoard: Function, whoAmI: Function, ordered: Function }} cli
 * @returns {Promise<number>}
 */
export async function loopCommand({ ctx, words, values, withBoard, whoAmI, ordered }) {
  const [verb, name, ...extra] = words;
  if (verb && (!['declare', 'ran'].includes(verb) || !name || extra.length)) {
    throw new Refused('USAGE', 'use pullboard loop declare <name> --every 10m --owner <seat or lane>, pullboard loop ran <name>, or pullboard loop');
  }
  return withBoard(ctx, async (board) => {
    if (!verb) {
      const jobs = recurringJobs(board);
      ctx.io.result?.({ jobs });
      for (const job of jobs) ctx.io.say(`${job.name}: ${job.every}; owner ${job.owner}; last run ${job.lastRun?.at ?? 'never'}`);
      if (!jobs.length) ctx.io.say('no recurring jobs; the coordinator declares one with pullboard loop declare <name> --every 10m --owner <seat or lane>');
      return 0;
    }
    const me = whoAmI(ctx, board);
    if (verb === 'declare' && (!ctx.info.isMain || me.id !== COORDINATOR)) throw new Refused('JOB_CADENCE_COORDINATOR_ONLY', 'only the coordinator or the person declares a job’s cadence, from the main checkout');
    const job = await ordered(ctx, board, verb === 'declare' ? 'declareJob' : 'recordJobRun',
      [verb === 'declare' ? { agentId: me.id, name, every: values.every, owner: values.owner } : { agentId: me.id, name }]);
    ctx.io.result?.({ job });
    ctx.io.say(verb === 'declare' ? `${job.name}: ${job.every}; owner ${job.owner}` : `${job.name}: run recorded (${job.runs} so far)`);
    return 0;
  });
}
