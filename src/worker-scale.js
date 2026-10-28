/**
 * `pullboard run --scale` (B26,C7): the board runs as many agents as are worth running, within one budget the
 * person sets. The person never picks builder or reviewer counts: `pullboard settings workers.budget 40/day` is a
 * seat-hour budget over a declared window, and the scaler draws it down. Each cycle the running count follows
 * #1212's worth-running K, the work there is, and how many seats the budget left can still pay for.
 *
 * Every live seat this machine runs counts against the budget, including seats a person or another session
 * started; the scaler only ever stops its own idle seats. A launched worker is an ordinary lane seat in its own
 * worktree running the person's agent command; it pulls its work with `pullboard next --take`, so #1265's
 * dispatch hands each free seat a review first and a build otherwise. Scaling down never interrupts work: only a
 * seat holding no claim and no review reservation stops.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import * as store from './board.js';
import { readCapacity } from './capacity-read.js';
import { COORDINATOR } from './config.js';
import { machineHome } from './machine-home.js';
import { readyItems } from './queue-readiness.js';
import { Refused } from './refused.js';
import { withLocalSeatPresence } from './seat-presence.js';

const HOUR = 3_600_000;

/** A whole number of seats, 0 or more; anything else is not a count this planner may act on. */
function isCount(value) { return Number.isSafeInteger(value) && value >= 0; }

/** The UTC start of the budget window containing `now`: the day, or the week starting Monday. */
export function windowStart(window, now) {
  const at = new Date(now);
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return window === 'week' ? day - ((at.getUTCDay() + 6) % 7) * 24 * HOUR : day;
}

/**
 * Decide one scaling step from what the board observes now. Pure: the supervisor and the simulation share it.
 *
 * The seat-hours left pay for at most floor(left / cycleHours) seats until the next cycle, so a cycle never
 * commits more than the budget left. The target is the least of that, the worth-running K and the work there
 * is (busy seats plus waiting reviews and ready builds); when K is unknown the work stands in and the plan says
 * so. Every live seat counts toward the running total; only idle seats this scaler manages may stop.
 *
 * @param {{ budget: { seatHours: number, window: string }, usedHours: number, cycleHours: number, worth: number | null, workers: { id: string, busy: boolean, managed?: boolean }[], reviews: number, builds: number }} state
 */
export function planWorkerScale({ budget, usedHours, cycleHours, worth, workers, reviews, builds, spent = null }) {
  if (!budget || !(budget.seatHours >= 0) || !(usedHours >= 0) || !(cycleHours > 0)
    || !isCount(reviews) || !isCount(builds) || !Array.isArray(workers)) {
    throw new TypeError('worker scaling needs a seat-hour budget, the hours used, a cycle length, queue counts and the live seats');
  }
  const leftHours = Math.max(0, budget.seatHours - usedHours);
  const affordable = Math.floor(leftHours / cycleHours + 1e-9);
  const busy = workers.filter(worker => worker.busy);
  const stoppable = workers.filter(worker => !worker.busy && worker.managed !== false);
  const work = busy.length + reviews + builds;
  const worthKnown = isCount(worth);
  const terms = [['budget', affordable], ...(worthKnown ? [['worth', worth]] : []), ['queue', work]];
  const [binding, target] = terms.reduce((least, term) => term[1] < least[1] ? term : least);
  const launch = Math.max(0, target - workers.length);
  // Held seats and seats started elsewhere never stop, so the count rests above target only by those.
  const excess = Math.max(0, workers.length - target);
  const stop = stoppable.slice(stoppable.length - Math.min(excess, stoppable.length)).map(worker => worker.id);
  const free = workers.length - busy.length - stop.length + launch;
  const review = Math.min(reviews, free);
  return { budget, usedHours, spent, leftHours, affordable, worth: worthKnown ? worth : null, target, launch, stop,
    running: workers.length, assign: { review, build: Math.min(builds, Math.max(0, free - review)) }, binding, worthKnown };
}

/**
 * One supervisor cycle: draw down the hours the live seats used since the last cycle, observe, plan, stop idle
 * seats (each re-checked just before it stops, since a seat may have taken work after the observation), then
 * launch. Every effect goes through the injected ports.
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

/** Every live seat this machine runs on the board: its worktree is here and its local heartbeat is live. */
export function liveLocalSeats(board) {
  return withLocalSeatPresence(board, store.listAgents(board))
    .filter(seat => seat.agent_id !== COORDINATOR && seat.presence === 'live' && existsSync(seat.agent_path))
    .map(seat => seat.agent_id);
}

/** Observe the planner's queue inputs and seats from one board read; managed seats count even before they beat. */
export function observeWorkers(board, { lane, managed, now = Date.now() }) {
  const items = store.listItems(board);
  const ids = [...new Set([...liveLocalSeats(board), ...managed])];
  return {
    worth: readCapacity(board, now).agents?.recommended ?? null,
    workers: ids.map(id => ({ id, busy: seatHoldsWork(board, id, items), managed: managed.includes(id) })),
    reviews: items.filter(item => item.item_status === 'submitted' && !store.reviewHolder(board, item)).length,
    builds: readyItems(board, store.foreignBlockers).filter(item => item.item_lane === lane).length,
  };
}

/**
 * The machine's seat-hour ledger, fail-closed: it may overcount use but never undercount it.
 *
 * - Every unobserved interval is charged in full wall time for every seat live at either end of it; nothing is
 *   capped. A seat seen at only one end may have run throughout, so it is charged too.
 * - With no record for this window (a first run, or a deleted ledger), the seats live now are charged from the
 *   window's start, since nothing proves when they began.
 * - A sample from an earlier window charges its seats from this window's start; one from a later window, or a
 *   clock that moved backwards, marks the window spent and launches nothing until the next window, naming why.
 * - A ledger that cannot be read, or that holds anything but a valid record, refuses rather than granting a
 *   fresh budget.
 */
export function workerLedger(file = join(machineHome(), 'workers-usage.json')) {
  /** The stored record exactly as written, validated, or null when none exists. */
  function stored() {
    if (!existsSync(file)) return null;
    let value;
    try { value = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { throw new Refused('BAD_MACHINE_SETTINGS', `the worker ledger ${file} is unreadable (${error.message}); restore it, or remove it knowingly: a missing ledger charges every live seat from the window's start`); }
    if (!value || !['day', 'week'].includes(value.window) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.sampledAt)
      || !(typeof value.usedHours === 'number' && value.usedHours >= 0) || !Array.isArray(value.seats) || value.seats.some(id => typeof id !== 'string')
      || !(value.spent === null || typeof value.spent === 'string')) {
      throw new Refused('BAD_MACHINE_SETTINGS', `the worker ledger ${file} is not a valid record; restore it, or remove it knowingly: a missing ledger charges every live seat from the window's start`);
    }
    return value;
  }
  /** The use recorded for the window containing `now`, without charging the interval still open. */
  function read(window, now) {
    const start = windowStart(window, now);
    const value = stored();
    if (!value || value.window !== window || value.start < start) return { window, start, usedHours: 0, sampledAt: null, seats: [], spent: null };
    if (value.start > start) return { ...value, start, usedHours: Infinity, spent: `the ledger's window starts ${new Date(value.start).toISOString()}, after this clock's ${new Date(start).toISOString()}; the clock moved backwards, so the budget is treated as spent` };
    return { ...value, usedHours: value.spent ? Infinity : value.usedHours };
  }
  /** Charge the interval since the last sample, then store this sample's live seats. */
  function record(window, now, seats) {
    const start = windowStart(window, now);
    const value = stored();
    let usedHours = 0;
    let spent = null;
    if (value && value.window === window && value.start === start) {
      ({ usedHours, spent } = value);
      if (now < value.sampledAt) spent ??= `the clock moved backwards from ${new Date(value.sampledAt).toISOString()} to ${new Date(now).toISOString()}; seat use since then is unknown, so the budget is treated as spent until the next ${window}`;
      else usedHours += new Set([...value.seats, ...seats]).size * (now - value.sampledAt) / HOUR;
    } else if (value && value.window === window && value.start > start) {
      spent = `the ledger's window starts ${new Date(value.start).toISOString()}, after this clock's ${new Date(start).toISOString()}; the clock moved backwards, so the budget is treated as spent`;
    } else if (value && value.window === window && value.sampledAt <= now) {
      // The last sample is from an earlier window: its seats and this sample's may have run since this window began.
      usedHours = new Set([...value.seats, ...seats]).size * (now - Math.max(start, value.sampledAt)) / HOUR;
    } else {
      // No record for this window: nothing proves when the seats live now began.
      usedHours = seats.length * (now - start) / HOUR;
      if (value && value.window === window) spent = `the ledger's last sample ${new Date(value.sampledAt).toISOString()} is after this clock's ${new Date(now).toISOString()}; the clock moved backwards, so the budget is treated as spent`;
    }
    const next = { window, start, usedHours, sampledAt: Math.max(now, value?.window === window && value.start === start ? value.sampledAt : now), seats: [...new Set(seats)], spent };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(next));
    renameSync(`${file}.tmp`, file);
    return { ...next, usedHours: spent ? Infinity : usedHours };
  }
  return { read, record };
}

/** The line the supervisor prints for each cycle, naming what limits the count. */
export function scaleLine(plan) {
  const why = plan.spent ? `a budget treated as spent: ${plan.spent}` : plan.binding === 'budget' ? `${plan.leftHours.toFixed(1)} of ${plan.budget.seatHours} seat-hours left this ${plan.budget.window}, enough for ${plan.affordable}`
    : plan.binding === 'worth' ? `${plan.worth} worth running` : 'the waiting work';
  return `workers: ${plan.running} live on this machine, target ${plan.target} (limited by ${why}${plan.worthKnown ? '' : '; worth running is unknown, so the waiting work stands in'})`
    + `${plan.launch ? `; launching ${plan.launch}` : ''}${plan.stopped?.length ? `; stopped idle ${plan.stopped.join(', ')}` : ''}`
    + `${plan.running > plan.target && !plan.launch ? '; seats above target are holding work or were started elsewhere and keep running' : ''}`
    + `; free seats take ${plan.assign.review} review${plan.assign.review === 1 ? '' : 's'} first, then ${plan.assign.build} build${plan.assign.build === 1 ? '' : 's'}`;
}

/**
 * Supervise budgeted workers from the main checkout until --cycles runs out (or forever).
 *
 * @param {any} io
 * @param {any} values
 * @param {{ context: Function, withBoard: Function, worktreeFor: Function, workerBudget: Function, sleep?: Function, ledger?: any, now?: Function }} deps
 * @returns {Promise<number>}
 */
export async function scaleWorkers(io, values, deps) {
  const ctx = deps.context(io);
  if (!ctx.info.isMain) throw new Refused('SCALE_FROM_MAIN', 'run pullboard run --scale from the main checkout; it makes and joins each worker worktree itself');
  const budget = deps.workerBudget();
  if (!budget || !budget.seatHours) throw new Refused('WORKER_BUDGET_UNSET', 'set the seat-hours this machine may spend first: pullboard settings workers.budget 40/day');
  const lane = values.lane;
  const command = String(values.agent ?? '').trim();
  if (!lane || !command || !values.model) {
    throw new Refused('USAGE', 'pullboard run --scale --lane <lane> --model "<model name>" --agent "<command>": the command starts one agent session in the worker worktree ($PULLBOARD_PROMPT) that takes work with pullboard next --take');
  }
  const every = Number(values.every ?? '60');
  const cycles = values.cycles === undefined ? Infinity : Number(values.cycles);
  if (!Number.isInteger(every) || every < 5 || every > 3600) throw new Refused('USAGE', '--every is whole seconds from 5 to 3600');
  if (cycles !== Infinity && (!Number.isInteger(cycles) || cycles < 1)) throw new Refused('USAGE', '--cycles is a whole number, 1 or more');
  const cycleHours = every / 3600;
  const sleep = deps.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;
  const ledger = deps.ledger ?? workerLedger();
  const running = new Map(); // seat id -> { child }
  const parked = []; // joined worker worktrees whose agent process has exited, reused before making another
  const quiet = sink => ({ say() {}, err: message => io.err?.(message), result: value => { sink.value = value; } });
  const ports = {
    observe: () => deps.withBoard(ctx, board => {
      const observed = observeWorkers(board, { lane, managed: [...running.keys()], now: now() });
      const used = ledger.record(budget.window, now(), observed.workers.map(worker => worker.id));
      return { ...observed, budget, usedHours: used.usedHours, spent: used.spent, cycleHours };
    }),
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
      running.set(seat.id, { child });
      child.on('exit', () => { running.delete(seat.id); parked.push(seat); });
      io.say(`launched ${seat.id} in ${seat.path}`);
    },
  };
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (cycle) await sleep(every * 1000);
    io.say(scaleLine(await scaleCycle(ports)));
  }
  return 0;
}
