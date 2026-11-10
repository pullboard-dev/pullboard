/** Advisory main-audit jobs never replace native gate/defect receipts [C7,H16]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from '../../../../../git/index.js';
import { withFileLock } from '../../../../../outbox/index.js';

/** Resolve only the repository-owned private audit directory. */
export function mainAuditDirectory(info) { return join(info.commonDir, 'pullboard', 'main-audits'); }
/** Establish the first explicit rollout boundary once under a short private file lock, without reading the board. */
export async function activateMainAudits(root, afterEventId, boardId) {
  if (typeof boardId !== 'string' || !boardId || boardId.length > 128) throw new Error('main audit activation needs the native board identity');
  if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) throw new Error('main audit activation needs the captured native event id');
  const directory = mainAuditDirectory(repoInfo(root));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withFileLock(join(directory, 'activation.guard.sqlite'), () => {
    const file = join(directory, 'activation.json');
    const previous = readMainAudit(file);
    if (previous && previous.board === boardId) {
      if (previous.version !== 1 || !Number.isSafeInteger(previous.afterEventId) || previous.afterEventId < 0) throw new Error('invalid main audit activation');
      return previous;
    }
    const activation = { version: 1, board: boardId, afterEventId };
    saveMainAudit(file, activation);
    return activation;
  });
}
/** Bind every obligation to board identity, landing identity and exact accepted source. */
export function mainAuditKey(job) {
  return createHash('sha256').update(JSON.stringify([job.board, job.batchId, job.tip, job.tree])).digest('hex');
}
/** Read a local advisory record; malformed existing data refuses rather than claiming completion. */
export function readMainAudit(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** Atomically publish only this writer's private JSON; no proof observations are fabricated here. */
export function saveMainAudit(file, value) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}
