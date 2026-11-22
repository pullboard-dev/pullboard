import assert from 'node:assert/strict';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellReviewAccept } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { getItem } from '../../../store/index.js';
import { recordTestResults } from '../../../store/index.js';
import { headTree } from '../../../git/index.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

export const CRITERION_ONLY = 'api/criterion-only.test.js';
export const CROSS_RUN = 'docs/cross-run.test.js';
export const DEFERRED = 'web/deferred.test.js';
export const OWED = 'web/owed.test.js';

/** Two independent accepted members, produced by leased gate posts and independent review, not seeded submit rows. */
export function acceptedLandingMembers(t) {
  const repo = cellRepo(t, { real: true });
  repo.put('web/source.js', 'export const page = 1;\n');
  repo.put('api/source.js', 'export const api = 1;\n');
  // Import ownership points only to API, while the web member explicitly requires this file in its frozen bar.
  repo.put(CRITERION_ONLY, "import { api } from './source.js';\n");
  for (const file of ['web/own.test.js', 'api/own.test.js', CROSS_RUN, DEFERRED, OWED]) repo.put(file, 'export {};\n');
  const base = repo.commitAll();
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const members = [];
  for (const [index, lane] of ['web', 'api'].entries()) {
    const seat = cellSeat(board, { lane, path: `${repo.root}/${lane}-seat` });
    const reviewer = cellSeat(board, { lane, path: `${repo.root}/${lane}-review` });
    const item = cellItem(board, { lane, title: `Build ${lane}`, criterion: `The member retains ${CRITERION_ONLY}.`, check: `node --test ${CRITERION_ONLY}` });
    cellClaim(board, item.item_id, seat, { root: repo.root });
    repo.put(`${lane}/source.js`, `export const value = ${index + 2};\n`);
    const commit = repo.commitAll(), tree = headTree(repo.root), held = getItem(board, item.item_id);
    const proofFiles = [`${lane}/own.test.js`, CROSS_RUN];
    const proofCommand = `node --test ${proofFiles.join(' ')}`;
    const check = JSON.parse(held.item_frozen).check;
    const job = `gate:${item.item_id}:member`;
    offerJob(board.db, { id: job, kind: 'gate', item: item.item_id, candidate: commit, base,
      request: { run: ['true'], input: { entry: 'gate.js', data: { check } },
        submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [`${lane}/source.js`], claimBase: base, tooling: base } } });
    const lease = claimJob(board.db, { runner: `r-${lane}`, capabilities: [], kinds: ['gate'] });
    assert.equal(lease.job, job);
    const gate = { version: 1, source: commit, green: true, full: false, deferred: true, deferredFiles: [DEFERRED], owedFiles: [OWED],
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      phases: [{ role: 'check', status: 0 }, { role: 'proof', status: 0 }], analysis: { proofFiles, proofCommand } };
    const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: `r-${lane}`, token: lease.token, receipt: { version: 1, status: 0, gate } }, { mode: 'pull' });
    assert.equal(posted.applied.outcome, 'review', JSON.stringify(posted.applied));
    cellReviewAccept(board, item.item_id, reviewer);
    assert.equal(getItem(board, item.item_id).item_status, 'verified');
    recordTestResults(board.db, { receipt: `${job}#proof`, origin: `pulled:r-${lane}`, commit,
      rows: proofFiles.map(file => ({ file, inputKey: 'a'.repeat(64), command: 'proof', context: 'c'.repeat(64), status: 'pass' })) });
    members.push({ id: item.item_id, commit, tree, frozen: JSON.parse(held.item_frozen), digest: held.item_frozen_digest, check, proofFiles, job });
  }
  return { board, members, base };
}
