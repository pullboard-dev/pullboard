import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STDERR_CAP = 64 * 1024;

/**
 * Keep the runner bridge's stderr beside raw.log as stderr.log, capped at 64 KiB; returns the path, or null when empty.
 * Why: a step that dies prints its reason on stderr, and the Mac kept only stdout, so a red said nothing [C7].
 */
export function keepRunnerStderr(directory, result) {
  const text = String(result?.stderr ?? '');
  if (!text) return null;
  const file = join(directory, 'stderr.log');
  writeFileSync(file, Buffer.from(text, 'utf8').subarray(0, STDERR_CAP), { mode: 0o600 });
  return file;
}
