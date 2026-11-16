/** Whether the 9-minute journey-check sample was asked for: only PULLBOARD_JOURNEY_SAMPLE=1 (the freeze or a person) starts it [C7]. */
export function journeySampleAsked(env = process.env) {
  return env.PULLBOARD_JOURNEY_SAMPLE === '1';
}
