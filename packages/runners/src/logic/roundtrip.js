/** Name each phase of one runner round trip and which side of the transport pays for it [C7]. */

/**
 * The phases of one pulled dispatch, in order: each runs from its mark to the next one's. A phase is the controller's
 * when its time is spent on this machine (starting the submit controller, building the request, enqueueing it,
 * packing and sending history, fetching and checking the result); the rest is the runner's work as the mirror sees it.
 */
export const ROUND_TRIP_PHASES = Object.freeze([
  { name: 'launch', from: 'dispatch', to: 'prepare', side: 'controller' },
  { name: 'prepare', from: 'prepare', to: 'prepared', side: 'controller' },
  { name: 'enqueue', from: 'prepared', to: 'submitted', side: 'controller' },
  { name: 'need', from: 'submitted', to: 'need', side: 'runner' },
  { name: 'transfer', from: 'need', to: 'source-sent', side: 'controller' },
  { name: 'checkout', from: 'source-sent', to: 'ready', side: 'runner' },
  { name: 'run', from: 'ready', to: 'done', side: 'runner' },
  { name: 'collect', from: 'done', to: 'end', side: 'controller' },
]);

/**
 * Turn a dispatch's phase marks (epoch ms, as runOnRunnerAsync returns them in `phases`) into named phase times.
 * A phase whose marks are missing or out of order has a null time and counts toward neither side; a trip whose runner
 * already held the source asks for none, so its `need` and `transfer` are null and checkout runs from `submitted`.
 * Why: a round trip cost 26-37 s on 15 Nov, about 11 s of it on the runner; this names where the rest went (#8129).
 *
 * @param {Record<string, number>|null} marks - Phase marks; `end` is when the caller had the result.
 * @returns {{ phases: { name: string, side: string, ms: number|null }[], controllerMs: number, runnerMs: number, totalMs: number|null }}
 */
export function roundTripProfile(marks) {
  const at = name => Number.isSafeInteger(marks?.[name]) ? marks[name] : null;
  const phases = ROUND_TRIP_PHASES.map(({ name, from, to, side }) => {
    const start = name === 'checkout' && at('source-sent') === null ? at('submitted') : at(from), end = at(to);
    return { name, side, ms: start !== null && end !== null && end >= start ? end - start : null };
  });
  const sum = side => phases.reduce((total, phase) => total + (phase.side === side && phase.ms !== null ? phase.ms : 0), 0);
  const first = at('dispatch'), last = at('end');
  return { phases, controllerMs: sum('controller'), runnerMs: sum('runner'),
    totalMs: first !== null && last !== null && last >= first ? last - first : null };
}

/** One line naming every phase's seconds, controller phases first marked with a star. */
export function roundTripLine(profile) {
  const parts = profile.phases.map(phase => `${phase.side === 'controller' ? '*' : ''}${phase.name} ${phase.ms === null ? '-' : (phase.ms / 1000).toFixed(1) + 's'}`);
  return `round trip: ${parts.join(', ')}; controller ${(profile.controllerMs / 1000).toFixed(1)}s, total ${profile.totalMs === null ? '-' : (profile.totalMs / 1000).toFixed(1) + 's'}`;
}
