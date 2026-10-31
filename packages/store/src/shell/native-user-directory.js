/** Read the current account's native macOS working directory without browser-specific policy [C7]. */
import { execFileSync } from 'node:child_process';

/** Keep the fixed getconf invocation separate from consumers' application-specific path names. */
export function nativeUserDirectory() {
  return execFileSync('/usr/bin/getconf', ['DARWIN_USER_DIR'], { encoding: 'utf8', timeout: 2_000 }).trim();
}
