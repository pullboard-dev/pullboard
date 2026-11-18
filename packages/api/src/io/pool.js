/**
 * The board API's handler pool: worker threads that run request handlers, each opening its own board connections, so
 * the request thread only accepts, routes and answers health and busy [A2,C7]. Why: node:sqlite and Git reads are
 * synchronous, and one slow handler on the request thread froze every runner's claim and renew for 10 hours (#6730).
 * A call never falls back to the request thread: with every worker busy past the queue wait it is refused API_BUSY,
 * a worker past the call deadline is replaced, and a worker that dies is replaced and its call refused.
 * A runner's job call (claim, renew, progress, receipt) has its own lane: it waits ahead of agent calls, and a worker is
 * kept for it that agent calls never take, so agent moves filling the pool cannot starve the runners (#10786).
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { workerError } from './state/materializer.js';

/** How long a call may wait for a free worker before it is refused API_BUSY. */
const QUEUE_MS = 1_000;
/** How many calls may wait per worker; one more is refused API_BUSY at once. */
const QUEUED_PER_WORKER = 8;
/** How long one call may hold a worker before the worker is ended and replaced. */
const CALL_MS = 120_000;
/**
 * How many workers only runner job calls may take. Why: on 17 Nov ~20 agents' moves held every worker, every runner
 * claim and renewal was refused API_BUSY, 62 test jobs sat queued with six runners idle and landings stopped (#10786).
 */
const RUNNER_WORKERS = 1;

/** The pool size this machine's cores give: one core stays with the request thread, and at least two workers run. */
export function handlerPoolSize(cores = availableParallelism()) {
  return Math.max(2, Math.min(8, cores - 1));
}

/**
 * Start a handler pool.
 *
 * @param {{ portsModule: string, isMain?: boolean, size?: number, queueMs?: number, callMs?: number, runnerWorkers?: number, Refused: Function, onFailure?: Function }} options
 * portsModule names a module whose boardHandlerPorts() gives each worker its board openers and providers, composed
 * inside the worker, which cannot be handed functions from the request thread. runnerWorkers: how many workers agent
 * calls leave to runner job calls; at least one worker always stays open to agent calls.
 */
export function startHandlerPool({ portsModule, isMain, size = handlerPoolSize(), queueMs = QUEUE_MS, callMs = CALL_MS, runnerWorkers = RUNNER_WORKERS, Refused, onFailure }) {
  // The worker takes none of this process's preloads, as the state worker does: a test runner's preload run again
  // in a thread claims the file's test slot a second time [C7].
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  const slots = [];
  // Agent calls (moves, requests, reads) wait in `queue`; runner job calls wait in `runnerQueue`, served first.
  const queue = [];
  const runnerQueue = [];
  const reserved = Math.max(0, Math.min(runnerWorkers, size - 1));
  let nextId = 0;
  let closed = false;

  /** A refusal naming a full pool, so a client backs off instead of waiting on a hung call. */
  const busy = (route, runner) => new Refused('API_BUSY', `every one of the API's ${runner ? size : size - reserved} handler workers ${runner ? '' : 'open to agent calls '}is busy, so ${route} was not started; retry in a few seconds`);
  /** A free worker this call may take: a runner call takes any; an agent call leaves the kept workers to runner calls. */
  function freeFor(call) {
    const free = slots.find((slot) => !slot.call);
    if (!free || call.runner) return free ?? null;
    return slots.filter((slot) => slot.call && !slot.call.runner).length < size - reserved ? free : null;
  }

  /** Start one worker in a slot; a worker that exits or fails refuses its call and is replaced. */
  function spawn(slot) {
    const worker = new Worker(new URL('./pool/worker.js', import.meta.url), { workerData: { portsModule, isMain }, execArgv: [], env });
    slot.worker = worker;
    slot.call = null;
    worker.on('message', (message) => {
      const call = slot.call;
      if (!call || call.id !== message.id) return;
      finish(slot);
      if (message.error) call.fail(workerError(message.error, Refused));
      else call.ok(message.value);
    });
    const lost = (error) => {
      if (slot.worker !== worker || closed) return;
      const call = slot.call;
      clearTimeout(slot.deadline);
      onFailure?.(error);
      call?.fail(new Refused('API_WORKER_FAILED', `the handler worker running ${call.route} stopped (${error?.message ?? error}); retry`));
      if (closed) return;
      spawn(slot);
      next();
    };
    worker.on('error', lost);
    worker.on('exit', (code) => lost(new Error(`exited with code ${code}`)));
  }
  /** Free a slot after its call answered and hand it the next queued call. */
  function finish(slot) {
    clearTimeout(slot.deadline);
    slot.call = null;
    next();
  }
  /** Run a call on a free worker, ending that worker if the call outlives its deadline. */
  function run(slot, call) {
    slot.call = call;
    slot.started = Date.now();
    slot.deadline = setTimeout(() => {
      if (slot.call !== call) return;
      call.fail(new Refused('API_CALL_TIMEOUT', `${call.route} ran past ${callMs} ms, so its worker was replaced; retry`));
      slot.call = null;
      void slot.worker.terminate();
    }, callMs);
    slot.worker.postMessage({ id: call.id, kind: call.kind, args: call.args });
  }
  /** Give each free worker the oldest queued call it may take: runner job calls first, then agent calls. */
  function next() {
    for (const lane of [runnerQueue, queue]) {
      while (lane.length) {
        const slot = freeFor(lane[0]);
        if (!slot) break;
        const call = lane.shift();
        clearTimeout(call.timer);
        run(slot, call);
      }
    }
  }
  for (let index = 0; index < size; index++) { const slot = { worker: null, call: null, deadline: null, started: 0 }; slots.push(slot); spawn(slot); }

  return {
    size,
    /**
     * Run one handler in the pool and answer with its value or refusal. A call that finds no worker it may take waits
     * up to queueMs in a bounded queue and is then refused API_BUSY; an internal call (a stall record) waits
     * without a limit, behind the queue. A runner call (`runner`: a runner's job call and its board lookup) waits in
     * its own queue, served before agent calls, and may take the workers agent calls leave to it (#10786).
     */
    call(kind, args, { route = kind, internal = false, runner = false } = {}) {
      if (closed) return Promise.reject(new Refused('API_CLOSED', 'the API is closing; retry against the restarted server'));
      return new Promise((ok, fail) => {
        const call = { id: ++nextId, kind, args, route, runner, ok, fail, timer: null };
        const lane = runner ? runnerQueue : queue;
        const free = lane.length ? null : freeFor(call);
        if (free) return run(free, call);
        if (!internal && lane.length >= size * QUEUED_PER_WORKER) return fail(busy(route, runner));
        if (!internal) call.timer = setTimeout(() => { const at = lane.indexOf(call); if (at !== -1) lane.splice(at, 1); fail(busy(route, runner)); }, queueMs);
        lane.push(call);
      });
    },
    /** What health reports: the pool size, the workers kept for runner job calls, the workers holding a call and for how long, and the queued calls. */
    health(now = Date.now()) {
      const held = slots.filter((slot) => slot.call);
      return { workers: size, runnerWorkers: reserved, busy: held.length, queued: queue.length + runnerQueue.length, oldestMs: held.length ? now - Math.min(...held.map((slot) => slot.started)) : 0 };
    },
    /** End every worker and refuse every queued call. */
    close() {
      closed = true;
      for (const call of [...runnerQueue.splice(0), ...queue.splice(0)]) { clearTimeout(call.timer); call.fail(new Refused('API_CLOSED', 'the API closed before this call ran; retry against the restarted server')); }
      for (const slot of slots) { clearTimeout(slot.deadline); slot.call?.fail(new Refused('API_CLOSED', 'the API closed while this call ran; retry against the restarted server')); slot.call = null; void slot.worker.terminate(); }
    },
  };
}
