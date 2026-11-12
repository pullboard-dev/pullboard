/** Shared kit for the liveness chaos children: run one flow, break a holder at a named step, read what the board did alone [C7]. */
import { rmSync } from 'node:fs';
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

/**
 * The flow steps the kit can break. Each runs the real CLI up to its step and returns the item and the holder it left.
 * Children for submit, gate, verify and land add their step here.
 */
const STEPS = {
  async claim(box, id) {
    const claimed = await cli(box, box.seats.builder.path, ['claim', String(id)]);
    if (claimed.code !== 0) throw new Refused('LIVENESS_STEP_FAILED', `claim ran red before the fault: ${claimed.out}${claimed.err}`);
    return { holder: box.seats.builder, done: item => item.item_status !== 'claimed' && item.item_owner !== box.seats.builder.id };
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
  while (!flow.done(item) && box.clock.now().getTime() - start <= 2 * LIVENESS_BOUND_MS) {
    box.advance(TICK_MS);
    await cli(box, survivor.path, ['shout', 'all', '--kind', 'idea', 'Liveness kit: the surviving seat writes while a holder is gone.']);
    item = await readItem(box, id);
  }
  return { step, fault, victim: victim.id, state: item.item_status, owner: item.item_owner ?? null, elapsedMs: box.clock.now().getTime() - start, id };
}
