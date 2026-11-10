/** Landing's finish sequence as one exported function the automatic lander and a hand landing both call [C7]. */
import { postLandSuite } from './post/land.js';
import { refreshLandedMain } from './deferred/notices.js';
import { amendLandingEngines } from './step/merge.js';
import { moveTrunkRef } from './step/publish.js';
import { refreshPublishedMainReds } from './step/publish.js';

/** The finish steps in the order they run; amendLandingEngines also refreshes the landing docs and places new history paths. */
export const LANDING_FINISH_STEPS = Object.freeze(['amendLandingEngines', 'gate', 'moveMain', 'refreshMainReds', 'refreshLandedMain', 'postLandSuite', 'activateMainAudits', 'returnStaleVerdicts']);

/**
 * The default function for each finish step. A step with no default (the gate, the main audits, the stale-verdict
 * return) must be given by the caller or named in `earlier`, because the automatic lander does it before the finish.
 */
const DEFAULT_STEPS = Object.freeze({
  amendLandingEngines: (state) => amendLandingEngines(state.batch.root, state.hooks ?? []),
  moveMain: (state) => moveTrunkRef(state),
  refreshMainReds: (state) => refreshPublishedMainReds(state, state.batch.base),
  refreshLandedMain: (state) => refreshLandedMain(state),
  postLandSuite: (state) => postLandSuite(state, state.landingPorts?.postLandSuite),
});

/**
 * Run the landing finish steps in order and return one record of what each did.
 *
 * Why: the automatic lander and a hand landing must finish the same way, so the order lives here once. A step the
 * caller already did before the finish is named in `earlier` and recorded as such. A refusing step stops the
 * sequence; its error is rethrown unchanged with the record on `error.finish`, so a caller can report which step refused.
 *
 * @param {object} state - The landing state every step reads.
 * @param {{steps?: Record<string, Function>, earlier?: string[]}} [options] - Step functions replacing the defaults, and the steps already done.
 * @returns {Promise<{steps: Array<{name: string, status: 'ran'|'earlier'|'refused', result?: unknown, code?: string, message?: string}>, refused: string|null}>}
 */
export async function finishLanding(state, { steps = {}, earlier = [] } = {}) {
  const record = { steps: [], refused: null };
  for (const name of LANDING_FINISH_STEPS) {
    const run = steps[name] ?? (earlier.includes(name) ? null : DEFAULT_STEPS[name]);
    if (!run) {
      if (!earlier.includes(name)) throw new TypeError(`landing finish step ${name} needs a function or a place in earlier`);
      record.steps.push({ name, status: 'earlier' });
      continue;
    }
    try {
      record.steps.push({ name, status: 'ran', result: await run(state) });
    } catch (error) {
      record.steps.push({ name, status: 'refused', code: error?.code, message: error?.message });
      record.refused = name;
      try { error.finish = record; } catch { /* a frozen error still propagates */ }
      throw error;
    }
  }
  return record;
}
