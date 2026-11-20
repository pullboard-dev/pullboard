/** Record the verdict tier 1 alone would give beside a run's real one; it is report-only and never changes a verdict [V4]. */
import { tier1Shadow } from '../../../../verify/index.js';
import { selectTestTiers } from '../test/tier/selection.js';

/**
 * The shadow fact for one run: the real verdict and failing tests, judged against the tests the change can reach.
 * Any trouble working out the reach leaves it unknown (every failing test then counts), and any other trouble gives
 * no fact, because a shadow must never fail or alter the run it describes.
 *
 * @param {string} root
 * @param {{ head: string | null, main: string | null, green: boolean, failures: {file: string, name: string}[] }} run
 * @returns {ReturnType<typeof tier1Shadow> | null}
 */
export function shadowOfRun(root, { head, main, green, failures }) {
  try {
    let reachable = null;
    try {
      const plan = head && main ? selectTestTiers(root, { base: main, commit: head }) : null;
      if (plan) reachable = plan.units;
    } catch { /* An unreadable reach stays unknown. */ }
    return tier1Shadow({ real: green, failures, reachable });
  } catch { return null; }
}
