/** Release audit custody stays beside the host's native release receipts, never in a project's source [B35,R2,I15]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from '../../../../git/index.js';
import { releaseReceiptFile } from '../release.js';
import { openBoardForRead } from '../../../../store/index.js';
import { closeBoard } from '../../../../store/index.js';
import { Refused } from '../../../../kernel/index.js';
import { previousCoordinatorMilestone } from '../../../../stats/light.js';
import { coordinatorActions } from '../../../../stats/light.js';
import { coordinatorActionRise } from '../../../../stats/light.js';
import { storeName } from '../store-names.js';

/** Keep audit files tied to actual privately stored release envelopes. */
function directory(root) { return join(repoInfo(root).commonDir, 'pullboard', 'release-coordinator-actions'); }

/** Read a recorded release's gauge and person override; missing custody never authorizes publication. */
export function readCoordinatorRelease(root, id) {
  if (!/^[a-f0-9-]{36}$/u.test(id ?? '')) return null;
  const file = join(directory(root), storeName(id));
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Read only audits with a privately stored native release envelope. */
function releaseAudits(root) {
  const folder = directory(root);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(file => /^[a-f0-9-]{36}\.json$/u.test(file))
    .map(file => JSON.parse(readFileSync(join(folder, file), 'utf8')))
    .filter(row => existsSync(releaseReceiptFile(root, row.id)));
}

/** Keep release order independent of clock ties or rollback; unmeasured releases retain the measured ratchet. */
function previousRelease(root) {
  return releaseAudits(root).filter(row => row.gauge?.perLanding != null)
    .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}

/** Refuse a rise before spending runner time; the fixed trailing 24-hour window is comparable across releases. */
export function checkCoordinatorRelease(root, { now = new Date(), personOverride } = {}) {
  if (personOverride !== undefined && (typeof personOverride !== 'string' || !personOverride.trim() || personOverride.length > 1000)) {
    throw new Refused('GATE_RUN_EVIDENCE', 'a person override needs a nonempty reason of at most 1000 characters');
  }
  if (personOverride !== undefined && !repoInfo(root).isMain) {
    throw new Refused('GATE_RUN_EVIDENCE', 'a person records a release override from the primary checkout; run the release gate there with --person-override \"reason\"');
  }
  const board = openBoardForRead(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'));
  if (board) board.db.exec('SAVEPOINT coordinator_release_read');
  let gauge;
  let projectRelease;
  try {
    projectRelease = board ? previousCoordinatorMilestone(board) : null;
    gauge = board ? coordinatorActions(board, { until: now.toISOString() }) : { available: false, perLanding: null, reason: 'no native board exists' };
  }
  finally {
    if (board) {
      try { board.db.exec('RELEASE coordinator_release_read'); }
      finally { closeBoard(board); }
    }
  }
  const previous = projectRelease ? null : previousRelease(root);
  const projectProblem = projectRelease ? coordinatorActionRise(gauge, projectRelease.coordinatorActions.gauge) : null;
  const problem = projectRelease ? projectProblem : (previous && !gauge.available ? 'coordinator actions are unavailable for a previously measured release' : coordinatorActionRise(gauge, previous?.gauge));
  if (problem && personOverride === undefined) throw new Refused('GATE_RUN_EVIDENCE', `${problem}; reduce the actions or have a person use --person-override "reason"`);
  return { gauge, previous: previous?.id ?? null, previousMilestone: projectRelease?.name ?? null, problem, ...(personOverride === undefined ? {} : { override: { by: 'person', reason: personOverride.trim() } }) };
}

/** Record only a completed native release's measurement and explicit override, with immutable per-release custody. */
export function recordCoordinatorRelease(root, id, head, report, at = new Date()) {
  if (!/^[a-f0-9-]{36}$/u.test(id ?? '') || !/^[a-f0-9]{40,64}$/u.test(head ?? '')) throw new TypeError('a release audit needs its native receipt identity and source');
  const folder = directory(root);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const sequence = Math.max(0, ...releaseAudits(root).map(row => row.sequence ?? 0)) + 1;
  const record = { version: 1, id, head, sequence, at: at.toISOString(), ...report };
  writeFileSync(join(folder, storeName(id)), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
  return record;
}
