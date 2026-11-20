/** Pure landing policy projections and observed completion formatting [B3,C7,V4]. */
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCollectionReport } from '../../../../gate/heavy.js';

/**
 * Read the live person waivers Pullboard projects into a landing run, as `{kind, test}` pairs.
 * The projection only decides whether the run keeps going past a failure; whether the run is
 * waived is decided afterwards by Pullboard against the board, so a forged list only makes a run
 * longer, never greener. Anything unreadable projects nothing, and the run stops as before [B3].
 */
export function landingWaiverProjection(text) {
  try {
    const parsed = JSON.parse(text ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(entry => ['file', 'name', 'case'].includes(entry?.kind) && typeof entry.test === 'string' && entry.test
      && (entry.kind !== 'case' || typeof entry.file === 'string' && entry.file && !entry.file.startsWith('/')
        && !/[\\\r\n\0]/u.test(entry.file) && entry.file.split('/').every(part => part && part !== '.' && part !== '..'))) : [];
  } catch { return []; }
}

/** True when a projected waiver covers this failing test by its file or by its exact name. */
export function landingFailureWaived(waivers, file, name) {
  const path = typeof file === 'string' ? relative(process.cwd(), file.startsWith('file:') ? fileURLToPath(file) : file) : null;
  return waivers.some(waiver => waiver.kind === 'case' ? waiver.file === path && waiver.test === name
    : waiver.kind === 'file' ? waiver.test === path : waiver.test === name);
}

/** Publish observed file completion only after the runner has drained reporters and owned processes. */
export function publishLandingCollection({collectionId,collectionShard,fullScope,selectedFiles,completedFiles,stoppedByLanding,collectionCancelled,reporterError,cleanupUnverifiedReported}) {
  if (collectionId) {
    const key=file=>relative(process.cwd(),file.startsWith('file:')?fileURLToPath(file):resolve(file)).split(sep).join('/');
    const planned=(selectedFiles??[]).map(key);
    const completed=[...completedFiles].map(key);
    const complete=planned.length>0&&!stoppedByLanding&&!collectionCancelled&&!reporterError&&!cleanupUnverifiedReported
      &&planned.length===new Set(planned).size&&completed.length===new Set(completed).size
      &&planned.length===completed.length&&planned.every(file=>completed.includes(file));
    process.stdout.write(formatCollectionReport({id:collectionId,scope:collectionShard?'shard':'suite',shard:collectionShard,
      full:fullScope,plannedFiles:planned,completedFiles:completed,complete,cleanupVerified:!reporterError&&!cleanupUnverifiedReported}));
  }
}
