import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { join } from 'node:path';

const STDERR_CAP = 64 * 1024;

/** Write a file this user alone can read: it is created with mode 0600, as writeFileSync with that mode did. */
function writePrivate(file, data) {
  const bytes = Buffer.from(data);
  const fd = fileSystemAdapter().open(file, 'w', 0o600);
  try {
    for (let at = 0; at < bytes.length;) at += fileSystemAdapter().write(fd, bytes, at);
  } finally { fileSystemAdapter().close(fd); }
}

/**
 * Keep the runner bridge's stderr beside raw.log as stderr.log, capped at 64 KiB; returns the path, or null when empty.
 * Why: a step that dies prints its reason on stderr, and the Mac kept only stdout, so a red said nothing [C7].
 */
export function keepRunnerStderr(directory, result) {
  const text = String(result?.stderr ?? '');
  if (!text) return null;
  const file = join(directory, 'stderr.log');
  writePrivate(file, Buffer.from(text, 'utf8').subarray(0, STDERR_CAP));
  return file;
}
