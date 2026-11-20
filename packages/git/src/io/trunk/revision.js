/** Cheap filesystem observation of the primary or retained trunk [E8,A2]. */
import { join } from 'node:path';
import { gitSpawn } from '../adapter.js';
import { cleanGitEnvironment } from '../main.js';
import { plainTrunkRef } from './ref.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
const disk = fileSystemAdapter();

/** Invalidate a retained branch lookup only when its local configuration changes. */
function fileMarkerForPath(path) {
  try {
    const stat = disk.stat(path);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

/**
 * Read the retained primary branch through an asynchronous Git process; null when none is recorded.
 * Request threads use this so an unusual local config never holds them on a synchronous child process.
 */
function retainedTrunkRefLater(root) {
  return new Promise(done => {
    const child = gitSpawn(['--no-replace-objects', 'config', '--local', '--get', 'pullboard.trunk'], {
      cwd: root, env: cleanGitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => done(null));
    child.on('close', status => done(status === 0 ? out.trim() || null : null));
  });
}

const TRUNK_REVISION_READERS = new Map();

/**
 * Watch the primary trunk ref even when this served worktree's HEAD remains fixed [E8].
 * Never waits on Git: board API requests call it. A detached primary HEAD names its trunk by the
 * retained config; a config too unusual to parse by hand is read by an asynchronous Git process,
 * and the revision is null until that answers (callers key caches on it or resolve the trunk themselves).
 */
export function trunkRevisionReader(info) {
  const cached = TRUNK_REVISION_READERS.get(info.commonDir);
  if (cached) return cached;
  let retainedMarker = null;
  let retained = null;
  let generation = 0;
  /** Read loose or packed refs without spawning Git in every event-stream poll. */
  const read = () => {
    const head = disk.readFile(join(info.commonDir, 'HEAD'), 'utf8').trim();
    let ref = /^ref: (refs\/heads\/.+)$/u.exec(head)?.[1];
    if (!ref) {
      const marker = fileMarkerForPath(join(info.commonDir, 'config'));
      if (marker !== retainedMarker) {
        retainedMarker = marker;
        const mine = ++generation;
        const plain = plainTrunkRef(info.root);
        retained = plain ?? null;
        if (plain === undefined) retainedTrunkRefLater(info.root).then(ref => { if (mine === generation) retained = ref; });
      }
      ref = retained;
    }
    if (!ref?.startsWith('refs/heads/') || ref.includes('\\') || ref.split('/').some(part => !part || part === '.' || part === '..')) return null;
    try { return disk.readFile(join(info.commonDir, ref), 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      return disk.readFile(join(info.commonDir, 'packed-refs'), 'utf8').split('\n')
        .find(line => line.endsWith(' ' + ref))?.split(' ')[0] ?? null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  TRUNK_REVISION_READERS.set(info.commonDir, read);
  while (TRUNK_REVISION_READERS.size > 32) TRUNK_REVISION_READERS.delete(TRUNK_REVISION_READERS.keys().next().value);
  return read;
}

