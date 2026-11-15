// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items check: a sent-back item shows why first [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../../tests/fixtures/cockpit/harness.js';
import { itemRow } from '../../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../../tests/fixtures/cockpit/harness.js';

test('a sent-back item shows why first [N26]', async () => {
  const box = machine();
  const p = project(box, 'shop');
  await box.inProcess(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets by name', '--brief', 'Files: web/greeting.html');
  await box.inProcess(p.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye', '--brief', 'Files: web/farewell.html');
  await box.inProcess(p.repo, 'add', 'web', 'Heading', '--specs', 'G1', '--criterion', 'has a heading', '--brief', 'Files: web/heading.html', '--not-duplicate-of', '1 a different page');
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
  await box.inProcess(p.repo, 'add', 'web', 'Banner', '--specs', 'G1', '--criterion', 'shows a banner', '--brief', 'Files: web/banner.html', '--not-duplicate-of', '1 a different page');
  await box.inProcess(p.repo, 'add', 'web', 'Footer', '--specs', 'G1', '--criterion', 'shows a footer', '--brief', 'Files: web/footer.html', '--not-duplicate-of', '1 a different page');
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
    const beforeDoneWhen = () => page.show('detail').slice(0, Math.max(0, page.show('detail').indexOf('<p class="ip-lbl">Done when</p>')));
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
    const top = detail.slice(0, detail.indexOf('<p class="ip-lbl">Done when</p>'));
    assert.ok(detail.indexOf('<p class="ip-lbl">Done when</p>') > 0, 'the criterion is shown in the Done when section');
    assert.match(top, /item-panel-latest sentback/);
    assert.match(top, /<span class="ip-chip x" title="BEHAVIOR_MISMATCH">Behavior did not match<\/span>/);
    const verdictHash = `at <button class="hash-copy" type="button" title="${verdict.commit}" aria-label="Copy full hash ${verdict.commit}" data-copy="${verdict.commit}"><code class="inline sha" title="${verdict.commit}">${verdict.commit.slice(0, 12)}</code></button>`;
    assert.ok(top.includes('coordinator') && top.toLowerCase().includes(time.toLowerCase()) && top.includes(verdictHash), "who sent it back, at the person's local time, and at which commit");
    assert.ok(top.includes('no &lt;b&gt;greeting&lt;/b&gt; on the page\nsecond line of the note'), 'the full note, escaped, before the criterion');
    assert.ok(!detail.includes('<b>greeting</b>'), 'the note cannot inject markup');
    assert.ok(detail.indexOf('<p class="ip-lbl">Done when</p>') < detail.indexOf('<p class="ip-lbl">History</p>'));
    assert.ok(detail.replace(/\b(?:title|aria-label)="[^"]*"/gu, '').split('second line of the note').length >= 2, 'the full note appears in the Sent back section');

    await page.click({ item: '2', classes: 'row' });
    assert.match(page.show('detail'), /item-panel-head[^]*ip-chip r">In review/);
    assert.match(beforeDoneWhen(), /item-panel-latest sentback[^]*the farewell is missing/);

    assert.ok(itemRow(page.show('chain'), 5).includes('<b class="item-reason"><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> <span class="why">the footer is empty</span>'), 'a row being reworked still says why');
    await page.click({ item: '5', classes: 'row' });
    assert.match(page.show('detail'), /item-panel-head[^]*ip-chip b">Building/);
    assert.match(beforeDoneWhen(), /item-panel-latest sentback[^]*<span class="ip-chip x" title="BEHAVIOR_MISMATCH">Behavior did not match<\/span>[^]*the footer is empty/);

    // A withdrawn item has no row; the person reaches it from a spec row or the activity feed.
    assert.equal(itemRow(page.show('chain'), 4), '');
    await page.click({ go: 'item:4' });
    assert.match(page.show('detail'), /<span class="id">#4<\/span>[^]*<h2>Banner<\/h2>/);
    assert.match(page.show('detail'), /item-panel-head[^]*ip-chip g">Withdrawn/);
    assert.match(beforeDoneWhen(), /item-panel-latest sentback[^]*<span class="ip-chip x" title="BEHAVIOR_MISMATCH">Behavior did not match<\/span>[^]*the banner covers the heading/, 'withdrawn after a reject, it still opens with why');
    assert.ok(page.show('detail').indexOf('<p class="ip-lbl">Done when</p>') < page.show('detail').indexOf('<p class="ip-lbl">History</p>'));

    await page.click({ item: '3', classes: 'row' });
    const verified = page.show('detail');
    assert.match(verified, /<p class="ip-lbl">Passed<\/p>/, 'the current passed verdict leads the panel');
    assert.doesNotMatch(verified, /item-panel-latest sentback/, 'the latest panel is not tinted as sent back after acceptance');
    assert.ok(verified.indexOf('<p class="ip-lbl">Done when</p>') < verified.indexOf('<p class="ip-lbl">History</p>'));
    const verdicts = page.show('detail');
    assert.ok(verdicts.indexOf('the page shows it') < verdicts.indexOf('no heading yet'), 'every verdict remains available newest first in the opened history');
  } finally {
    await view.stop();
  }
});
