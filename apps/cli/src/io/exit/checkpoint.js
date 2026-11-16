/** Seal seat.checkpoints into a claim's exit policy, so an exit-rule stop records the same checkpoint on every machine that replays it [C7,#8553]. */

/**
 * The exit policy a claim captures: the configured exitRules, plus checkpoints: true only when seat.checkpoints is on.
 *
 * Why sealed at the claim: the stop happens in a later move, and a replica replaying it must not read its own, possibly different, setting.
 *
 * @param {{ seat?: { checkpoints?: boolean } }} config The checkout's configuration.
 * @param {{ enabled: boolean, tokens: number, calls: number }} exitRules The accepted exit policy.
 * @returns {object} The policy to freeze into the claim; the same object when the setting is off.
 */
export function sealExitCheckpoints(config, exitRules) {
  return config.seat?.checkpoints === true ? { ...exitRules, checkpoints: true } : exitRules;
}
