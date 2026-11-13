// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks: detail check baselines and sent-back reasons [N26]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { addItem } from '../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { completeCheckBaseline } from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../../tests/fixtures/cockpit/harness.js';
import { itemRow } from '../../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../../tests/fixtures/cockpit/harness.js';

test('an item detail shows its pending, red and green check baselines from the API [V2,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'check-baselines');
  const main = box.git(alpha.repo, 'rev-parse', 'main');
  const checks = [
    { title: 'Pending baseline', command: 'node --test pending.test.js', result: 'pending', request: '00000000-0000-4000-8000-000000000001' },
    { title: 'Red baseline', command: 'node --test red.test.js', result: 'red', seconds: 2 },
    { title: 'Green baseline', command: 'node --test green.test.js', result: 'green', seconds: 1 },
  ];
  // @pullboard-board-file journey: the view reads the baseline rows this test seeds through the real board file
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  let ids;
  try {
    ids = checks.map((check) => addItem(board, {
      by: 'coordinator', lane: 'web', title: check.title, criterion: 'shows the observed check result', specIds: ['G1'],
      check: check.command,
      checkBaseline: { command: check.command, main, result: check.result, ...(check.request ? { request: check.request } : {}), ...(check.seconds ? { seconds: check.seconds } : {}) },
    }));
  } finally {
    closeBoard(board);
  }
  const view = await startView(box);
  try {
    const state = await boardOf(view, alpha.repo);
    for (let index = 0; index < checks.length; index += 1) {
      assert.equal(state.items.find((item) => item.id === ids[index]).check, checks[index].command);
      assert.equal(state.items.find((item) => item.id === ids[index]).checkBaseline.result, checks[index].result,
        'the local API exposes the recorded baseline state');
    }
    assert.equal(state.items.find((item) => item.id === ids[2]).checkBaseline.warning, 'CRITERION_PROVES_NOTHING');

    const page = await openPage(view);
    for (let index = 0; index < checks.length; index += 1) {
      await page.click({ item: String(ids[index]), classes: 'row' });
      const detail = page.show('detail');
      assert.match(detail, /<h3>Check<\/h3>/);
      assert.ok(detail.indexOf('<h3>Done when</h3>') < detail.indexOf('<h3>Check</h3>')
        && detail.indexOf('<h3>Check</h3>') < detail.indexOf('<h3>Spec rows it serves</h3>'), 'the check sits beside the criterion');
      assert.ok(detail.includes(`<code>${checks[index].command}</code>`), 'the displayed check is the API command');
      const word = checks[index].result.charAt(0).toUpperCase() + checks[index].result.slice(1);
      assert.ok(detail.includes(`<span class="chip ${checks[index].result === 'green' ? 'ok' : checks[index].result === 'red' ? 'no' : 'warn'}">${word} on main</span>`),
        `the ${checks[index].result} baseline is visible`);
      if (checks[index].result === 'green') {
        assert.ok(detail.includes('This check already passed before the work, so it proves nothing.'), 'green baseline warning is plain language');
      } else {
        assert.doesNotMatch(detail, /proves nothing/, 'pending and red baselines do not claim the check proves nothing');
      }
      if (checks[index].result === 'pending') {
        // @pullboard-board-file journey: the view reads the baseline rows this test seeds through the real board file
        const completionBoard = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
        try {
          assert.equal(completeCheckBaseline(completionBoard, ids[index], {
            agentId: 'coordinator',
            expected: { command: checks[index].command, main, result: 'pending', request: checks[index].request },
            baseline: { command: checks[index].command, main, result: 'green', seconds: 1 },
          }), true, 'the authorized pending baseline completes once');
        } finally {
          closeBoard(completionBoard);
        }
        await page.run('refresh()');
        const completed = page.show('detail');
        assert.match(completed, /<h2><span class="id">#\d+<\/span>Pending baseline<\/h2>/, 'the open detail stays on the pending item');
        assert.ok(completed.includes('<span class="chip ok">Green on main</span>'), 'the open detail updates to the completed result');
        assert.ok(completed.includes('This check already passed before the work, so it proves nothing.'), 'the completed warning appears without reopening the detail');
      }
    }
  } finally {
    await view.stop();
  }
});

test('a sent-back item shows why first [N26]', async () => {
  const box = machine();
  const p = project(box, 'shop');
  await box.inProcess(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets by name', '--brief', 'Files: web/greeting.html');
  await box.inProcess(p.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye', '--brief', 'Files: web/farewell.html');
  await box.inProcess(p.repo, 'add', 'web', 'Heading', '--specs', 'G1', '--criterion', 'has a heading', '--brief', 'Files: web/heading.html');
  build(box, p, 1, 'greeting.html');
  sendBack(box, p, 1, 'no <b>greeting</b> on the page\nsecond line of the note');
  build(box, p, 2, 'farewell.html');
  sendBack(box, p, 2, 'the farewell is missing');
  build(box, p, 2, 'farewell-again.html');
  build(box, p, 3, 'heading.html');
  sendBack(box, p, 3, 'no heading yet');
  build(box, p, 3, 'heading-again.html');
  accept(box, p, 3);
  // Two more ways to be sent back and not verified: withdrawn after the reject, and being reworked.
  await box.inProcess(p.repo, 'add', 'web', 'Banner', '--specs', 'G1', '--criterion', 'shows a banner', '--brief', 'Files: web/banner.html');
  await box.inProcess(p.repo, 'add', 'web', 'Footer', '--specs', 'G1', '--criterion', 'shows a footer', '--brief', 'Files: web/footer.html');
  build(box, p, 4, 'banner.html');
  sendBack(box, p, 4, 'the banner covers the heading');
  await box.inProcess(p.repo, 'withdraw', '4', 'the banner is dropped');
  build(box, p, 5, 'footer.html');
  sendBack(box, p, 5, 'the footer is empty');
  await box.inProcess(p.web, 'claim', '5');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    const beforeDoneWhen = () => page.show('detail').slice(0, Math.max(0, page.show('detail').indexOf('<h3>Done when</h3>')));
    const needs = page.show('needs');
    assert.doesNotMatch(needs, /Greeting|Farewell/, "work sent back is the agents' to move, so it stays out of Needs-you; its row says why");
    const row = itemRow(page.show('chain'), 1);
    assert.ok(row.includes('<b class="item-reason"><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> <span class="why">no &lt;b&gt;greeting&lt;/b&gt; on the page'), row);
    assert.ok(!row.includes('second line'), 'the row shows the first line of the note only');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b class="item-reason"><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> <span class="why">the farewell is missing</span>'));

    await page.click({ item: '1', classes: 'row' });
    const detail = page.show('detail');
    const verdict = (await boardOf(view, p.repo)).items.find((item) => item.id === 1).verdict;
    const time = new Date(verdict.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    const top = detail.slice(0, detail.indexOf('<h3>Done when</h3>'));
    assert.ok(detail.indexOf('<h3>Done when</h3>') > 0, 'the criterion is shown in the Done when section');
    assert.match(top, /class="item-panel-latest sentback"/);
    assert.match(top, /<b class="item-panel-verdict-label">Sent back · <span title="BEHAVIOR_MISMATCH">Behavior did not match<\/span><\/b>/);
    const verdictHash = `at <button class="hash-copy" type="button" title="${verdict.commit}" aria-label="Copy full hash ${verdict.commit}" data-copy="${verdict.commit}"><code class="inline sha" title="${verdict.commit}">${verdict.commit.slice(0, 12)}</code></button>`;
    assert.ok(top.includes('coordinator ·') && top.includes(time) && top.includes(verdictHash), "who sent it back, at the person's local time, and at which commit");
    assert.ok(top.includes('no &lt;b&gt;greeting&lt;/b&gt; on the page\nsecond line of the note'), 'the full note, escaped, before the criterion');
    assert.ok(!detail.includes('<b>greeting</b>'), 'the note cannot inject markup');
    assert.ok(detail.indexOf('<h3>Done when</h3>') < detail.indexOf('<h3>Spec rows it serves</h3>'));
    assert.ok(detail.indexOf('<h3>Brief</h3>') < detail.indexOf('<h3>Spec rows it serves</h3>'));
    assert.equal(detail.replace(/\b(?:title|aria-label)="[^"]*"/gu, '').split('second line of the note').length, 3, 'the full note appears once in Overview and once in its Verdicts disclosure');

    await page.click({ item: '2', classes: 'row' });
    assert.match(page.show('detail'), /item-panel-status[^]*In review[^]*Resubmitted after a send-back/);
    assert.match(beforeDoneWhen(), /class="item-panel-latest sentback"[^]*the farewell is missing/);

    assert.ok(itemRow(page.show('chain'), 5).includes('<b class="item-reason"><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> <span class="why">the footer is empty</span>'), 'a row being reworked still says why');
    await page.click({ item: '5', classes: 'row' });
    assert.match(page.show('detail'), /item-panel-status[^]*Building[^]*Resubmitted after a send-back/);
    assert.match(beforeDoneWhen(), /class="item-panel-latest sentback"[^]*<b class="item-panel-verdict-label">Sent back · <span title="BEHAVIOR_MISMATCH">Behavior did not match<\/span><\/b>[^]*the footer is empty/);

    // A withdrawn item has no row; the person reaches it from a spec row or the activity feed.
    assert.equal(itemRow(page.show('chain'), 4), '');
    await page.click({ go: 'item:4' });
    assert.match(page.show('detail'), /<h2><span class="id">#4<\/span>Banner<\/h2>/);
    assert.match(page.show('detail'), /item-panel-status[^]*Withdrawn/);
    assert.match(beforeDoneWhen(), /class="item-panel-latest sentback"[^]*<b class="item-panel-verdict-label">Sent back · <span title="BEHAVIOR_MISMATCH">Behavior did not match<\/span><\/b>[^]*the banner covers the heading/, 'withdrawn after a reject, it still opens with why');
    assert.ok(page.show('detail').indexOf('<h3>Done when</h3>') < page.show('detail').indexOf('<h3>Brief</h3>'));

    await page.click({ item: '3', classes: 'row' });
    const verified = page.show('detail');
    assert.match(verified, /<b class="item-panel-verdict-label">Passed<\/b>/, 'the current passed verdict leads Overview');
    assert.doesNotMatch(verified, /class="item-panel-latest sentback"/, 'the latest panel is not tinted as sent back after acceptance');
    assert.ok(verified.indexOf('<h3>Done when</h3>') < verified.indexOf('<h3>Brief</h3>'));
    assert.match(verified, /aria-selected="true"[^>]*>Overview/);
    await page.click({ itemPanelTab: 'verdicts' });
    const verdicts = page.show('detail');
    assert.match(verdicts, /aria-selected="true"[^>]*>Verdicts/);
    assert.ok(verdicts.indexOf('the page shows it') < verdicts.indexOf('no heading yet'), 'every verdict remains available newest first');
  } finally {
    await view.stop();
  }
});
