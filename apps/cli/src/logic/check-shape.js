/** Whether an item's check command hides its own result, so it could never show a failure [C7,#1273]. */

/** Output sent to /dev/null: `>/dev/null`, `1>>/dev/null` or `&>/dev/null`; a bare `2>/dev/null` hides only errors and is left alone. */
const DISCARDS_OUTPUT = /(?:^|[^0-9>])(?:1|&)?>{1,2}\s*\/dev\/null\b/;
/** An exit forced to success: `|| true`, `|| :`, `; true`, `; exit 0` or `|| exit 0`. */
const MASKS_EXIT = /(?:\|\||;)\s*(?:true|:|exit\s+0)\s*(?:$|[;&|)])/;

/**
 * True when the check discards its output or forces its exit to 0.
 * Why it is pure: the shape of the command alone shows that no run could ever fail it.
 *
 * @param {string | null | undefined} command
 * @returns {boolean}
 */
export function checkHidesResult(command) {
  const text = String(command ?? '');
  return DISCARDS_OUTPUT.test(text) || MASKS_EXIT.test(text);
}
