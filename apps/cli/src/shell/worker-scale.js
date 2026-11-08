import { currentProofCounters } from '../../../../packages/verify/index.js';
import { proofCounter } from '../../../../packages/verify/index.js';
import { localDependencyIds } from '../../../../packages/items/index.js';
import { dependencyLabel } from '../../../../packages/items/index.js';
import { itemFileCollisions } from '../../../../packages/items/index.js';
import { exitedSession } from '../../../../packages/store/index.js';
/**
 * `pullboard run --scale` (B26,C7): the board runs as many agents as are worth running, within one budget the
 * person sets. The person never picks builder or reviewer counts: `pullboard settings workers.budget 40/day` is a
 * spend budget over a declared window, and the scaler draws it down. Each cycle the running count follows
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
import * as store from '../../../../packages/store/index.js';
import { readCapacity } from '../../../../packages/stats/index.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { machineHome } from '../../../../packages/resources/index.js';
import { readyItems } from '../../../../src/queue-readiness.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { withLocalSeatPresence } from '../../../../packages/store/index.js';
import { modelTierRoute } from './model-tier-route.js';

const HOUR = 3_600_000;

/**
 * Price per seat-hour by declared model, in budget units (one unit is one seat-hour of an unpriced seat).
 * Why: the budget is a daily spend, so an expensive model draws it down faster than a cheap one [C7].
 */
export const MODEL_SEAT_HOUR_PRICE = Object.freeze({ 'claude-opus-5-5': 5, 'claude-sonnet-5-5': 1, 'claude-haiku-5-5': 0.25 });

/**
 * What one seat-hour of a model costs against the budget; an unpriced or unknown model is charged one seat-hour,
 * so seat-hour behaviour is unchanged for it [C7].
 *
 * @param {string|null|undefined} model - The seat's declared model.
 * @param {Record<string, number>} [table] - The price table; defaults to MODEL_SEAT_HOUR_PRICE.
 * @returns {number}
 */
export function seatHourPrice(model, table = MODEL_SEAT_HOUR_PRICE) {
  const price = model != null && Object.hasOwn(table, model) ? table[model] : undefined;
  return Number.isFinite(price) && price > 0 ? price : 1;
}

/** A whole number of seats, 0 or more; anything else is not a count this planner may act on. */
function isCount(value) { return Number.isSafeInteger(value) && value >= 0; }

/** The UTC start of the budget window containing `now`: the day, or the week starting Monday. */
export function windowStart(window, now) {
  const at = new Date(now);
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return window === 'week' ? day - ((at.getUTCDay() + 6) % 7) * 24 * HOUR : day;
}

/** The budget must sustain a seat until the current day or week ends, not only until the next sample. */
export function workerWindowHours(window, now) {
  return (windowStart(window, now) + (window === 'week' ? 7 : 1) * 24 * HOUR - now) / HOUR;
}

/**
 * Decide one scaling step from what the board observes now. Pure: the supervisor and the simulation share it.
 *
 * The spend left pays for at most floor(left / (hoursLeft * price)) seats through the remaining budget window, so a cycle never
 * commits more than the budget left. The target is the least of that, the worth-running K and the work there
 * is (busy seats plus waiting reviews and ready builds); when K is unknown a four-seat ceiling applies and the plan says
 * so. Every live seat counts toward the running total; only idle seats this scaler manages may stop.
 *
 * @param {{ budget: { spend: number, window: string }, usedSpend: number, cycleHours: number, worth: number | null, workers: { id: string, busy: boolean, managed?: boolean }[], reviews: number, builds: number }} state
 */
export function planWorkerScale({ budget, usedSpend, cycleHours, worth, workers, reviews, builds, spent = null, model = null, hoursLeft = workerWindowHours(budget?.window ?? 'day', Date.now()) }) {
  if (!budget || !(budget.spend >= 0) || !(usedSpend >= 0) || !(cycleHours > 0)
    || !(hoursLeft > 0) || !Number.isFinite(hoursLeft)
    || !isCount(reviews) || !isCount(builds) || !Array.isArray(workers)) {
    throw new TypeError('worker scaling needs a spend budget, the spend used, a cycle length, queue counts and the live seats');
  }
  const leftSpend = Math.max(0, budget.spend - usedSpend);
  // A new seat of `model` costs its price per hour for the rest of the window; unpriced models cost one seat-hour.
  const price = seatHourPrice(model);
  const affordable = Math.floor(leftSpend / (hoursLeft * price) + 1e-9);
  const busy = workers.filter(worker => worker.busy);
  const stoppable = workers.filter(worker => !worker.busy && worker.managed !== false);
  const work = busy.length + reviews + builds;
  const worthKnown = isCount(worth);
  const terms = [['budget', affordable], ...(worthKnown ? [['worth', worth]] : [['unknown-worth', 4]]), ['queue', work]];
  const [binding, target] = terms.reduce((least, term) => term[1] < least[1] ? term : least);
  const launch = Math.max(0, target - workers.length);
  // Held seats and seats started elsewhere never stop, so the count rests above target only by those.
  const excess = Math.max(0, workers.length - target);
  const stop = stoppable.slice(stoppable.length - Math.min(excess, stoppable.length)).map(worker => worker.id);
  const free = workers.length - busy.length - stop.length + launch;
  const review = Math.min(reviews, free);
  return { budget, usedSpend, spent, price, leftSpend, hoursLeft, affordable, worth: worthKnown ? worth : null, target, launch, stop,
    running: workers.length, assign: { review, build: Math.min(builds, Math.max(0, free - review)) }, binding, worthKnown };
}

/** A review waits this long before the scaler opens a seat of another family for it [C7]. */
export const REVIEW_FAMILY_WAIT_MS = 10 * 60_000;

/**
 * The reviewer seats to open for builder families whose reviews wait with no free reviewer of another family.
 * One seat per waiting builder family, of a different family, on the lowest route that can review all of that
 * family's waiting items. Why: a review needs a family other than its builder's, so same-family idle seats cannot help.
 * @param {{ waiting: { family: string, waitedMs: number, route: string }[], seats: { family: string|null, busy: boolean }[], families: string[], thresholdMs?: number }} state
 * @returns {{ family: string, route: string, for: string }[]}
 */
export function planReviewFamilySeats({ waiting, seats, families, thresholdMs = REVIEW_FAMILY_WAIT_MS }) {
  const opens = [];
  for (const builder of new Set(waiting.filter(entry => entry.waitedMs > thresholdMs).map(entry => entry.family))) {
    if (seats.some(seat => !seat.busy && seat.family !== builder)) continue;
    const family = families.find(candidate => candidate !== builder);
    if (!family) continue;
    const routes = waiting.filter(entry => entry.family === builder && entry.waitedMs > thresholdMs).map(entry => store.ROUTES.indexOf(entry.route));
    opens.push({ family, route: store.ROUTES[Math.max(0, ...routes)], for: builder });
  }
  return opens;
}

/**
 * One supervisor cycle: draw down the hours the live seats used since the last cycle, observe, plan, stop idle
 * seats (each re-checked just before it stops, since a seat may have taken work after the observation), then
 * launch. Every effect goes through the injected ports.
 */
export async function scaleCycle({ observe, isIdle, stop, launch }) {
  const observed = await observe();
  const plan = planWorkerScale(observed);
  const stopped = [];
  for (const id of plan.stop) {
    if (!await isIdle(id)) continue;
    await stop(id);
    stopped.push(id);
  }
  for (let index = 0; index < plan.launch; index += 1) await launch();
  // Reviews waiting on a family no free seat belongs to open a reviewer of another family, within what the budget left can pay for [C7].
  const room = Math.max(0, plan.affordable - plan.running - plan.launch + stopped.length);
  const opened = [];
  for (const open of planReviewFamilySeats({ waiting: observed.waiting ?? [], seats: observed.seats ?? [], families: observed.families ?? [] }).slice(0, room)) {
    await launch(open);
    opened.push(open);
  }
  return { ...plan, stopped, opened };
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
export function observeWorkers(board, { lane, managed, inactive = [], route = 'strong', now = Date.now() }) {
  const items = store.listItems(board);
  const ids = [...new Set([...liveLocalSeats(board).filter(id => !inactive.includes(id)), ...managed])];
  const agents = store.listAgents(board), familyOf = id => store.canonicalFamily(board, store.seatFamily(board, id)) || null;
  const submittedAt = board.db.prepare("SELECT MAX(event_at) AS at FROM event WHERE item_id=? AND event_kind='submit'");
  const unreserved = items.filter(item => item.item_status === 'submitted' && !store.reviewHolder(board, item));
  return {
    seats: ids.map(id => ({ id, family: familyOf(id), busy: seatHoldsWork(board, id, items) })),
    families: [...new Set(agents.map(agent => familyOf(agent.agent_id)).filter(Boolean))].sort(),
    waiting: unreserved.map(item => ({ item: item.item_id, family: store.canonicalFamily(board, item.item_builder_family) || null, route: item.item_route,
      waitedMs: Math.max(0, now - Date.parse(submittedAt.get(item.item_id).at ?? '')) || 0 })).filter(entry => entry.family),
    worth: readCapacity(board, now, { currentProofCounters, proofCounter }).agents?.recommended ?? null,
    workers: ids.map(id => ({ id, busy: seatHoldsWork(board, id, items), managed: managed.includes(id) })),
    reviews: items.filter(item => item.item_status === 'submitted' && !store.reviewHolder(board, item) && store.canTake(route, item.item_route)).length,
    builds: readyItems(board, store.foreignBlockers, { ...store, localDependencyIds, dependencyLabel, itemFileCollisions }).filter(item => item.item_lane === lane && store.canTake(route, item.item_route)).length,
  };
}

/**
 * The machine's spend ledger, fail-closed: it may overcount use but never undercount it.
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
    if (value && typeof value === 'object' && value.spend === undefined && typeof value.usedHours === 'number') { value.spend = value.usedHours; delete value.usedHours; }
    if (!value || !['day', 'week'].includes(value.window) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.sampledAt)
      || !(typeof value.spend === 'number' && value.spend >= 0) || !Array.isArray(value.seats) || value.seats.some(id => typeof id !== 'string')
      || !(value.spent === null || typeof value.spent === 'string')) {
      throw new Refused('BAD_MACHINE_SETTINGS', `the worker ledger ${file} is not a valid record; restore it, or remove it knowingly: a missing ledger charges every live seat from the window's start`);
    }
    return value;
  }
  /** The use recorded for the window containing `now`, without charging the interval still open. */
  function read(window, now) {
    const start = windowStart(window, now);
    const value = stored();
    if (!value || value.window !== window || value.start < start) return { window, start, spend: 0, sampledAt: null, seats: [], spent: null };
    if (value.start > start) return { ...value, start, spend: Infinity, spent: `the ledger's window starts ${new Date(value.start).toISOString()}, after this clock's ${new Date(start).toISOString()}; the clock moved backwards, so the budget is treated as spent` };
    return { ...value, spend: value.spent ? Infinity : value.spend };
  }
  /** Charge the interval since the last sample at `price` per seat-hour, then store this sample's live seats. */
  function record(window, now, seats, price = 1) {
    const start = windowStart(window, now);
    const value = stored();
    let spend = 0;
    let spent = null;
    if (value && value.window === window && value.start === start) {
      ({ spend, spent } = value);
      if (now < value.sampledAt) spent ??= `the clock moved backwards from ${new Date(value.sampledAt).toISOString()} to ${new Date(now).toISOString()}; seat use since then is unknown, so the budget is treated as spent until the next ${window}`;
      else spend += new Set([...value.seats, ...seats]).size * price * (now - value.sampledAt) / HOUR;
    } else if (value && value.window === window && value.start > start) {
      spent = `the ledger's window starts ${new Date(value.start).toISOString()}, after this clock's ${new Date(start).toISOString()}; the clock moved backwards, so the budget is treated as spent`;
    } else if (value && value.window === window && value.sampledAt <= now) {
      // The last sample is from an earlier window: its seats and this sample's may have run since this window began.
      spend = new Set([...value.seats, ...seats]).size * price * (now - Math.max(start, value.sampledAt)) / HOUR;
    } else {
      // No record for this window: nothing proves when the seats live now began.
      spend = seats.length * price * (now - start) / HOUR;
      if (value && value.window === window) spent = `the ledger's last sample ${new Date(value.sampledAt).toISOString()} is after this clock's ${new Date(now).toISOString()}; the clock moved backwards, so the budget is treated as spent`;
    }
    const next = { window, start, spend, sampledAt: Math.max(now, value?.window === window && value.start === start ? value.sampledAt : now), seats: [...new Set(seats)], spent };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(next));
    renameSync(`${file}.tmp`, file);
    return { ...next, spend: spent ? Infinity : spend };
  }
  return { read, record };
}

/** The line the supervisor prints for each cycle, naming what limits the count. */
export function scaleLine(plan) {
  const why = plan.spent ? `a budget treated as spent: ${plan.spent}` : plan.binding === 'budget' ? `${plan.leftSpend.toFixed(1)} of ${plan.budget.spend} spend left this ${plan.budget.window}, enough for ${plan.affordable}`
    : plan.binding === 'worth' ? `${plan.worth} worth running` : plan.binding === 'unknown-worth' ? 'the four-seat cap while worth running is unknown' : 'the waiting work';
  return `workers: ${plan.running} live on this machine, target ${plan.target} (limited by ${why}${plan.worthKnown ? '' : '; worth running is unknown, capped at four'})`
    + `${plan.launch ? `; launching ${plan.launch}` : ''}${plan.stopped?.length ? `; stopped idle ${plan.stopped.join(', ')}` : ''}`
    + `${plan.opened?.length ? `; opened ${plan.opened.map(open => `a ${open.family} reviewer on ${open.route} for ${open.for} reviews`).join(', ')}` : ''}`
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
  if (!budget || !budget.spend) throw new Refused('WORKER_BUDGET_UNSET', 'set the spend per day this machine may use first: pullboard settings workers.budget 40/day');
  const lane = values.lane;
  if (values.route !== undefined && !store.ROUTES.includes(values.route)) throw new Refused('BAD_ROUTE', 'choose --route light, mid or strong before launching workers');
  const command = String(values.agent ?? '').trim();
  if (!lane || !command) {
    throw new Refused('USAGE', 'pullboard run --scale --lane <lane> --agent "<command>": the command starts one agent session in the worker worktree ($PULLBOARD_PROMPT) that takes work with pullboard next --take');
  }
  const model = String(process.env.PULLBOARD_MODEL ?? '').trim();
  if (!model || /[\u0000-\u001f\u007f-\u009f]/u.test(model)) {
    throw new Refused('MODEL_REQUIRED', 'this session has not declared its model; set PULLBOARD_MODEL in this shell, then rerun pullboard run --scale');
  }
  const route = values.route ?? modelTierRoute(model, ctx.config.modelTiers);
  const every = Number(values.every ?? '60');
  const cycles = values.cycles === undefined ? Infinity : Number(values.cycles);
  if (!Number.isInteger(every) || every < 5 || every > 3600) throw new Refused('USAGE', '--every is whole seconds from 5 to 3600');
  if (cycles !== Infinity && (!Number.isInteger(cycles) || cycles < 1)) throw new Refused('USAGE', '--cycles is a whole number, 1 or more');
  const cycleHours = every / 3600;
  const sleep = deps.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;
  const ledger = deps.ledger ?? workerLedger();
  const running = new Map(); // A launch reservation counts before spawn or the first heartbeat.
  const owned = new Map(); // Only this supervisor's worktrees may be recycled or removed.
  const retired = new Set(); // Recycle the worktree under a fresh binding after a completed native session.
  const parked = []; // joined worker worktrees whose agent process has exited, reused before making another
  const quiet = sink => ({ ...io, say() {}, err: message => io.err?.(message), result: value => { sink.value = value; } });
  const ports = {
    observe: () => deps.withBoard(ctx, board => {
      const args = { lane, managed: [...running.keys()], inactive: parked.map(seat => seat.id), route, now: now() };
      const observed = deps.observe ? deps.observe(board, args) : observeWorkers(board, args);
      const used = ledger.record(budget.window, now(), observed.workers.map(worker => worker.id), seatHourPrice(model));
      return { ...observed, model, budget, usedSpend: used.spend, spent: used.spent, cycleHours, hoursLeft: workerWindowHours(budget.window, now()) };
    }),
    isIdle: id => deps.withBoard(ctx, board => !seatHoldsWork(board, id)),
    stop: id => {
      const child = running.get(id)?.child;
      if (!child?.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    },
    launch: async (open) => {
      const seatRoute = open?.route ?? route, seatFamily = open?.family ?? values.family ?? null;
      let seat = open ? undefined : parked.shift();
      if (seat && retired.has(seat.id)) {
        const old = seat;
        const made = {};
        try { await deps.worktreeFor(quiet(made), lane, seatRoute, seatFamily, model, true, { reuseRoot: old.path }); }
        catch (error) { parked.unshift(old); throw error; }
        owned.delete(old.id);
        retired.delete(old.id);
        seat = { id: made.value.agent, path: made.value.path, prompt: made.value.prompt };
      }
      if (!seat) {
        if (owned.size >= (ports.target ?? 0) + 2) throw new Refused('WORKER_WORKTREE_LIMIT', 'the worker worktree pool is full; finish or preserve its parked work before launching another seat');
        const made = {};
        await deps.worktreeFor(quiet(made), lane, seatRoute, seatFamily, model);
        seat = { id: made.value.agent, path: made.value.path, prompt: made.value.prompt };
      }
      if (typeof seat.id !== 'string' || !seat.id || typeof seat.path !== 'string') throw new Refused('WORKER_SEAT_IDENTITY', 'worktree creation must return its registered seat id and path before an agent can launch');
      owned.set(seat.id, seat);
      const entry = { child: null, seat };
      running.set(seat.id, entry);
      const env = { ...process.env, PULLBOARD_SEAT: seat.id, PULLBOARD_ROUTE: seatRoute, PULLBOARD_MODEL: model,
        PULLBOARD_PROMPT: `${seat.prompt}\nThis seat is already joined on --route ${seatRoute}; keep that route on any join. Take work with pullboard next --take until it has nothing for you, then stop.` };
      /** Reap exactly this launch once; an old child can never remove a newer incarnation of its seat. */
      const finished = error => {
        if (running.get(seat.id) !== entry) return;
        running.delete(seat.id);
        parked.push(seat);
        if (error) io.err?.(`worker ${seat.id} failed to launch: ${error.message}`);
      };
      try {
        entry.child = (deps.spawn ?? spawn)(command, { cwd: seat.path, env, shell: true, detached: true, stdio: 'ignore' });
        entry.child.once('error', finished);
        entry.child.once('close', () => finished());
      } catch (error) { finished(error); throw error; }
      io.say(`launched ${seat.id} in ${seat.path}`);
    },
  };
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (cycle) await sleep(every * 1000);
    for (const [id, entry] of running) {
      const handedOff = deps.withBoard(ctx, board => Boolean(exitedSession(board, id)) && !seatHoldsWork(board, id));
      if (handedOff && running.get(id) === entry && entry.child?.exitCode === null && entry.child?.signalCode === null) {
        retired.add(id);
        ports.stop(id); // Only this supervisor's still-owned child, after its atomic summary/release.
      }
    }
    const observed = await ports.observe();
    const plan = planWorkerScale(observed);
    ports.target = plan.target;
    // Retain at most two clean spare worktrees after a target drops. Dirty or held work is preserved.
    for (let index = parked.length - 1; owned.size > plan.target + 2 && index >= 0; index -= 1) {
      const seat = parked[index];
      if (!await ports.isIdle(seat.id) || !deps.removeWorktree || !await deps.removeWorktree(io, seat.path)) continue;
      parked.splice(index, 1); owned.delete(seat.id); retired.delete(seat.id);
    }
    io.say(scaleLine(await scaleCycle({ ...ports, observe: () => observed })));
  }
  return 0;
}
