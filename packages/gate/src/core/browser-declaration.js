/**
 * A test file declares that it launches a browser with one first-line comment [C7]. Reading that line is
 * the whole decision: no import parsing, no guessing. Absent the marker, the file holds no browser lease,
 * and the shared Chrome launcher refuses to start Chrome in its process (BROWSER_UNDECLARED).
 */

/** The exact first line that declares browser need. */
export const BROWSER_MARKER = '// pullboard: browser';

/**
 * Whether a test file's source declares browser need: its first line, without a byte-order mark or
 * trailing blanks, is exactly the marker.
 *
 * @param {string} source - the file's text
 * @returns {boolean}
 */
export function declaresBrowser(source) {
  if (typeof source !== 'string') return false;
  const first = source.replace(/^﻿/u, '').split(/\r?\n/u, 1)[0];
  return first.trimEnd() === BROWSER_MARKER;
}
