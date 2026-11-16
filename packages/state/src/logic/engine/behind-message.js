/**
 * Name the release that first shipped an engine, from a floor list [{ engine, release }] taken from the engine registry's
 * history: the release of the highest floor at or below the engine, or null when none is known.
 * Why: people know releases, never engine numbers [H16,C7].
 */
function releaseOf(engine, releases) {
  const floors = [...releases].sort((a, b) => a.engine - b.engine).filter(floor => floor.engine <= engine);
  return floors.at(-1)?.release ?? null;
}

/**
 * The message a move shows when a teammate's device runs an older engine: who is behind (device and seat), the release
 * they run, the release needed, and the one command that fixes it. Pure; never prints a bare engine number [H16,C7].
 *
 * @param {{ device: string, seat: string, running: number, needed: number, releases: { engine: number, release: string }[] }} input
 * @returns {string}
 */
export function behindMessage({ device, seat, running, needed, releases }) {
  const have = releaseOf(running, releases);
  const want = releaseOf(needed, releases);
  return `${device} (seat ${seat}) runs ${have ? `Pullboard ${have}` : 'an older Pullboard'}, but this move needs ${want ? `Pullboard ${want}` : 'a newer one'}; run pullboard update on ${device}`;
}
