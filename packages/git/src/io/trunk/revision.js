/** Cheap filesystem observation of the primary or retained trunk [E8,A2]. */
import {
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { trunkRef } from './ref.js';

/** Invalidate a retained branch lookup only when its local configuration changes. */
function fileMarkerForPath(path) {
  try {
    const stat = statSync(path);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

const TRUNK_REVISION_READERS = new Map();

/** Watch the primary trunk ref even when this served worktree's HEAD remains fixed [E8]. */
export function trunkRevisionReader(info) {
  const cached = TRUNK_REVISION_READERS.get(info.commonDir);
  if (cached) return cached;
  let retainedMarker = null;
  let retained = null;
  /** Read loose or packed refs without spawning Git in every event-stream poll. */
  const read = () => {
    const head = readFileSync(join(info.commonDir, 'HEAD'), 'utf8').trim();
    let ref = /^ref: (refs\/heads\/.+)$/u.exec(head)?.[1];
    if (!ref) {
      const marker = fileMarkerForPath(join(info.commonDir, 'config'));
      if (marker !== retainedMarker) { retained = trunkRef(info.root); retainedMarker = marker; }
      ref = retained;
    }
    if (!ref?.startsWith('refs/heads/') || ref.includes('\\') || ref.split('/').some(part => !part || part === '.' || part === '..')) return null;
    try { return readFileSync(join(info.commonDir, ref), 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      return readFileSync(join(info.commonDir, 'packed-refs'), 'utf8').split('\n')
        .find(line => line.endsWith(' ' + ref))?.split(' ')[0] ?? null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  TRUNK_REVISION_READERS.set(info.commonDir, read);
  while (TRUNK_REVISION_READERS.size > 32) TRUNK_REVISION_READERS.delete(TRUNK_REVISION_READERS.keys().next().value);
  return read;
}

