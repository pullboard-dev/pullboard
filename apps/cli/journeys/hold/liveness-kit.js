/** Shared kit for the liveness chaos children: run one flow, break a holder at a named step, read what the board did alone [C7]. */
import {
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  claimJob,
  offerJob,
} from '../../../../packages/api/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import {
  cli,
  fixture,
} from '../../tests/fixtures/next/take.js';

/** How far the fake clock moves between board writes by the surviving seat, in milliseconds. */
export const TICK_MS = 15_000;

/** The longest the board may take to finish or reopen the item with no person action: three fake minutes. */
export const LIVENESS_BOUND_MS = 3 * 60_000;

/** The faults the kit can inject: a killed holder loses its process and checkout, a cut link loses only its board connection. */
export const FAULTS = Object.freeze(['kill', 'cut']);

/** Read the item as the board's own `show` answers it, so the kit never reaches into the store. */
async function readItem(box, id) {
  const shown = await cli(box, box.root, ['show', String(id)]);
  if (shown.code !== 0) throw new Refused('LIVENESS_STEP_FAILED', `show ran red: ${shown.out}${shown.err}`);
  return shown.document;
}

/** Whether the board moved a job off the runner that held it: another runner holds it, or it ended. The board's lease expiry does this alone, with no person acting [C7]. */
function jobMoved(box, job, runner) {
  const row = box.board.db.prepare('SELECT job_lease_owner AS owner, job_step AS step FROM job WHERE job_id = ?').get(job);
  return !row || !['offered', 'claimed'].includes(row.step) || (row.owner !== runner && row.step === 'claimed');
}

/** A live fixture runner polling for the job each tick, as a real runner does; it takes the job once the dead holder's lease has lapsed. */
function livePoll(box, id, kind) {
  return async () => {
    const taken = claimJob(box.board.db, { runner: `runner-live-${id}`, kinds: [kind], now: box.clock.now().getTime() });
    return { code: taken ? 0 : 1, out: taken ? `took ${taken.job}` : 'no job free yet', err: '' };
  };
}

/**
 * The flow steps the kit can break. Each runs the real CLI up to its step and returns the item and the holder it left.
 * Children for land add their step here.
 */
const STEPS = {
  async claim(box, id) {
    const claimed = await cli(box, box.seats.builder.path, ['claim', String(id)]);
    if (claimed.code !== 0) throw new Refused('LIVENESS_STEP_FAILED', `claim ran red before the fault: ${claimed.out}${claimed.err}`);
    return { holder: box.seats.builder, done: item => item.item_status !== 'claimed' && item.item_owner !== box.seats.builder.id };
  },
  async submit(box, id) {
    box.submit(id); // the submit is the work done: past it the board owns the item, so a dead holder cannot strand it
    return { holder: box.seats.builder, done: item => item.item_status !== 'claimed' };
  },
  async verify(box, id) {
    box.submit(id);
    // A second seat, in another family, holds the verify claim: the reviewer's own `next --verify` reserves the submitted item for it.
    const reviewer = box.seats.outside;
    const reserved = await cli(box, reviewer.path, ['next', '--verify', String(id)]);
    if (reserved.code !== 0) throw new Refused('LIVENESS_STEP_FAILED', `the verify claim ran red before the fault: ${reserved.out}${reserved.err}`);
    // Done: the board freed the reservation or finished the review, so the dead reviewer no longer holds the item.
    // A live reviewer under another parent session asks for the review each tick: once the dead holder's reservation counts for nothing, it takes it over.
    const taker = box.seats.sameFamily;
    return { holder: reviewer, done: item => item.item_status !== 'submitted' || (Boolean(item.item_review_by) && item.item_review_by !== reviewer.id),
      recover: () => cli(box, taker.path, ['next', '--verify', String(id)]) };
  },
  async gate(box, id) {
    box.submit(id); // the real submit comes first: the gate job belongs to the submitted item
    const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
    const job = `gate-${id}`;
    const now = box.clock.now().getTime();
    offerJob(box.board.db, { id: job, kind: 'gate', item: id, candidate: head, now });
    // A fixture runner: its checkout is a folder a kill removes; a cut link only stops it renewing the lease it holds.
    const path = join(box.root, '..', `runner-${id}`);
    mkdirSync(path, { recursive: true });
    const runner = `runner-fixture-${id}`;
    const claim = claimJob(box.board.db, { runner, kinds: ['gate'], now });
    if (claim?.job !== job) throw new Refused('LIVENESS_STEP_FAILED', `the fixture runner could not take gate job ${job}`);
    return { holder: { id: runner, path, lane: 'runner' }, job, done: item => item.item_status !== 'submitted' || jobMoved(box, job, runner), recover: livePoll(box, id, 'gate') };
  },
  async land(box, id) {
    box.submit(id); // an accepted item is the land job's input: the real submit comes first, then the one land job the board offers for it
    const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
    const job = `land-${id}`;
    const now = box.clock.now().getTime();
    offerJob(box.board.db, { id: job, kind: 'land', item: id, candidate: head, now });
    // A fixture lander: its checkout is a folder a kill removes; a cut link only stops it renewing the lease it holds on the land job.
    const path = join(box.root, '..', `lander-${id}`);
    mkdirSync(path, { recursive: true });
    const runner = `lander-fixture-${id}`;
    const claim = claimJob(box.board.db, { runner, kinds: ['land'], now });
    if (claim?.job !== job) throw new Refused('LIVENESS_STEP_FAILED', `the fixture lander could not take land job ${job}`);
    // Done: the item landed, or the board freed the job so a live lander took it over. The item itself never waits on a dead lander.
    return { holder: { id: runner, path, lane: 'runner' }, job, done: item => ['verified', 'withdrawn', 'open'].includes(item.item_status) || jobMoved(box, job, runner), recover: livePoll(box, id, 'land') };
  },
};

/** The step names the kit knows. */
export const STEP_NAMES = Object.freeze(Object.keys(STEPS));

/** A small seeded generator, so a "random" runner is the same runner on every rerun of a seed. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

/**
 * Run one pullboard flow on a fixture board, break one holder at the named step, and let the board act alone.
 * The fixture clock is fake: only the surviving seat's ordinary heartbeat and board write run between ticks, so a
 * three-minute bound costs no wall time and no person or coordinator acts.
 * Why: the liveness rule is that a dead holder never keeps its place; each step's child proves it with this one kit.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ step: string, fault?: 'kill'|'cut', seed?: number }} options `kill` removes the holder's checkout and heartbeat; `cut` only stops its heartbeat and writes; the seed picks which holder breaks.
 * @returns {Promise<{ step: string, fault: string, victim: string, state: string, owner: string|null, elapsedMs: number, id: number }>} the final item state and the fake-clock time the board took
 */
export async function runLivenessFlow(t, { step, fault = 'kill', seed = 1 } = {}) {
  if (!STEPS[step]) throw new Refused('LIVENESS_STEP', `unknown step "${step}": choose one of ${STEP_NAMES.join(', ')}`);
  if (!FAULTS.includes(fault)) throw new Refused('LIVENESS_FAULT', `unknown fault "${fault}": choose one of ${FAULTS.join(', ')}`);
  const box = await fixture(t);
  const id = box.add(`Liveness flow broken at ${step}`);
  const flow = await STEPS[step](box, id);
  // The seeded pick names the runner to break among every seat that holds work at this step.
  const victim = [flow.holder][Math.floor(seeded(seed)() * 1)];
  const survivor = box.seats.actor;
  if (fault === 'kill') rmSync(victim.path, { recursive: true, force: true });
  const start = box.clock.now().getTime();
  let item = await readItem(box, id);
  let recovered = null;
  while (!flow.done(item) && box.clock.now().getTime() - start <= 2 * LIVENESS_BOUND_MS) {
    box.advance(TICK_MS);
    if (flow.recover) recovered = await flow.recover();
    await cli(box, survivor.path, ['shout', 'all', '--kind', 'idea', 'Liveness kit: the surviving seat writes while a holder is gone.']);
    item = await readItem(box, id);
  }
  return { step, fault, victim: victim.id, state: item.item_status, owner: item.item_owner ?? null, elapsedMs: box.clock.now().getTime() - start, id, ...(recovered ? { recovery: `${recovered.code}: ${recovered.out}${recovered.err}`.slice(0, 400) } : {}) };
}
