/**
 * A refused move: a rule said no. The code names the rule; the message says what to do next (P4).
 */
export class Refused extends Error {
  /**
   * @param {string} code - The rule that refused, in UPPER_SNAKE, e.g. SELF_VERIFY.
   * @param {string} message - Why, and the next step.
   */
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'Refused';
    this.code = code;
  }
}
