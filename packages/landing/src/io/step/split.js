/** A red batch under landing.splitRed ends without a bisect; its items land one at a time [C7]. */
import { save } from './merge.js';
import { splitBeatsBisect } from '../../logic/split.js';

/**
 * A red batch of two or more items ends here instead of bisecting when splitting is no dearer by the batch's own
 * measured gate (or landing.splitRed forces it; false forbids it): the batch is recorded
 * blocked with no culprit, the adaptive cap halves, and its items land one at a time on their own full gates, where
 * a red single returns to its builder at once. Why: for a pair, a bisect is two focused gates, a re-merge and a third
 * full gate after the main comparisons, 30-50 minutes on 6 Nov; two singles are two gates [C7].
 */
export async function splitRedBatch(state, gate) {
  const items = (state.batch.items ?? []).length;
  if (items < 2 || state.config?.landing?.splitRed === false) return false;
  let choice = { split: true, reason: 'landing.splitRed' };
  if (state.config?.landing?.splitRed !== true) {
    const failing = new Set((gate.failures ?? []).map(failure => failure?.file).filter(Boolean)).size;
    const planned = new Set((gate.profile?.tests ?? []).map(test => test?.file).filter(Boolean)).size;
    const measured = { items, gateMs: Math.max(1, gate.wallMs ?? 0), fixedMs: gate.setupMs ?? undefined,
      focusShare: planned ? Math.min(1, failing / planned) : undefined };
    if (!gate.wallMs) return false; // No measured gate, no arithmetic: the bisect stands.
    choice = { ...splitBeatsBisect(measured), measured };
    if (!choice.split) {
      state.say(`bisecting: ${items} items, split ${Math.round(choice.splitMs / 60_000)} min vs bisect ${Math.round(choice.bisectMs / 60_000)} min from a ${Math.round(measured.gateMs / 60_000)} min gate`);
      return false;
    }
  }
  await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits ?? [], split: choice,
    refusal: { code: 'LAND_SPLIT', message: 'red batch split: its items land one at a time', at: state.board.clock.now().toISOString() } });
  state.say(`LAND_SPLIT: the batch of ${items} is red; its items land one at a time${choice.splitMs ? ` (split ${Math.round(choice.splitMs / 60_000)} min vs bisect ${Math.round(choice.bisectMs / 60_000)} min)` : ''}`);
  return true;
}
