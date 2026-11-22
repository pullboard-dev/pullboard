/** Collect only bounded PNG artifacts from the actual pulled checkout [C7]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';

const disk = fileSystemAdapter();

/** List regular files without following a directory or file symlink. */
function filesUnder(root, relative, files, identities) {
  const entry = disk.lstat(join(root, relative));
  if (entry.isSymbolicLink()) return files;
  identities.set(relative, entry);
  if (entry.isDirectory()) for (const name of disk.list(join(root, relative))) filesUnder(root, `${relative}/${name}`, files, identities);
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
    const identities = new Map(), canonicalRoot = disk.realpath(root);
    const plan = rules.screenshotPlan(filesUnder(root, rules.directory, [], identities), rules.maxBytes, rules.directory);
    if (!plan.length) return null;
    const screenshots = plan.map(({ path, bytes }) => {
      const expected = identities.get(path);
      const parentsUnchanged = () => {
        const parts = path.split('/');
        for (let count = 1; count < parts.length; count++) {
          const parent = parts.slice(0, count).join('/'), before = identities.get(parent), now = disk.lstat(join(root, parent));
          if (!before || !now.isDirectory() || now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino
            || disk.realpath(join(root, parent)) !== join(canonicalRoot, parent)) throw new Error('screenshot parent changed');
        }
      };
      parentsUnchanged();
      const fd = disk.open(join(root, path), disk.constants.O_RDONLY | disk.constants.O_NOFOLLOW | disk.constants.O_NONBLOCK);
      try {
        const entry = disk.fstat(fd);
        if (!entry.isFile() || entry.dev !== expected?.dev || entry.ino !== expected?.ino || entry.size !== bytes) throw new Error('screenshot changed');
        parentsUnchanged();
        const data = Buffer.alloc(bytes + 1);
        let length = 0, count;
        while (length < data.length && (count = disk.read(fd, data, length, data.length - length, length)) > 0) length += count;
        const after = disk.fstat(fd);
        if (length !== bytes || after.size !== bytes || after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs) throw new Error('screenshot changed');
        parentsUnchanged();
        const body = data.subarray(0, bytes);
        return { path, bytes, sha256: createHash('sha256').update(body).digest('hex'), base64: body.toString('base64') };
      } finally { disk.close(fd); }
    });
    return { screenshots, screenshotsSha256: createHash('sha256').update(JSON.stringify(screenshots)).digest('hex') };
  } catch { return null; }
}
