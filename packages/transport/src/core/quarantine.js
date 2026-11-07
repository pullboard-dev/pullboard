/** Quarantine is a fact about probes alone: two failed probes at least 30 s apart, with no answer between [C7]. */

export const QUARANTINE_GAP_MS = 30_000;

/**
 * Fold a runner's probe answers, oldest first, into its standing.
 *
 * Why: a channel can end for many reasons that say nothing about the runner (a sleeping laptop lid, a killed
 * driver, a network blip); only the runner failing to answer its own probe twice, half a minute apart, takes it out
 * of service, and one good answer puts it back (design §3, absorbs #3248).
 *
 * @param {{ ok: boolean, at: number }[]} probes
 * @returns {{ quarantined: boolean, failures: number, since: number | null }}
 */
export function probeStanding(probes) {
  let first = null, failures = 0, quarantined = false;
  for (const { ok, at } of probes) {
    if (ok) { first = null; failures = 0; quarantined = false; continue; }
    first ??= at;
    failures += 1;
    if (at - first >= QUARANTINE_GAP_MS) quarantined = true;
  }
  return { quarantined, failures, since: first };
}
