/** Collect only bounded PNG artifacts from the actual pulled checkout [C7]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';

const disk = fileSystemAdapter();

/** List regular files without following a directory or file symlink. */
function filesUnder(root, relative, files) {
  const entry = disk.lstat(join(root, relative));
  if (entry.isSymbolicLink()) return files;
  if (entry.isDirectory()) for (const name of disk.list(join(root, relative))) filesUnder(root, `${relative}/${name}`, files);
  else if (entry.isFile()) files.push({ path: relative, bytes: entry.size });
  return files;
}

/**
 * Collect the complete set before cleanup, or no artifacts on any read or size refusal.
 * The screenshot policy bounds the set before reading bytes; metadata and bodies are
 * rechecked after reading so a changing file never becomes a partial screenshot set.
 */
export function pulledScreenshots(root, rules) {
  try {
    if (!rules || !disk.exists(join(root, rules.directory))) return null;
    const plan = rules.screenshotPlan(filesUnder(root, rules.directory, []), rules.maxBytes, rules.directory);
    if (!plan.length) return null;
    const screenshots = plan.map(({ path, bytes }) => {
      const entry = disk.lstat(join(root, path));
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== bytes) throw new Error('screenshot changed');
      const data = disk.readFile(join(root, path), null);
      if (data.length !== bytes) throw new Error('screenshot changed');
      return { path, bytes, sha256: createHash('sha256').update(data).digest('hex'), base64: data.toString('base64') };
    });
    return { screenshots, screenshotsSha256: createHash('sha256').update(JSON.stringify(screenshots)).digest('hex') };
  } catch { return null; }
}
