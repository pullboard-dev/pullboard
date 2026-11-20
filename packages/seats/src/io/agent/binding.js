/** A checkout's local session binding file, read without the lease machinery, so a commit hook can check it cheaply [B3,B7]. */
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';
const fileSystem = fileSystemAdapter();

/** Keep each worktree's binding in its own Git directory rather than the shared common directory. */
export function checkoutSessionFile(info) {
  return join(info.gitDir, 'pullboard-checkout-session.json');
}

/**
 * Whether this checkout is already bound to the invoking agent session. A missing or damaged binding reads as not
 * bound, so the caller takes the full bind, which refuses a damaged one with its next step.
 */
export function sessionBound(info, { agent, digest }) {
  try {
    const value = JSON.parse(fileSystem.readFile(checkoutSessionFile(info), 'utf8'));
    return value.version === 1 && value.agent === agent && value.digest === digest;
  } catch { return false; }
}
