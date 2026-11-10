/** CLI readability heuristic measured against native shouts 27877–28876 [B7,A2]. */
import { Refused } from '../../../kernel/light.js';

/** Refuse glued prose without treating hashes, URLs or discussed literals as prose.
 * @param {string} text
 * @returns {void}
 */
export function requireReadableShout(text) {
  let prose = text.replace(/https?:\/\/[^\s]+/gu, ' ')
    .replace(/\b(?:[a-fA-F0-9]{64}|[a-fA-F0-9]{40})\b/gu, ' ');
  const quotes = /`[^`\n]+`|"[^"\n]+"|(?<![A-Za-z])'[^'\n]+'(?![A-Za-z])/gu;
  const outside = prose.replace(quotes, ' ');
  // A quoted bad example is readable in an explanation, not as the whole message.
  if ((outside.match(/[A-Za-z]{2,}/gu) ?? []).length >= 3) prose = outside;
  if (/[a-z]{25,}|[A-Z]{25,}/u.test(prose)) {
    throw new Refused('SHOUT_SPACES', 'Rewrite the shout with spaces between words.');
  }
}
