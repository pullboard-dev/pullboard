/** Validate the one data-only ref that carries account-free board moves [H11]. */
import {
  git,
  gitChildEnv,
} from '../../../git/index.js';
import { Refused } from '../../../kernel/light.js';

export const GIT_BOARD_REF = 'refs/pullboard/board';
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Refuse malformed data before it can bypass a code-push gate or reach the board engine. */
function invalid() {
  throw new Refused('GIT_SYNC_LOG', 'the Git board ref must contain only a linear validated board-data log', 'restore the append-only refs/pullboard/board data history before syncing');
}

/** Validate one commit's sole JSON blob, parent shape, envelope and executable move shape. */
export function validateGitBoardCommit(root, sha, expectedParent) {
  if (!SHA.test(sha)) invalid();
  let parents;
  let entries;
  let payload;
  try {
    const env = gitChildEnv(root);
    parents = git(root, ['show', '-s', '--format=%P', sha], { env }).split(/\s+/u).filter(Boolean);
    entries = git(root, ['ls-tree', sha], { env });
    if (!/^100644 blob [0-9a-f]{40,64}\tpayload\.json$/u.test(entries)) invalid();
    payload = JSON.parse(git(root, ['show', sha + ':payload.json'], { env, maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) { if (error instanceof Refused) throw error; invalid(); }
  if (parents.length > 1 || expectedParent !== undefined && parents.join('') !== (expectedParent ?? '')) invalid();
  if (!payload || payload.version !== 1 || !['baseline', 'move'].includes(payload.kind)) invalid();
  if (payload.kind === 'baseline') {
    if (parents.length || payload.snapshot?.version !== 1 || !payload.snapshot.tables ||
      !Array.isArray(payload.snapshot.tables.board_meta) || !Array.isArray(payload.snapshot.tables.agent) ||
      Object.keys(payload).sort().join(',') !== 'kind,snapshot,version') invalid();
  } else {
    const move = payload.move;
    if (parents.length !== 1 || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 ||
      !Number.isFinite(Date.parse(payload.at)) || typeof payload.at !== 'string' ||
      Object.keys(payload).sort().join(',') !== 'at,kind,move,sequence,version' ||
      !move || move.version !== 1 || !Number.isSafeInteger(move.engine) || move.engine < 1 ||
      !/^[A-Za-z0-9_-]{1,80}$/u.test(move.id ?? '') || typeof move.operation !== 'string' || !Array.isArray(move.args)) invalid();
  }
  return payload;
}

/** Recognize exclusively validated board-data pushes; mixed/code ref updates keep all ordinary gates. */
export function gitBoardDataPush(root, refsText) {
  const lines = refsText.split('\n').filter(line => line.trim());
  if (!lines.length || lines.some(line => line.trim().split(/\s+/u)[2] !== GIT_BOARD_REF)) return false;
  for (const line of lines) {
    const [, local, , previous] = line.trim().split(/\s+/u);
    if (!SHA.test(local ?? '') || /^0+$/u.test(local)) invalid();
    const initial = /^0+$/u.test(previous ?? '');
    if (!initial && !SHA.test(previous ?? '')) invalid();
    const names = git(root, ['rev-list', '--reverse', '--first-parent', ...(initial ? [local] : [previous + '..' + local])], { env: gitChildEnv(root) }).split('\n').filter(Boolean);
    let parent = initial ? null : previous;
    let sequence = initial ? 0 : validateGitBoardCommit(root, previous).sequence ?? 0;
    if (!names.length && local !== previous) invalid();
    for (const name of names) {
      const record = validateGitBoardCommit(root, name, parent);
      if (parent ? record.kind !== 'move' || record.sequence !== sequence + 1 : record.kind !== 'baseline') invalid();
      sequence = record.sequence ?? 0;
      parent = name;
    }
    if (parent !== local) invalid();
  }
  return true;
}
