/** Explicit computer display names; never derive them from a host or filesystem path [E19]. */
import { Refused } from '../../../kernel/browser.js';

/** Validate a person's optional label before linking or consuming a pairing code. */
export function computerName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f/\\]/u.test(value)) {
    throw new Refused('BAD_COMPUTER_NAME', 'give this computer a name of 1 to 80 characters, without control characters or path separators; retry with --name "<name>"');
  }
  return value.trim();
}
