/** An expired review reservation is never read as held, so NO_REVIEWER_SUPPLY sees the lapsed item [C7,O2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openKitBoard } from '../../../board/tests/fixtures/board.js';
import { temporaryDirectory } from '../../../board/tests/fixtures/board.js';
import { repositoryBoardFile } from '../../../store/tests/fixtures/submit.js';
import { seedLimitedReviewQueue } from '../../../board/tests/fixtures/cell-board.js';
import { healthReport } from '../../index.js';
import { noReviewerSupplyFindings } from '../../src/io/supply.js';

const HOUR = 3_600_000;
const finding = (cause, item, fields) => ({ cause, item, ...fields });

/** A limited review queue whose one submitted item is reserved until the given offset from now; the NO_REVIEWER_SUPPLY findings healthReport reads. */
function reservedFindings(t, untilOffsetMs) {
  const file = repositoryBoardFile(temporaryDirectory('health-supply-'));
  const id = seedLimitedReviewQueue(file, { lane: 'core', family: 'Fixture-Builder', reviewers: 2 });
  const board = openKitBoard(file);
  t.after(() => board.db.close());
  const until = new Date(Date.now() + untilOffsetMs).toISOString();
  board.db.prepare('UPDATE item SET item_review_by = ?, item_review_until = ? WHERE item_id = ?').run('core-9', until, id);
  const report = healthReport({ db: board.db, root: process.cwd(), config: {}, now: new Date(), dispatchHealth: () => ({ findings: [] }) });
  return { id, found: report.stuck.filter(row => row.cause === 'NO_REVIEWER_SUPPLY') };
}

test('health.io-supply.expired-reservation-not-held: clause 1: a submitted item whose reservation lapsed gets NO_REVIEWER_SUPPLY, and one still held does not [C7,O2]', () => {
  const items = [{ item_id: 1, item_status: 'submitted', item_review_by: 'core-9', item_built_by: 'core-1', item_updated_at: 't' }];
  const others = [{ agent_id: 'core-2', agent_lane: 'core' }];
  const verify = holder => ({ reviewHolder: () => holder, limitProblem: () => 'limit', familyOf: () => 'fixture-builder' });
  assert.equal(noReviewerSupplyFindings({}, items, others, 0, finding, () => 't', verify('core-9')).length, 0);
  assert.equal(noReviewerSupplyFindings({}, items, others, 0, finding, () => 't', verify(null)).length, 1);
});

test('health.io-supply.real-path: clause 2: healthReport lists the finding once the reservation time passes and not while it is held [C7,O2]', t => {
  assert.deepEqual(reservedFindings(t, HOUR).found, []);
  const lapsed = reservedFindings(t, -HOUR);
  assert.equal(lapsed.found.length, 1);
  assert.equal(lapsed.found[0].item, lapsed.id);
});
