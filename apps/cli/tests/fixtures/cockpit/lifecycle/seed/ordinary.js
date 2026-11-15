/** Genuine ordinary native lifecycle fixtures with the production freezer and a private board clock [N26,C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as store from '../../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../../lib/index.js';
import { cliReadContext$context as context } from '../../../../../index.js';
import { cli$freezer as freezer } from '../../../../../index.js';
import { build } from '../../harness.js';

/** Seed real returns and expiry on the caller's registered private board, without manufacturing events or proof. */
export async function seedNativeOrdinary(box, demo, { includeForward = false, keepClaim = true } = {}) {
  /** Read the ordinary CLI result with its actual registered actor and frozen policy. */
  const json = async (root, ...args) => JSON.parse(await box.inProcess(root, ...args, '--json'));
  /** Add one real item whose check runs through the ordinary CLI baseline. */
  const add = async title => (await json(demo.repo, 'add', 'web', title, '--specs', 'G1', '--route', 'strong',
    '--criterion', 'The original return criterion', '--check', 'true', '--accept-green', 'the fixture item needs a baseline that always passes')).item.item_id;
  const release = await add('Return by release');
  await box.inProcess(demo.web, 'claim', String(release));
  await box.inProcess(demo.web, 'release', String(release), '--reason', 'OTHER', '--note', 'Another builder can take this item.', '--no-next');
  const escalation = await add('Return by escalation');
  await box.inProcess(demo.web, 'claim', String(escalation));
  await box.inProcess(demo.web, 'escalate', String(escalation), '--note', 'This private fixture needs a stronger builder.');
  if (includeForward) {
    const reviewer = (await json(demo.repo, 'worktree', 'web', '--model', 'Lifecycle ordinary reviewer fixture')).path;
    /** Check the exact actual submitted commit in an independent registered checkout. */
    const review = async (id, decision) => {
      const item = await json(demo.repo, 'show', String(id));
      box.git(reviewer, 'switch', '-q', '--detach', item.item_commit);
      const reserved = await json(reviewer, 'next', '--verify');
      assert.equal(reserved.item.item_id, id, 'the real native review queue reserves this exact submitted item');
      assert.equal(reserved.review, true);
      await box.inProcess(reviewer, 'verify', String(id), decision, '--no-next', '--note', decision === 'accept'
        ? 'The actual frozen fixture command passes.' : 'The original return criterion needs a correction.',
      ...(decision === 'reject' ? ['--reason', 'BEHAVIOR_MISMATCH', '--clause', JSON.parse(item.item_frozen).criterion] : []));
    };
    const accepted = await add('Passed ordinary work');
    build(box, demo, accepted, 'lifecycle-accepted.txt');
    await review(accepted, 'accept');
    const rejected = await add('Rejected ordinary work');
    build(box, demo, rejected, 'lifecycle-rejected.txt');
    await review(rejected, 'reject');
    const reopened = await add('Reopened ordinary work');
    build(box, demo, reopened, 'lifecycle-reopened.txt');
    await box.inProcess(demo.repo, 'reopen', String(reopened), '--note', 'The original return criterion needs a correction.');
    const withdrawn = await add('Withdrawn ordinary work');
    await box.inProcess(demo.repo, 'withdraw', String(withdrawn), 'This private fixture is outside the release.');
  }
  const kept = await add('Retained correction');
  await box.inProcess(demo.web, 'claim', String(kept));
  await box.inProcess(demo.repo, 'edit', String(kept), '--criterion', 'The corrected return criterion', '--reason', 'The original criterion omitted a necessary case');
  const retained = await json(demo.repo, 'refreeze', String(kept));
  assert.equal(retained.retainedClaim, true, 'the real coordinator correction keeps the live claim');
  await box.inProcess(demo.web, 'claim', String(kept));
  const expired = await add('Return by expired refreeze'), lapsed = await add('Return by expired claim');
  const clockSeat = (await json(demo.repo, 'worktree', 'web', '--model', 'Lifecycle clock fixture')).path;
  // @pullboard-board-file journey: only this native private fixture uses a deterministic board clock.
  // The freezer reads the real committed spec and policy; no frozen envelope or event is manufactured.
  let at = Date.now() - 60_000;
  const board = openBoard(join(demo.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(at) });
  try {
    const holder = store.listAgents(board).find(agent => agent.agent_path === clockSeat)?.agent_id;
    assert.ok(holder, 'the clock cases use their own actually registered seat');
    const head = box.git(clockSeat, 'rev-parse', 'HEAD');
    const ctx = context({ cwd: demo.repo });
    const freeze = freezer(ctx, { board, captureVerifyPolicy: true });
    store.claim(board, expired, { agentId: holder, lane: 'web', head, leaseMs: 1, freeze });
    at += 60_000;
    const returned = store.refreeze(board, expired, { agentId: 'coordinator', freeze });
    assert.notEqual(returned.retainedClaim, true, 'an expired claim is not retained');
    assert.equal(store.getItem(board, expired).item_status, 'open');
    store.claim(board, lapsed, { agentId: holder, lane: 'web', head, leaseMs: 1, freeze });
    at += 2;
    store.claim(board, lapsed, { agentId: holder, lane: 'web', head, leaseMs: 3_600_000, freeze });
    const claims = store.events(board, { itemId: lapsed }).filter(event => event.event_kind === 'claim');
    assert.equal(claims.length, 2, 'the production claim writer records a new claim after real clock expiry');
    assert.equal(store.events(board, { itemId: lapsed }).some(event => event.event_kind === 'renew'), false);
  } finally { store.closeBoard(board); }
  if (!keepClaim) await box.inProcess(demo.web, 'release', String(kept), '--reason', 'OTHER', '--note', 'The retained correction was observed before another native journey.', '--no-next');
  return { kept, expected: {
    'claimed>open:release': keepClaim ? 1 : 2, 'claimed>open:escalate': 1,
    'claimed>claimed:refreeze': 1, 'claimed>open:refreeze': 1, 'claimed>open:lapse': 1,
  } };
}

/**
 * Draw the lifecycle figure from the page's own renderer and the board's real move counts into a host at the top of the Activity page.
 * Why: the redesigned Activity (#6916) dropped the figure's toggle and panel, but the renderer and its counts remain, so
 * the journeys still read the words and numbers a person would see there.
 *
 * @param {object} chrome - The snapshot Chrome session.
 * @returns {Promise<void>} Resolves once the figure is in `#lifecycle-figure`.
 */
export async function drawLifecycleFigure(chrome) {
  await chrome.waitFor('typeof lifecycleChart === "function" && !!data?.project');
  await chrome.stable(`(() => {
    document.getElementById('lifecycle-figure')?.remove();
    const host = document.createElement('div');
    host.id = 'lifecycle-figure';
    host.innerHTML = lifecycleChart(data.project, new Map(Object.entries(data.project.moveCounts)), data.project.items.filter(item => stateOf(item) === 'back').length);
    document.querySelector('[data-pane=activity]').prepend(host); // in the page's flow: after the fixed status bar it is covered at the end of the body.
    return true;
  })()`);
}
