/** A health finding longer than the receipt cap is truncated and never stops the health scan [C7,#3113]. */
// fixture-subject: addItem (one submitted item over a private board with 500 registered seats; no kit seam builds that board)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureProjectPolicy } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../lib/index.js';
import { runCliInProcess } from '../../../fixtures/process.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { submitFixture } from '../../../fixtures/board/submit.js';

const MINUTE = 60_000;

test('cli.journeys-health-oversized-finding.sentinel-run-health-only-finishes-and: clause 2: sentinel run --health-only finishes and records a health-scan event when a REVIEW_STARVED finding lists 500 seats [C7,#3113]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, verify: { policy: 'coordinator' }, review: { starveMinutes: 1 } } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'chore: coordinator-only review policy');
  let at = Math.floor(Date.now() / 1000) * 1000 - 10 * MINUTE;
  const clock = { now: () => new Date(at) };
  // @pullboard-board-file journey: this is the same durable board.sqlite opened by the fixture's real CLI.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(board));
  const builder = store.register(board, { lane: 'web', path: join(box.dir, 'builder'), family: 'Family Alpha' });
  for (let n = 0; n < 500; n++) store.register(board, { lane: 'web', path: join(box.dir, `crowd-${n}`), family: 'Family Beta' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'A review no seat may take', reviewFamily: 'Family Beta' });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 120 * MINUTE, freeze: item => ({ text: item.item_title, digest: `private:${item.item_title}` }) });
  submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'private-tree' });
  const before = store.events(board).length;
  const result = await runCliInProcess(['sentinel', 'run', '--health-only', '--json'], { cwd: box.repo, env: box.env });
  assert.equal(result.status, 0, result.stderr);
  const scan = store.events(board).slice(before).find(event => event.event_kind === 'health-scan');
  assert.ok(scan, 'the scan recorded a health-scan event');
  assert.match(scan.event_detail, /more seats omitted/u, 'the finding is recorded with its omitted-seat count');
});
