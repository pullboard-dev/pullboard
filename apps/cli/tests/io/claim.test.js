/** The claim freezer carries the family backlog threshold into the frozen text only for a required-family item with review.relaxRequiredFamily on [C7,#11119], and refuses an over-ceiling check with claim.checkCeiling on [C7,#1273]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL_CONFIG } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';
import { getItem } from '../../../../packages/store/index.js';
import { claim } from '../../../../packages/store/index.js';
import { headCommit } from '../../../../packages/git/index.js';
import { frozenCheckCeilingMs } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { freezer } from '../../src/io/claim.js';
import { claimFreezer } from '../../src/io/claim.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';

const BAR = 'The page renders [test]';

/** A real repo whose settings carry verify.familyRelaxAt 2, one claimed web item, and a machine home whose settings turn the relax switch as given. */
function claimed(t, relax) {
  const { root: home } = privateFixtureFiles('pullboard-claim-freezer-');
  fixtureMachineSettings(home, relax === undefined ? {} : { review: { relaxRequiredFamily: relax } });
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before; });
  const repo = cellRepo(t, { real: true, config: { ...CELL_CONFIG, verify: { familyRelaxAt: 2 } } });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true });
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/a` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page', criterion: BAR, specIds: ['G1'] });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const ctx = { info: { root: repo.root, isMain: true }, config: loadConfig(repo.root) };
  return { board, ctx, item: getItem(board, item.item_id) };
}

/** The policy.verify.familyRelaxAt the freezer writes for the item. */
function frozenRelaxAt({ board, ctx }, item) {
  return JSON.parse(freezer(ctx, { board })(item).text).policy?.verify?.familyRelaxAt;
}

test('cli.io-claim.freezer-carries-family-relax-at: clause 1: freezer on an item whose review family is set, with review.relaxRequiredFamily on and verify.familyRelaxAt 2, yields frozen text whose policy.verify.familyRelaxAt is 2 [C7,#11119]', t => {
  const fx = claimed(t, true);
  assert.equal(frozenRelaxAt(fx, { ...fx.item, item_review_family: 'openai' }), 2);
});

test('cli.io-claim.freezer-omits-family-relax-at-when-off: clause 2: with the setting off, or an item with no review family, the frozen text carries no policy.verify.familyRelaxAt [C7,#11119]', t => {
  const off = claimed(t, false);
  assert.equal(frozenRelaxAt(off, { ...off.item, item_review_family: 'openai' }), undefined, 'setting off');
  assert.equal(frozenRelaxAt(claimed(t, undefined), { ...off.item, item_review_family: 'openai' }), undefined, 'setting unset');
  const on = claimed(t, true);
  assert.equal(frozenRelaxAt(on, on.item), undefined, 'no review family');
  assert.equal(Object.hasOwn(JSON.parse(freezer(on.ctx, { board: on.board })(on.item).text), 'policy'), false, 'nothing else changes in the frozen text');
});

/** A real repo with one open, unclaimed web item whose recorded check baseline is as given, and a machine home whose claim.checkCeiling is as given. */
function baselined(t, ceilingOn, baseline) {
  const { root: home } = privateFixtureFiles('pullboard-claim-ceiling-');
  fixtureMachineSettings(home, ceilingOn === undefined ? {} : { claim: { checkCeiling: ceilingOn } });
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before; });
  const repo = cellRepo(t, { real: true, config: CELL_CONFIG });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true });
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/a` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page', criterion: BAR, specIds: ['G1'] });
  const ctx = { info: { root: repo.root, isMain: true }, config: loadConfig(repo.root) };
  if (baseline) {
    const recorded = { command: getItem(board, item.item_id).item_check, main: 'abc', ...baseline(frozenCheckCeilingMs(ctx.config) / 1000) };
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`item_check_baseline_${item.item_id}`, JSON.stringify(recorded));
  }
  const claimIt = () => claim(board, item.item_id, { agentId: seat.id, lane: seat.lane, leaseMs: 60_000, freeze: claimFreezer(ctx, board), head: headCommit(repo.root) });
  return { board, id: item.item_id, claimIt };
}

test('cli.io-claim.check-ceiling-refuses-over: clause 1: with claim.checkCeiling on, the claim freezer refuses CHECK_OVER_CEILING for an item whose recorded check measured over the ceiling, and the item stays open and unclaimed [C7,#1273]', t => {
  const fx = baselined(t, true, ceiling => ({ result: 'green', seconds: ceiling + 1 }));
  assert.throws(() => fx.claimIt(), error => error.code === 'CHECK_OVER_CEILING');
  const item = getItem(fx.board, fx.id);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_claimed_by ?? null, null);
});

test('cli.io-claim.check-ceiling-claims-pending-or-off: clause 2: with the setting on, an item whose baseline is pending or has no seconds is claimed, and with the setting off the over-ceiling item is claimed as today [C7,#1273]', t => {
  const claimedStatus = fx => { fx.claimIt(); return getItem(fx.board, fx.id).item_status; };
  const pending = baselined(t, true, ceiling => ({ result: 'pending', seconds: ceiling + 1 }));
  assert.notEqual(claimedStatus(pending), 'open', 'pending baseline');
  const unmeasured = baselined(t, true, () => ({ result: 'green' }));
  assert.notEqual(claimedStatus(unmeasured), 'open', 'no seconds');
  const off = baselined(t, false, ceiling => ({ result: 'green', seconds: ceiling + 1 }));
  assert.notEqual(claimedStatus(off), 'open', 'setting off');
  const unset = baselined(t, undefined, ceiling => ({ result: 'green', seconds: ceiling + 1 }));
  assert.notEqual(claimedStatus(unset), 'open', 'setting unset');
});
