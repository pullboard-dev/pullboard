/**
 * `pullboard run --scale` (B26,C7): the board runs as many agents as are worth running, within one budget the
 * person sets. The person never picks builder or reviewer counts: `pullboard settings workers.budget <n>` is the
 * most seats this machine may run at once, and each cycle the running count follows #1212's worth-running K.
 *
 * A launched worker is an ordinary lane seat in its own worktree running the person's agent command; it pulls
 * its work with `pullboard next --take`, so #1265's dispatch hands each free seat a review first and a build
 * otherwise. Scaling down never interrupts work: only a seat holding no claim and no review reservation stops.
 */
import { spawn } from 'node:child_process';
import * as store from './board.js';
import { readCapacity } from './capacity-read.js';
import { readyItems } from './queue-readiness.js';
import { Refused } from './refused.js';

/** A whole number of seats, 0 or more; anything else is not a count this planner may act on. */
function isCount(value) { return Number.isSafeInteger(value) && value >= 0; }

/**
 * Decide one scaling step from what the board observes now. Pure: the supervisor and the simulation share it.
 *
 * The target is the least of the budget, the worth-running K and the work there is (busy seats plus waiting
 * reviews and ready builds). When K is unknown, the work there is stands in for it and the plan says so.
 * Launches never take the running count past the budget; stops only ever name idle seats.
 *
 * @param {{ budget: number, worth: number | null, workers: { id: string, busy: boolean }[], reviews: number, builds: number }} state
 * @returns {{ budget: number, worth: number | null, target: number, launch: number, stop: string[], assign: { review: number, build: number }, binding: 'budget' | 'worth' | 'queue', worthKnown: boolean }}
 */
export function planWorkerScale({ budget, worth, workers, reviews, builds }) {
  if (!isCount(budget) || !isCount(reviews) || !isCount(builds) || !Array.isArray(workers)) {
    throw new TypeError('worker scaling needs a whole budget, whole queue counts and the running workers');
  }
  const busy = workers.filter(worker => worker.busy);
  const idle = workers.filter(worker => !worker.busy);
  const work = busy.length + reviews + builds;
  const worthKnown = isCount(worth);
  const terms = [['budget', budget], ...(worthKnown ? [['worth', worth]] : []), ['queue', work]];
  const [binding, target] = terms.reduce((least, term) => term[1] < least[1] ? term : least);
  const launch = Math.max(0, Math.min(target, budget) - workers.length);
  // Busy seats are never stopped, so the count can rest above target only by seats still holding work.
  const excess = Math.max(0, workers.length - Math.max(target, busy.length));
  const stop = idle.slice(idle.length - Math.min(excess, idle.length)).map(worker => worker.id);
  const free = idle.length - stop.length + launch;
  const review = Math.min(reviews, free);
  return { budget, worth: worthKnown ? worth : null, target, launch, stop,
    assign: { review, build: Math.min(builds, free - review) }, binding, worthKnown };
}

/**
 * One supervisor cycle: observe, plan, stop idle seats (each re-checked just before it stops, since a seat may
 * have taken work after the observation), then launch. Every effect goes through the injected ports.
 *
 * @param {{ observe: Function, isIdle: Function, stop: Function, launch: Function }} ports
 * @returns {Promise<any>} The plan that was acted on, with the seats actually stopped.
 */
export async function scaleCycle({ observe, isIdle, stop, launch }) {
  const plan = planWorkerScale(await observe());
  const stopped = [];
  for (const id of plan.stop) {
    if (!await isIdle(id)) continue;
    await stop(id);
    stopped.push(id);
  }
  for (let index = 0; index < plan.launch; index += 1) await launch();
  return { ...plan, stopped };
}

/** True while a seat holds a claim or reserves a review: such a seat is never stopped. */
export function seatHoldsWork(board, seatId, items = store.listItems(board)) {
  return items.some(item => item.item_status === 'claimed' && item.item_owner === seatId
    || item.item_status === 'submitted' && store.reviewHolder(board, item) === seatId);
}

/** Observe the planner's inputs from one board read: budget, K, the managed seats and the waiting work. */
export function observeWorkers(board, { budget, lane, seats, now = Date.now() }) {
  const items = store.listItems(board);
  const worth = readCapacity(board, now).agents?.recommended ?? null;
  return {
    budget, worth,
    workers: seats.map(id => ({ id, busy: seatHoldsWork(board, id, items) })),
    reviews: items.filter(item => item.item_status === 'submitted' && !store.reviewHolder(board, item)).length,
    builds: readyItems(board, store.foreignBlockers).filter(item => item.item_lane === lane).length,
  };
}

/** The line the supervisor prints for each cycle, naming what limits the count. */
export function scaleLine(plan, running) {
  const why = plan.binding === 'budget' ? `the budget of ${plan.budget}`
    : plan.binding === 'worth' ? `${plan.worth} worth running` : 'the waiting work';
  return `workers: ${running} running, target ${plan.target} (limited by ${why}${plan.worthKnown ? '' : '; worth running is unknown, so the waiting work stands in'})`
    + `${plan.launch ? `; launching ${plan.launch}` : ''}${plan.stopped?.length ? `; stopped idle ${plan.stopped.join(', ')}` : ''}`
    + `; free seats take ${plan.assign.review} review${plan.assign.review === 1 ? '' : 's'} first, then ${plan.assign.build} build${plan.assign.build === 1 ? '' : 's'}`;
}

/**
 * Supervise budgeted workers from the main checkout until --cycles runs out (or forever).
 *
 * @param {any} io
 * @param {any} values
 * @param {{ context: Function, withBoard: Function, worktreeFor: Function, workerBudget: Function, sleep?: Function }} deps
 * @returns {Promise<number>}
 */
export async function scaleWorkers(io, values, deps) {
  const ctx = deps.context(io);
  if (!ctx.info.isMain) throw new Refused('SCALE_FROM_MAIN', 'run pullboard run --scale from the main checkout; it makes and joins each worker worktree itself');
  const budget = deps.workerBudget();
  if (!budget) throw new Refused('WORKER_BUDGET_UNSET', 'set the most workers this machine may run at once first: pullboard settings workers.budget <n>');
  const lane = values.lane ?? values.first;
  const command = String(values.agent ?? '').trim();
  if (!lane || !command || !values.model) {
    throw new Refused('USAGE', 'pullboard run --scale --lane <lane> --model "<model name>" --agent "<command>": the command starts one agent session in the worker worktree ($PULLBOARD_PROMPT) that takes work with pullboard next --take');
  }
  const every = Number(values.every ?? '60');
  const cycles = values.cycles === undefined ? Infinity : Number(values.cycles);
  if (!Number.isInteger(every) || every < 5 || every > 3600) throw new Refused('USAGE', '--every is whole seconds from 5 to 3600');
  if (cycles !== Infinity && (!Number.isInteger(cycles) || cycles < 1)) throw new Refused('USAGE', '--cycles is a whole number, 1 or more');
  const sleep = deps.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const running = new Map(); // seat id -> { child, path }
  const parked = []; // joined worker worktrees whose agent process has exited, reused before making another
  const quiet = (sink) => ({ say() {}, err: message => io.err?.(message), result: value => { sink.value = value; } });
  const ports = {
    observe: () => deps.withBoard(ctx, board => observeWorkers(board, { budget, lane, seats: [...running.keys()] })),
    isIdle: id => deps.withBoard(ctx, board => !seatHoldsWork(board, id)),
    stop: id => {
      const { child } = running.get(id);
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    },
    launch: async () => {
      let seat = parked.shift();
      if (!seat) {
        const made = {};
        await deps.worktreeFor(quiet(made), lane, values.route ?? 'strong', values.family ?? null, values.model);
        seat = { id: made.value.agent, path: made.value.path, prompt: made.value.prompt };
      }
      const env = { ...process.env, PULLBOARD_SEAT: seat.id, PULLBOARD_PROMPT: `${seat.prompt}\nTake work with pullboard next --take until it has nothing for you, then stop.` };
      const child = spawn(command, { cwd: seat.path, env, shell: true, detached: true, stdio: 'ignore' });
      running.set(seat.id, { child, path: seat.path });
      child.on('exit', () => { running.delete(seat.id); parked.push(seat); });
      io.say(`launched ${seat.id} in ${seat.path}`);
    },
  };
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (cycle) await sleep(every * 1000);
    const plan = await scaleCycle(ports);
    io.say(scaleLine(plan, running.size));
  }
  return 0;
}
