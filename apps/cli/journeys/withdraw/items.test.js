// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks, using the shared real-board fixtures [N26]. */
import '../init/geometry.test.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import {
  addItem,
  closeBoard,
  completeCheckBaseline,
} from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  tapTarget,
  SPEC,
  machine,
  project,
  build,
  sendBack,
  startView,
  element,
  target,
  openPage,
  agentEntries,
  accept,
  itemRow,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  settled,
  earlier,
  press,
  travel,
  chooseFilter,
  openItemsNeeds,
} from '../../tests/fixtures/cockpit/harness.js';


test('an added item confirmation names its returned id [A3,N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'An existing item', '--specs', 'G1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const ids = [];
    for (const title of ['First page item', 'Second page item']) {
      await page.fire('new-item', 'click');
      page.element('add-lane').value = 'web';
      page.element('add-title').value = title;
      page.element('add-specs').value = 'G1';
      await page.fire('add-form', 'submit');
      const item = (await boardOf(view, alpha.repo)).items.find((row) => row.title === title);
      assert.ok(item, 'the real public move creates the submitted item');
      ids.push(item.id);
      assert.equal(page.element('console').className, 'console ok');
      assert.equal(page.element('console').textContent.split('\n').at(-1), `added #${item.id}`);
    }
    assert.notEqual(ids[0], ids[1], 'successive confirmations use their distinct returned ids');
  } finally {
    await view.stop();
  }
});

test('a review in progress names its reviewer [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const second = join(box.dir, 'alpha-web-two');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  await box.inProcess(second, 'join', 'web');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  await box.inProcess(second, 'next', '--verify');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    assert.match(itemRow(page.show('chain'), 1), /aria-label="In review:/, 'a review keeps the approved lifecycle stage');
    assert.match(itemRow(page.show('chain'), 1), /<small class="stage-detail"(?: title="[^"]*")?>web-2 \(Test Model\) verifying<\/small>/, 'the row names who holds the review');
    assert.doesNotMatch(page.show('needs'), /Greeting/, "a review is the agents' work, so it stays out of Needs-you");
    page.run('view.open.idle = true; render();');
    await page.click({ tab: 'shouts' });
    const holds = (id) => agentEntries(page.show('agents')).find((agent) => agent.id === id).holds;
    assert.deepEqual(holds('web-2'), ['#1 Greeting: In review'], 'the reviewer sees the shared verdict stage');
    assert.deepEqual(holds('web-1'), ['#1 Greeting: In review'], 'the builder waits on the same verdict stage');
    await page.click({ tab: 'items' });
    // A name is board text, so it is escaped: give the board on hand a reviewer with markup and redraw.
    page.run('data.project.items.find((i) => i.id === 1).claim.by = "web<b>"; render();');
    assert.match(itemRow(page.show('chain'), 1), /<small class="stage-detail"(?: title="[^"]*")?>web&lt;b&gt; verifying<\/small>/);
    await page.run('refresh()');

    box.git(second, 'switch', '-q', '--detach', alpha.branch);
    await box.inProcess(second, 'verify', '1', 'accept', '--note', 'opened the page and read the greeting');
    await page.run('refresh()');
    await page.click({ state: 'all' });
    assert.match(itemRow(page.show('chain'), 1), /<b class="stage-word">Verified<\/b>/, 'once the verdict lands, the review is over');
    await page.click({ tab: 'shouts' });
    assert.deepEqual(holds('web-2'), []);
  } finally {
    await view.stop();
  }
});
test('a stale verdict shows a stale chip [N26,V4]', async () => {
  const box = machine(), alpha = project(box, 'alpha');
  for (const title of ['Stale', 'Fresh', 'Landed', 'Legacy', 'Open']) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2, 3, 4]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); }
  box.git(alpha.repo, 'merge', '-q', '--ff-only', alpha.itemBranches.get(`${alpha.baseBranch}:3`));
  await box.inProcess(alpha.repo, 'merged', '3', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Next', '--items', '1,2,3,4,5', '--reason', 'Arrange fixture release');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    await page.click({ state: 'all' });
    // Core (#409) publishes verdictState; here the fixture hands it in, a file name with markup included.
    const [one, two, file] = ['a'.repeat(40), 'b'.repeat(40), `web/<b>x</b>&"y'.html`];
    const states = { 1: { code: 'STALE_VERDICT', file, commit: one, main: two }, 3: { code: 'STALE_VERDICT', file, commit: one, main: two }, 4: { code: 'STALE_VERDICT', file: 'web/page-4.html', commit: two, main: one, legacy: true } };
    page.run(`for (const [id, s] of Object.entries(${JSON.stringify(states)})) data.project.items.find((i) => i.id === Number(id)).verdictState = s; render();`);
    const said = (why) => { const t = 'Stale verdict: ' + why + '. Re-review it before it lands.'; return `<span class="chip stale" role="img" title="${t}" aria-label="${t}">stale</span>`; };
    const stale = said(`main changed web/&lt;b&gt;x&lt;/b&gt;&amp;&quot;y&#39;.html in ${one} after this verdict checked it`);
    const legacy = said(`main changed web/page-4.html in ${two} after this verdict checked it (an older receipt, judged from where the claim began)`);
    const marks = (html) => (html.match(/<span class="chip stale"[^>]*>stale<\/span>/g) ?? []).join('');
    const rows = (html, at) => [1, 2, 3, 4].map((id) => marks(html.split('<li').find((row) => row.includes(at(id))) ?? ''));
    assert.deepEqual(rows(page.show('chain'), (id) => `data-item="${id}"`), [stale, '', '', legacy], 'the list marks the stale and legacy verdicts, never the fresh or merged one');
    assert.match(itemRow(page.show('chain'), 1), /<b class="stage-word">Verified<\/b>/, 'the status stays verified');
    await page.click({ state: 'verified' });
    assert.deepEqual(rows(page.show('chain'), (id) => `data-item="${id}"`), [stale, '', '', legacy], 'the verified filter still lists them');
    await page.click({ go: 'item:1' });
    assert.equal(marks(page.show('detail')), stale, 'the detail marks it beside the verified chip');
    await page.click({ itemPanelTab: 'verdicts' });
    assert.match(page.show('detail'), /<div class="verdict yes"><b>Accepted · <span title="CRITERION_MET">criterion met<\/span>/, 'the ACCEPT stays in the history with its native reason tooltip');
    await page.click({ go: 'item:3' });
    assert.equal(marks(page.show('detail')), '', 'a merged item carries no mark');
    page.run('view.tab = "roadmap"; render();');
    assert.deepEqual(rows(page.show('roadmap'), (id) => `data-roadmap-key="i:#${id}"`), [stale, '', '', legacy], 'the Roadmap marks the same rows');
    await page.click({ tab: 'shouts' });
    page.run('view.agent = "web-1"; render();');
    assert.deepEqual(rows(page.show('agents').replaceAll('<div class="agent-work"', '<li'), (id) => `data-item="${id}"`), [stale, '', '', legacy], 'the builder holds its stale verdicts in the agent rows');
  } finally { await view.stop(); }
});
test('each row says what it waits on [N26]', async () => {
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'alpha', SPEC, { lanes });
  const add = async (lane, title, ...more) => box.inProcess(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'renders', ...more);
  await add('web', 'Free');
  await add('web', 'Base');
  await add('web', 'Depends', '--after', '2');
  await add('api', 'Api work');
  await add('web', 'Shipped');
  await add('web', 'Bounced');
  build(box, alpha, 5, 'shipped.html');
  build(box, alpha, 6, 'bounced.html');
  sendBack(box, alpha, 6, 'not yet');
  await box.inProcess(alpha.web, 'claim', '2');
  await box.inProcess(alpha.repo, 'hold', 'api', '--reason', 'API <freeze> until Friday');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    const rows = Object.fromEntries(page.show('chain').split('<li class="row').slice(1).map((row) => [/data-item="(\d+)"/.exec(row)[1], {
      stage: /<b class="stage-word">([^<]*)<\/b>/.exec(row)?.[1] || /aria-label="([^:]+):/.exec(row)?.[1],
      detail: /<small class="stage-detail"(?: title="[^"]*")?>([^<]*)<\/small>/.exec(row)?.[1],
      marks: [...row.matchAll(/class="stage-mark[^\"]*"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]),
      gated: /^[^"]*\bgated\b/.test(row),
      waits: [...row.matchAll(/<span class="gate">(.*?)<\/span>/g)].map((match) => match[1]),
    }]));
    assert.deepEqual(rows['1'], { stage: 'Ready', detail: 'strong route', marks: [], gated: false, waits: [] }, 'free to claim');
    assert.deepEqual(rows['2'], { stage: 'Building', detail: 'by web-1 (Test Model)', marks: [], gated: false, waits: [] }, 'a claim names its holder');
    assert.deepEqual(rows['3'], { stage: 'Gated', detail: 'by #2', marks: [], gated: true, waits: [] }, 'gated on #2, which is still being built');
    assert.deepEqual(rows['4'], { stage: 'Gated', detail: 'lane api held: API &lt;freeze&gt; until Friday', marks: ['Lane held'], gated: true, waits: ['lane held: API &lt;freeze&gt; until Friday'] });
    assert.deepEqual(rows['5'], { stage: 'In review', detail: 'awaiting a verdict', marks: [], gated: false, waits: [] });
    assert.deepEqual(rows['6'], { stage: 'Ready', detail: 'strong route', marks: ['Sent back'], gated: false, waits: [] });

    await page.click({ go: 'item:2' });
    assert.match(page.show('detail'), /<h2><span class="id">#2<\/span>Base<\/h2>/, 'the gate links to what it waits on');
  } finally {
    await view.stop();
  }
});
test('an item detail shows its pending, red and green check baselines from the API [V2,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'check-baselines');
  const main = box.git(alpha.repo, 'rev-parse', 'main');
  const checks = [
    { title: 'Pending baseline', command: 'node --test pending.test.js', result: 'pending', request: '00000000-0000-4000-8000-000000000001' },
    { title: 'Red baseline', command: 'node --test red.test.js', result: 'red', seconds: 2 },
    { title: 'Green baseline', command: 'node --test green.test.js', result: 'green', seconds: 1 },
  ];
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
      assert.ok(detail.includes(`<span class="chip ${checks[index].result === 'green' ? 'ok' : checks[index].result === 'red' ? 'no' : 'warn'}">${checks[index].result}</span>`),
        `the ${checks[index].result} baseline is visible`);
      if (checks[index].result === 'green') {
        assert.ok(detail.includes('This check already passed before the work, so it proves nothing.'), 'green baseline warning is plain language');
      } else {
        assert.doesNotMatch(detail, /proves nothing/, 'pending and red baselines do not claim the check proves nothing');
      }
      if (checks[index].result === 'pending') {
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
        assert.ok(completed.includes('<span class="chip ok">green</span>'), 'the open detail updates to the completed result');
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
    assert.ok(row.includes('<b><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> no &lt;b&gt;greeting&lt;/b&gt; on the page'), row);
    assert.ok(!row.includes('second line'), 'the row shows the first line of the note only');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> the farewell is missing'));

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

    assert.ok(itemRow(page.show('chain'), 5).includes('<b><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> the footer is empty'), 'a row being reworked still says why');
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

test('a sent-back reason reads once [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for sent-back reason rendering checks');

  const box = machine();
  const alpha = project(box, 'sent-back-reason');
  for (const title of ['Duplicate reason', 'Plain note']) {
    await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'the sent-back note reads clearly');
  }
  const notes = [
    'BEHAVIOR_MISMATCH a78c361: selected-lane exception is unclear',
    'BEHAVIOR_MISMATCHED is a separate code-like prefix: the issue remains',
  ];
  build(box, alpha, 1, 'duplicate.html');
  sendBack(box, alpha, 1, notes[0]);
  build(box, alpha, 2, 'plain.html');
  sendBack(box, alpha, 2, notes[1]);

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-sent-back-reason-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 2');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain .row[data-item="1"] .why')`);
      for (const [id, title, expectedRow, expectedCard] of [
        ['1', 'Duplicate reason', 'Behavior did not match a78c361: selected-lane exception is unclear', 'a78c361: selected-lane exception is unclear'],
        ['2', 'Plain note', 'Behavior did not match BEHAVIOR_MISMATCHED is a separate code-like prefix: the issue remains', 'BEHAVIOR_MISMATCHED is a separate code-like prefix: the issue remains'],
      ]) {
        await chrome.click(`document.querySelector('#chain .row[data-item="${id}"]')`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('${title}')`);
        const rendered = JSON.parse(await chrome.stable(`JSON.stringify({
          row: document.querySelector('#chain .row[data-item="${id}"] .why')?.textContent,
          card: document.querySelector('#detail .sentback .verdict .note')?.textContent,
          reason: document.querySelector('#detail .sentback .verdict b')?.textContent,
          reasonCode: document.querySelector('#detail .sentback .verdict b [title]')?.title,
        })`));
        assert.equal(rendered.row, expectedRow, `${width}px item #${id}: the row shows the readable reason once`);
        assert.equal(rendered.card, expectedCard, `${width}px item #${id}: the card removes only a duplicated leading code`);
        assert.equal(rendered.reason, 'Sent back · Behavior did not match', `${width}px item #${id}: the card retains its verdict heading`);
        assert.equal(rendered.reasonCode, 'BEHAVIOR_MISMATCH', `${width}px item #${id}: the raw verdict reason remains in its tooltip`);
      }
    }
    const storedItems = (await boardOf(view, alpha.repo)).items;
    for (const [index, id] of [1, 2].entries()) {
      assert.equal(storedItems.find((item) => item.id === id).verdict.note, notes[index],
        `rendering leaves item #${id}'s stored verdict unchanged`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the list shows active, verified or all [N26]', async () => {
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'alpha', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'api', 'Endpoint', '--specs', 'G1', '--criterion', 'answers');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    const control = () => [...page.show('filter-menu').matchAll(/<button class="filter-option" role="menuitemradio" aria-checked="(true|false)" data-filter-choice="state:([a-z]+)"[^>]*><span class="filter-option-label">([A-Za-z ]+)<\/span><b>(\d+)<\/b><\/button>/g)].map((match) => `${match[3]} ${match[4]}${match[1] === 'true' ? ' (shown)' : ''}`);
    const rows = () => [...page.show('chain').matchAll(/data-item="(\d+)"/g)].map((match) => Number(match[1])).sort();
    assert.deepEqual(control(), ['Active 1 (shown)', 'Verified 1', 'All 2'], 'three choices, each with its count');
    assert.deepEqual(rows(), [2]);
    await page.click({ state: 'verified' });
    assert.deepEqual(rows(), [1]);
    await page.click({ state: 'all' });
    assert.deepEqual(rows(), [1, 2]);
    assert.match(page.html, /<div class="card-panel toolbar" id="items-toolbar">\s*<div class="items-view-switch" id="items-view-switch"><\/div>\s*<div class="filter-control"><button class="filter-toggle" id="filter-toggle"/, 'the view toggle and filter are together in the toolbar');
    assert.doesNotMatch(page.html, /id="lane-pick"|id="state-chips"/, 'the old second-row controls are gone');
    assert.match(page.html, /<header class="top">[^]*<div class="top-find"><input id="q" type="search"[^]*<\/header>/, 'and the search is in the top bar');
    assert.doesNotMatch(page.html, /id="lane-filter"|class="chips" id="state-chips"/, 'no lane menu and no row of chips');

    await page.click({ state: 'active' });
    await page.type('q', 'api');
    assert.deepEqual(rows(), [2], 'typing a lane finds its items');
  } finally {
    await view.stop();
  }
});

test('the items toolbar is one row: view, filter and new [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the required real-Chrome toolbar check needs Chrome');
  const box = machine();
  const longLane = 'apilonglanenameforclipping';
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, [longLane]: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'toolbar', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Active item', '--specs', 'G1');
  await box.inProcess(alpha.repo, 'add', longLane, 'Another item', '--specs', 'G1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-items-toolbar-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelectorAll('#chain .row').length === 2");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      for (const scheme of ['light', 'dark']) {
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
        await press(chrome, "document.querySelector('#filter-toggle')");
        await chrome.waitFor("!document.querySelector('#filter-menu').hidden");
        const layout = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const toolbar = document.querySelector('.toolbar'), nodes = [...toolbar.children];
          const rect = node => { const r = node.getBoundingClientRect(), edges = node.matches('.seg button') ? [...node.querySelectorAll('.seg-hit')].map(edge => edge.getBoundingClientRect()) : []; const top = Math.min(r.top, ...edges.map(edge => edge.top)), bottom = Math.max(r.bottom, ...edges.map(edge => edge.bottom)); return { top, bottom, height:bottom-top, left:r.left, right:r.right }; };
          const menu = rect(document.querySelector('#filter-menu'));
          return { children:nodes.map(node => node.id || node.className), rows:nodes.map(rect), scroll:toolbar.scrollWidth,
            client:toolbar.clientWidth, page:document.documentElement.scrollWidth, width:innerWidth,
            menu,
            buttons:[...toolbar.querySelectorAll('button')].map(node => ({ text:node.innerText, name:node.getAttribute('aria-label'), height:rect(node).height })),
            groups:[...document.querySelectorAll('#filter-menu .filter-group')].map(group => group.getAttribute('aria-label')) };
        })())`));
        assert.deepEqual(layout.children, ['items-view-switch', 'filter-control', 'new-item'], `${width}/${scheme}: exactly the three toolbar controls appear in order`);
        // One row: the controls share a centre line (the segmented options retain their 44px hitboxes within the 44px track).
        const centres = layout.rows.map(row => (row.top + row.bottom) / 2);
        assert.ok(Math.max(...centres) - Math.min(...centres) <= 2, `${width}/${scheme}: controls share one row: ${JSON.stringify(layout)}`);
        assert.ok(layout.scroll <= layout.client && layout.page <= width, `${width}/${scheme}: no horizontal toolbar or page scroll: ${JSON.stringify(layout)}`);
        assert.ok(layout.menu.left >= 0 && layout.menu.right <= width, `${width}/${scheme}: the long-lane menu stays within the viewport: ${JSON.stringify(layout.menu)}`);
        assert.deepEqual(layout.groups, ['Show', 'Lane'], `${width}/${scheme}: the open filter has both groups`);
        assert.deepEqual(layout.buttons.slice(0, 2).map(button => button.text), ['List', 'Pipeline'], `${width}/${scheme}: List and Pipeline lead the row`);
        assert.ok(layout.buttons.every(button => button.height >= tapTarget(width)), `${width}/${scheme}: toolbar buttons meet the ${tapTarget(width)}px target: ${JSON.stringify(layout.buttons)}`);
        assert.equal(layout.buttons.at(-1).name, 'New item', `${width}/${scheme}: the new action keeps its accessible name`);
        assert.equal(layout.buttons.at(-1).text, width < 900 ? 'New' : 'New item', `${width}/${scheme}: the new action uses the right visible label`);
        if (process.env.PULLBOARD_ITEMS_TOOLBAR_PROOF) {
          mkdirSync(process.env.PULLBOARD_ITEMS_TOOLBAR_PROOF, { recursive: true });
          const shot = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          writeFileSync(join(process.env.PULLBOARD_ITEMS_TOOLBAR_PROOF, `toolbar-${width}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
        }
        await press(chrome, "document.querySelector('#detail')");
        await chrome.waitFor("document.querySelector('#filter-menu').hidden");
      }
    }
    await press(chrome, "document.querySelector('#new-item')");
    await chrome.waitFor("!document.querySelector('#add-form').hidden");
    await press(chrome, "document.querySelector('#add-cancel')");
    await chrome.waitFor("document.querySelector('#add-form').hidden");
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

/** The items toolbar at 375 behind CI's classic scrollbar with every label widened by a letter-spacing in em, so each
 *  widens by the same share of its face on every runner, whatever fonts the runner has (#445). With forcedFonts the
 *  toolbar also draws in a wide face where the machine has one; without, each label keeps its own face, which shows
 *  the widening never rested on the face. */
const wideFontToolbar = (forcedFonts) => async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the wide-font toolbar check needs Chrome');
  const box = machine();
  const longLane = 'apilonglanenameforclipping';
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, [longLane]: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, forcedFonts ? 'wide-fonts' : 'wide-spacing', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Active item', '--specs', 'G1');
  await box.inProcess(alpha.repo, 'add', longLane, 'Another item', '--specs', 'G1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-items-wide-fonts-chrome-'));
  let chrome;
  /** The toolbar's visible labels by their text's own width, measured from the glyphs, not the boxes, and the face each draws in. */
  const labels = async () => JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('.items-view-switch button, #filter-label, #new-item span')]
    .filter((e) => e.getClientRects().length).map((e) => { const r = document.createRange(); r.selectNodeContents(e); return [e.id || e.textContent.trim(), r.getBoundingClientRect().width, getComputedStyle(e).fontFamily]; }))`));
  const widths = (list) => JSON.stringify(list.map(([name, width]) => [name, Math.round(width * 100) / 100]));
  /** Sideways scroll of the toolbar and the page, and every box in the toolbar or its menu that reaches past the toolbar's inside edge. */
  const fit = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const bar = document.querySelector('.toolbar'), s = getComputedStyle(bar), r = bar.getBoundingClientRect();
    const left = r.left + parseFloat(s.borderLeftWidth), right = r.right - parseFloat(s.borderRightWidth);
    const name = (e) => e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : e.tagName.toLowerCase();
    const past = [...bar.querySelectorAll('*')].filter((e) => e.getClientRects().length).map((e) => [name(e), e.getBoundingClientRect()])
      .filter(([, b]) => b.left < left - 0.5 || b.right > right + 0.5).map(([n, b]) => [n, Math.round(b.left), Math.round(b.right)]);
    return { toolbar: [bar.scrollWidth, bar.clientWidth], page: [Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), innerWidth], inside: [Math.round(left), Math.round(right)], past };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelectorAll('#chain .row').length === 2");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    // CI's runners draw a classic 15px scrollbar, which the window's width counts and the page cannot use: that is
    // what put the open menu past the toolbar on every job (#442). Draw one here too.
    await chrome.stable("(() => { const sheet = document.styleSheets[0]; sheet.insertRule('html { overflow-y: scroll; }', 0); sheet.insertRule('::-webkit-scrollbar { width: 15px; }', 0); return true; })()");
    await chrome.waitFor('document.documentElement.clientWidth === 360');
    const before = await labels();
    // A letter-spacing in em on the toolbar and its menu adds the same share of each face to every letter, so the
    // widening does not hang on which fonts this machine has. On Linux CI the forced face fell back to the runner's
    // own and "New" widened only 6% (#445). The forced face, where a machine has it, widens further.
    const face = forcedFonts ? 'font-family: Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif !important; ' : '';
    await chrome.stable(`(() => { const sheet = document.styleSheets[0]; sheet.insertRule('.toolbar, .toolbar *, .filter-menu, .filter-menu * { ${face}letter-spacing: .12em !important; }', sheet.cssRules.length); return true; })()`);
    const after = await labels();
    assert.deepEqual(after.map(([name]) => name), before.map(([name]) => name), 'the same labels, widened');
    if (forcedFonts) assert.ok(after.every(([, , family]) => family.startsWith('Verdana')), `every label asks for the forced face: ${JSON.stringify(after)}`);
    else assert.deepEqual(after.map(([, , family]) => family), before.map(([, , family]) => family), 'every label keeps its own face');
    assert.ok(after.every(([, width], i) => width >= before[i][1] * 1.1), `every label is at least 10% wider: ${widths(before)} to ${widths(after)}`);
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
      for (const open of [false, true]) {
        if (open) {
          await press(chrome, "document.querySelector('#filter-toggle')");
          await chrome.waitFor("!document.querySelector('#filter-menu').hidden");
        }
        const at = `375/${scheme}/menu ${open ? 'open' : 'closed'}`;
        const measured = await fit();
        assert.ok(measured.toolbar[0] <= measured.toolbar[1] && measured.page[0] <= measured.page[1], `${at}: neither the toolbar nor the page scrolls sideways: ${JSON.stringify(measured)}`);
        assert.deepEqual(measured.past, [], `${at}: nothing reaches past the toolbar's edges (${measured.inside}): ${JSON.stringify(measured.past)}`);
        if (open) {
          await press(chrome, "document.querySelector('#detail')");
          await chrome.waitFor("document.querySelector('#filter-menu').hidden");
        }
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
};

test('the items toolbar fits at 375 with wide fonts [N26]', wideFontToolbar(true));

test('the wide-font widening holds without the forced fonts [N26]', wideFontToolbar(false));

test('the filter menu sets show and lane [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the required real-Chrome filter check needs Chrome');
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'filter', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Active item', '--specs', 'G1');
  await box.inProcess(alpha.repo, 'add', 'api', 'Verified item', '--specs', 'G1');
  const api = join(box.dir, 'filter-api');
  const apiBranch = 'api/filter';
  box.git(alpha.repo, 'worktree', 'add', '-q', api, '-b', apiBranch);
  await box.inProcess(api, 'join', 'api');
  await box.inProcess(api, 'claim', '2');
  mkdirSync(join(api, 'api'), { recursive: true });
  writeFileSync(join(api, 'api', 'verified.html'), 'verified.html\n');
  box.git(api, 'add', '-A');
  box.git(api, 'commit', '-q', '-m', 'feat(api): verified [G1]');
  await box.inProcess(api, 'submit', '2');
  box.git(alpha.repo, 'switch', '-q', '--detach', apiBranch);
  await box.inProcess(alpha.repo, 'verify', '2', 'accept', '--note', 'the page shows it', '--as', 'coordinator');
  box.git(alpha.repo, 'switch', '-q', 'main');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-items-filter-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelectorAll('#chain .row').length === 1");
    assert.equal(await chrome.stable("document.querySelector('#chain .row').dataset.item"), '1');
    await press(chrome, "document.querySelector('#filter-toggle')");
    await chrome.waitFor("!document.querySelector('#filter-menu').hidden");
    assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#filter-menu .filter-option[data-filter-kind=state]')].map(option => option.querySelector('.filter-option-label').textContent + ' ' + option.querySelector('b').textContent))")), ['Active 1', 'Verified 1', 'All 2'], 'Show choices name their counts');
    await press(chrome, "document.querySelector('#filter-menu [data-state=verified]')");
    await chrome.waitFor("view.state === 'verified' && document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("document.querySelector('#chain .row').dataset.item"), '2', 'choosing Verified updates the list at once');
    assert.equal(await chrome.stable("document.querySelector('#filter-toggle').textContent"), 'Filter: Verified');
    await press(chrome, "document.querySelector('#filter-toggle')");
    assert.equal(await chrome.stable("document.querySelector('#filter-menu .filter-option[data-filter-kind=lane][data-filter-value=api]').getAttribute('aria-label')"), 'api · 1');
    await press(chrome, "document.querySelector('#filter-menu .filter-option[data-filter-kind=lane][data-filter-value=api]')");
    await chrome.waitFor("view.lane === 'api' && document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("document.querySelector('#filter-toggle').textContent"), 'Filter: Verified · api', 'mouse can choose a lane');
    await press(chrome, "document.querySelector('#filter-toggle')");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    for (let step = 0; step < 1; step += 1) {
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    }
    await chrome.waitFor("document.activeElement.dataset.filterChoice === 'state:verified'");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    await chrome.waitFor("view.state === 'verified' && document.querySelector('#filter-menu').hidden");
    await press(chrome, "document.querySelector('#filter-toggle')");
    for (let step = 0; step < 5; step += 1) {
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    }
    await chrome.waitFor("document.activeElement.dataset.filterChoice === 'lane:api'");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    await chrome.waitFor("view.lane === 'api' && document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("document.querySelector('#chain .row').dataset.item"), '2', 'choosing a lane from the keyboard applies it immediately');
    assert.equal(await chrome.stable("document.querySelector('#filter-toggle').textContent"), 'Filter: Verified · api');
    await press(chrome, "document.querySelector('#filter-toggle')");
    assert.equal(await chrome.stable("document.querySelector('#filter-menu [data-filter-kind=state][data-filter-value=verified]').getAttribute('aria-checked')"), 'true', 'the selected Show option is marked');
    assert.equal(await chrome.stable("document.querySelector('#filter-menu [data-filter-value=api]')?.getAttribute('aria-checked')"), 'true', 'the selected Lane option is marked');
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await chrome.waitFor("document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("view.state + ':' + view.lane + ':' + document.querySelector('#filter-toggle').textContent"), 'verified:api:Filter: Verified · api', 'Escape closes without changing either choice');
    await press(chrome, "document.querySelector('#filter-toggle')");
    await press(chrome, "document.querySelector('[data-items-view=pipeline]')");
    await chrome.waitFor("view.itemsView === 'pipeline'");
    await press(chrome, "document.querySelector('#filter-toggle')");
    assert.equal(await chrome.stable("document.querySelectorAll('#filter-menu .filter-group').length"), 1, 'Pipeline omits Show');
    assert.equal(await chrome.stable("document.querySelector('#filter-menu .filter-group').getAttribute('aria-label')"), 'Lane');
    await press(chrome, "document.querySelector('#filter-menu .filter-option[data-filter-kind=lane][data-filter-value=web]')");
    await chrome.waitFor("view.lane === 'web' && document.querySelector('#filter-menu').hidden");
    assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#pipeline .pipeline-item')].map(item => item.dataset.item))")), ['1'], 'the Lane choice still filters Pipeline');
    await press(chrome, "document.querySelector('[data-items-view=list]')");
    await chrome.waitFor("view.itemsView === 'list'");
    await press(chrome, "document.querySelector('#filter-toggle')");
    await press(chrome, "document.querySelector('#detail')");
    await chrome.waitFor("document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("view.state + ':' + view.lane"), 'verified:web', 'an outside click closes without changing either choice');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('shout ids, search and narrow windows reach the item [N26]', async () => {
  const box = machine();
  const p = project(box, 'desk');
  await box.inProcess(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(p.repo, 'add', 'web', 'Farewell banner', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, p, 2, 'farewell.html');
  accept(box, p, 2);
  // Item 39 exists, so an escaped apostrophe (&#39;) read as an id would turn into a link.
  for (let id = 3; id <= 39; id += 1) await box.inProcess(p.repo, 'add', 'web', `Filler ${id}`, '--specs', 'G1', '--criterion', 'fills');
  await box.inProcess(p.repo, 'add', 'web', 'Retired widget', '--specs', 'G1', '--criterion', 'retires');
  await box.inProcess(p.repo, 'withdraw', '40', 'nobody needs the widget');
  await box.inProcess(p.web, 'shout', 'all', "#1 is next; #2 shipped (#99 is not an item) and it's done");
  await box.inProcess(p.web, 'shout', 'all', "#7, see#7 and #7#8: it's 5 o'clock");
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    assert.equal(page.run('view.state'), 'active');
    assert.doesNotMatch(page.show('chain'), /Farewell banner/, 'Active hides the verified item');
    await page.type('q', 'farewell');
    assert.match(page.show('chain'), /Farewell banner/, 'a search finds the verified item');
    assert.match(page.show('filter-menu'), /aria-checked="true" data-filter-choice="state:all"/, 'and marks the all-state choice');
    assert.match(page.show('filter-menu'), /<span class="filter-option-label">Verified<\/span><b>1<\/b>/);
    assert.match(page.show('filter-menu'), /<span class="filter-option-label">Active<\/span><b>0<\/b>/, 'the menu counts the matches');
    await page.type('q', '');
    assert.equal(page.run('view.state'), 'active', 'clearing the search brings the chip back');
    assert.doesNotMatch(page.show('chain'), /Farewell banner/);

    // Type, click Active with the query still there, then edit the query to the verified title.
    await page.type('q', 'filler');
    assert.equal(page.run('view.state'), 'all');
    await page.click({ state: 'active' });
    assert.equal(page.run('view.state'), 'active', 'a chip clicked mid-search narrows the list');
    await page.type('q', 'farewell banner');
    assert.equal(page.run('view.state'), 'all', 'typing again searches every state');
    assert.match(page.show('chain'), /Farewell banner/, 'and finds the verified item');
    await page.type('q', '');
    assert.equal(page.run('view.state'), 'active', 'emptying the box brings back the chip from before the search');
    assert.doesNotMatch(page.show('chain'), /Retired widget/, 'browsing leaves withdrawn items out');
    await page.type('q', 'retired widget');
    const found = itemRow(page.show('chain'), 40);
    assert.match(found, /Retired widget/, 'a search finds the withdrawn item too');
    assert.match(found, /<b class="stage-word">Ready<\/b>/);
    assert.match(found, /<span class="stage-mark no"[^>]*>Withdrawn<\/span>/);
    assert.match(page.show('filter-menu'), /<span class="filter-option-label">All<\/span><b>1<\/b>/);
    assert.match(page.show('filter-menu'), /<span class="filter-option-label">Active<\/span><b>0<\/b>/, 'a withdrawn item is not active');
    await page.type('q', '');

    await page.click({ tab: 'shouts' });
    const feed = ['item:1', 'item:7'].map(key => {
      page.run(`view.shoutThread = ${JSON.stringify(key)}; render();`);
      return page.show('feed');
    }).join('');
    assert.ok(feed.includes(`<a class="ref" href="/items/1" data-go="item:1" title="Greeting">#1</a> is next;`), feed);
    assert.ok(feed.includes(`<a class="ref" href="/items/2" data-go="item:2" title="Farewell banner">#2</a> shipped`));
    assert.ok(feed.includes(`(<a class="ref" href="/items/99" data-go="item:99">#99</a> is not an item) and it&#39;s done`), 'an unknown item still has its address, and the apostrophe stays intact');
    const ref = (id, title) => `<a class="ref" href="/items/${id}" data-go="item:${id}" title="${title}">#${id}</a>`;
    assert.ok(feed.includes(`${ref(7, 'Filler 7')}, see${ref(7, 'Filler 7')} and ${ref(7, 'Filler 7')}${ref(8, 'Filler 8')}: it&#39;s 5 o&#39;clock`), 'every #id links, whatever stands next to it');
    assert.equal(feed.match(/class="ref"/g).length, 7);
    await page.click({ go: 'item:2', classes: 'ref' });
    assert.equal(page.run('view.tab'), 'items', 'the link opens the Items tab');
    assert.match(page.show('detail'), /<h2><span class="id">#2<\/span>Farewell banner<\/h2>/, 'on that item');
    assert.equal(page.element('detail').scrolled, 0, 'side by side, the detail is already in view');

    const narrow = await openPage(view, { width: 600 });
    await narrow.click({ tab: 'items' });
    await narrow.click({ item: '1', classes: 'row' });
    assert.match(narrow.show('detail'), /Greeting/);
    assert.equal(narrow.element('detail').scrolled, 1, 'under 900px, picking an item brings its detail into view');
    await narrow.click({ tab: 'shouts' });
    await narrow.click({ go: 'item:2', classes: 'ref' });
    assert.equal(narrow.element('detail').scrolled, 2, 'and so does a link to one');
  } finally {
    await view.stop();
  }
});
test('the detail opens on the top item, not a blank form [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  // Beta's first row is #3, while its #1 and #2 share ids with alpha's first row and pick.
  const beta = project(box, 'beta');
  for (const title of ['Beta one', 'Beta two', 'Beta three']) await box.inProcess(beta.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  const empty = project(box, 'empty');
  const done = project(box, 'done');
  await box.inProcess(done.repo, 'add', 'web', 'Shipped page', '--specs', 'G1', '--criterion', 'renders');
  build(box, done, 1, 'shipped.html');
  accept(box, done, 1);
  const gone = project(box, 'gone');
  await box.inProcess(gone.repo, 'add', 'web', 'Dropped page', '--specs', 'G1', '--criterion', 'renders');
  await box.inProcess(gone.repo, 'withdraw', '1', 'nobody needs it');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    const shown = () => /<h2><span class="id">#(\d+)<\/span>([^<]*)</.exec(page.show('detail'))?.slice(1).join(' ');
    const rows = () => [...page.show('chain').matchAll(/<li class="(row s-[^"]+)" data-item="(\d+)"/g)].map((match) => match[2] + (match[1].split(/\s/u).includes('on') ? '*' : ''));
    const form = () => [page.element('add-form').hidden, page.element('detail').hidden];

    assert.equal(shown(), '2 Farewell', 'the first row, the item updated last');
    assert.deepEqual(rows(), ['2*', '1'], 'its row is marked');
    assert.deepEqual(form(), [true, false], 'no blank form');

    await box.inProcess(alpha.web, 'claim', '1');
    page.element('shout-to').value = 'web';
    page.element('shout-text').value = 'Greeting is claimed';
    await page.fire('shout-form', 'submit');
    assert.deepEqual(rows(), ['1', '2*'], 'the refresh put the claimed item first');
    assert.equal(shown(), '2 Farewell', 'and the pick held');

    await page.fire('new-item', 'click');
    assert.deepEqual(form(), [false, true], 'New item opens the form');
    assert.equal(page.element('add-cancel').hidden, false);
    await page.fire('add-cancel', 'click');
    assert.deepEqual(form(), [true, false], 'Cancel closes it');
    assert.equal(shown(), '2 Farewell', 'and brings back the item it covered');

    await page.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(shown(), '3 Beta three', "the new project's first row, not an id from alpha");
    assert.deepEqual(rows(), ['3*', '2', '1']);

    await page.click({ root: empty.repo, classes: 'proj side' });
    assert.deepEqual(form(), [false, true], 'a project with no items opens on the form');
    assert.equal(page.element('add-cancel').hidden, true, 'with nothing to go back to');

    await page.click({ root: done.repo, classes: 'proj side' });
    assert.deepEqual(rows(), [], 'Active shows nothing: the only item is verified');
    assert.deepEqual(form(), [true, false]);
    assert.match(page.show('detail'), /Pick an item to see its criterion, verdicts and history\./);

    await page.click({ root: gone.repo, classes: 'proj side' });
    assert.deepEqual(rows(), [], 'no chip lists the only item: it is withdrawn');
    assert.deepEqual(form(), [true, false], 'but an item exists, so no form');
    assert.match(page.show('detail'), /Pick an item to see its criterion, verdicts and history\./);
  } finally {
    await view.stop();
  }
});

test('a new item from the view can carry a brief [N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const add = async (fields) => {
      await page.fire('new-item', 'click');
      for (const [id, value] of Object.entries(fields)) page.element(id).value = value;
      await page.fire('add-form', 'submit');
      return page.element('console').textContent;
    };
    const stored = async (id) => JSON.parse(await box.inProcess(alpha.repo, 'show', String(id), '--json')).item_brief;

    const brief = 'Files: web/greeting.html\nTest: the page says hello';
    const ran = await add({ 'add-lane': 'web', 'add-title': 'Greeting', 'add-specs': 'G1', 'add-brief': brief });
    assert.ok(ran.startsWith(`$ pullboard add web Greeting --specs G1 --brief ${brief}\n`), ran);
    assert.equal(await stored(1), brief, 'the brief reaches the board as written, its line break kept');
    assert.equal(page.element('add-brief').value, '', 'a successful add clears it');

    const plain = await add({ 'add-lane': 'web', 'add-title': 'Farewell', 'add-specs': 'G2', 'add-brief': '  ' });
    assert.ok(plain.startsWith('$ pullboard add web Farewell --specs G2\n'), plain);
    assert.ok(!(await stored(2)), 'left empty, the item gets no brief');
    assert.match(page.html, /<label>Brief<textarea id="add-brief"/, 'the field is in the form, not built by the script');
  } finally {
    await view.stop();
  }
});

test("a finished action's output steps aside [N27]", async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // The page's timers, held by the test: each pending close is recorded and fired at will.
    page.run('globalThis.pause = setTimeout; globalThis.closes = []; globalThis.setTimeout = (run, ms) => closes.push({ run, ms, live: true }); globalThis.clearTimeout = (id) => { if (closes[id - 1]) closes[id - 1].live = false; };');
    const pending = () => JSON.parse(page.run('JSON.stringify(closes.map((close) => [close.ms, close.live]))'));
    const out = page.element('console');
    const shout = async (to, text) => {
      page.element('shout-to').value = to;
      page.element('shout-text').value = text;
      await page.fire('shout-form', 'submit');
    };

    await shout('web', 'hello');
    assert.match(out.textContent, /^\$ pullboard shout web hello\n/);
    assert.deepEqual([out.className, out.hidden], ['console ok', false]);
    assert.deepEqual(pending(), [[6000, true]], 'a close six seconds on');
    page.run('closes[0].run()');
    assert.equal(out.hidden, true, 'and then the output steps aside');

    await shout('web', 'again');
    await shout('nobody-here', 'is anyone there');
    assert.match(out.textContent, /NO_READER/);
    assert.deepEqual([out.className, out.hidden], ['console no', false]);
    assert.deepEqual(pending().slice(1), [[6000, false]], 'the refusal cancelled the close the shout before it left, and set none');

    // Two shouts in flight: the first goes through but answers only after the second, a refusal, has
    // started. The first must not set a close that would hide the refusal.
    page.run('const plain = fetch; let sent = 0; globalThis.fetch = (path, init) => path.endsWith("/moves") ? new Promise((done) => pause(done, ++sent === 1 ? 300 : 900)).then(() => plain(path, init)) : plain(path, init);');
    await shout('web', 'first, and slow to answer');
    await shout('nobody-here', 'second, and refused');
    await new Promise((done) => setTimeout(done, 2000));
    await page.run('refresh()');
    assert.match(out.textContent, /NO_READER/, 'the later action owns the console');
    page.run('closes.filter((close) => close.live).forEach((close) => close.run())');
    assert.deepEqual([out.className, out.hidden], ['console no', false], 'and no close from the earlier success hides it');
  } finally {
    await view.stop();
  }
});
test("item detail merges API facts and moves in one responsive timeline [B33,B29]", { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for item-thread rendering checks.');

  const box = machine();
  const alpha = project(box, 'item-thread');
  await box.inProcess(alpha.repo, 'add', 'web', 'Thread fixture', '--specs', 'G1', '--criterion', 'The item keeps its evidence.');
  await box.inProcess(alpha.web, 'claim', '1');
  const sourceHead = box.git(alpha.repo, 'rev-parse', 'HEAD');
  /** Append a real board fact and return the identity the correction must name. */
  const addFact = async (kind, text, ...flags) => JSON.parse(await box.inProcess(alpha.web, 'fact', '1', kind, text, ...flags, '--json')).fact;
  const oldNote = await addFact('note', 'Earlier observation, now replaced.');
  await addFact('capture', 'Captured the rendered page.', '--ref', `SPEC.md:1-2@${sourceHead}`);
  await box.inProcess(alpha.web, 'release', '1', '--reason', 'OTHER', '--note', 'The item detail fixture releases its claim before opening the thread.');
  await addFact('measurement', 'The view settles in 8 seconds.');
  await box.inProcess(alpha.web, 'claim', '1');
  await addFact('diff', 'The detail gained a thread.');
  await addFact('decision', 'Keep the thread in the item.');
  await addFact('rejection', 'The first layout wrapped poorly.');
  const replacement = await addFact('supersession', 'Correction: the note is replaced.', '--supersedes', oldNote.id);
  await addFact('root-cause', 'The missing projection hid the facts.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-item-thread-chrome-'));
  let chrome;
  try {
    const apiState = await boardOf(view, alpha.repo);
    const expected = apiState.items.find((item) => item.id === 1).thread;
    assert.deepEqual(expected.filter((entry) => entry.type === 'fact').map((entry) => entry.kind),
      ['note', 'capture', 'measurement', 'diff', 'decision', 'rejection', 'supersession', 'root-cause'],
      'the API provides every fact in append order');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('typeof data !== "undefined" && !!data?.project?.items?.find((item) => item.id === 1)');
    await chrome.waitFor('document.querySelectorAll("#detail .tl [data-event-id]").length === ' + expected.length);
    await chrome.click("document.querySelector('#detail [data-item-panel-tab=history]')");
    await chrome.waitFor("!document.querySelector('#detail [data-item-panel-panel=history]').hidden");
    const expectedIds = expected.map((entry) => entry.eventId);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#detail .tl')?.getBoundingClientRect().width > 0`);
      const rendered = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const timeline = document.querySelector('#detail .tl');
        const old = document.querySelector('#detail #fact-${oldNote.id}');
        const replacement = document.querySelector('#detail #fact-${replacement.id}');
        const live = document.querySelector('#detail #fact-${expected.find((entry) => entry.type === 'fact' && entry.kind === 'capture').id}');
        const plain = document.querySelector('#detail .tl-fact:not(.tl-judgement):not(.tl-superseded)');
        const judgementColors = Object.fromEntries(['decision', 'rejection', 'supersession', 'root-cause'].map((kind) => {
          const row = [...timeline.querySelectorAll('.tl-fact')].find((entry) => entry.querySelector('.tl-kind')?.textContent === kind.replaceAll('-', ' '));
          return [kind, row ? getComputedStyle(row.querySelector('.tl-marker')).backgroundColor : null];
        }));
        return {
          ids: [...timeline.querySelectorAll('[data-event-id]')].map((row) => Number(row.dataset.eventId)),
          eventIds: [...timeline.querySelectorAll('[data-event-ids]')].flatMap(row => row.dataset.eventIds.split(' ').map(Number)),
          rows: timeline.querySelectorAll('li').length,
          kinds: [...timeline.querySelectorAll('.tl-fact .tl-kind')].map((chip) => chip.textContent),
          authors: [...timeline.querySelectorAll('.tl-fact .tl-who')].map((name) => name.textContent),
          ages: timeline.querySelectorAll('.tl-fact small time[data-ago]').length,
          oldClass: old?.className,
          replacementHref: old?.querySelector('.thread-replacement')?.getAttribute('href'),
          oldOpacity: Number(old && getComputedStyle(old).opacity),
          replacementOpacity: Number(replacement && getComputedStyle(replacement).opacity),
          liveOpacity: Number(live && getComputedStyle(live).opacity),
          plainMarker: plain ? getComputedStyle(plain.querySelector('.tl-marker')).backgroundColor : null,
          judgementColors,
          judgementKinds: Object.keys(judgementColors).filter((kind) => judgementColors[kind] !== null),
          ref: timeline.querySelector('.tl-fact button[data-code]')?.dataset.code,
          viewport: document.documentElement.clientWidth,
          pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        };
      })())`));
      assert.deepEqual(rendered.eventIds.toSorted((a, b) => a - b), expectedIds, `${width}px: every rendered row retains its exact API event identities`);
      assert.ok(rendered.ids[0] > rendered.ids.at(-1), `${width}px: history is shown newest first`);
      assert.equal(rendered.rows, expected.length, `${width}px: each API event appears exactly once`);
      const expectedFacts = expected.filter((entry) => entry.type === 'fact');
      assert.deepEqual(rendered.kinds, expectedFacts.toReversed().map((entry) => entry.kind.replaceAll('-', ' ')), `${width}px: every native fact kind has its readable visible chip`);
      assert.deepEqual(rendered.authors, expectedFacts.toReversed().map((entry) => entry.by), `${width}px: each fact names its API author`);
      assert.equal(rendered.ages, expectedFacts.length, `${width}px: each fact shows its age`);
      assert.match(rendered.oldClass, /tl-superseded/, `${width}px: the earlier fact is visibly dimmed`);
      assert.equal(rendered.replacementHref, `#fact-${replacement.id}`, `${width}px: the earlier fact links to its replacement`);
      assert.ok(rendered.oldOpacity < rendered.replacementOpacity && rendered.oldOpacity < rendered.liveOpacity,
        `${width}px: computed opacity dims the superseded fact`);
      assert.deepEqual(rendered.judgementKinds, ['decision', 'rejection', 'supersession', 'root-cause'], `${width}px: all judgement kinds appear`);
      for (const [kind, color] of Object.entries(rendered.judgementColors)) {
        assert.notEqual(color, rendered.plainMarker, `${width}px: ${kind} uses a distinct computed marker color`);
      }
      assert.equal(rendered.ref, `SPEC.md:1-2@${sourceHead}`, `${width}px: the committed code reference is actionable`);
      assert.equal(rendered.pageWidth, rendered.viewport, `${width}px: the timeline causes no sideways page scroll`);
    }
    const scrollBefore = JSON.parse(await chrome.stable(`JSON.stringify({ page: document.documentElement.scrollTop, detail: document.querySelector('#detail').scrollTop })`));
    await chrome.click(`document.querySelector('#detail #fact-${oldNote.id} .thread-replacement')`);
    await chrome.waitFor(`location.hash === '#fact-${replacement.id}' && document.querySelector('#detail #fact-${replacement.id}')`);
    const target = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const detail = document.querySelector('#detail'), fact = document.querySelector('#detail #fact-${replacement.id}');
      const box = fact.getBoundingClientRect(), panel = detail.getBoundingClientRect();
      return { item: view.item, id: fact.id, text: document.querySelector('#detail h2')?.textContent,
        page: document.documentElement.scrollTop, detail: detail.scrollTop,
        visible: box.top >= panel.top && box.bottom <= panel.bottom };
    })())`));
    assert.equal(target.id, `fact-${replacement.id}`, 'the replacement anchor resolves to a visible fact');
    assert.equal(target.item, 1, 'following the link keeps the same item selected');
    assert.equal(target.text, '#1Thread fixture', 'the item detail stays open after following the replacement link');
    assert.ok(target.page > scrollBefore.page || target.detail > scrollBefore.detail,
      'following the replacement anchor scrolls to its existing target');
    assert.equal(target.visible, true, 'the replacement is visible after following its link');
    await chrome.click(`document.querySelector('#detail .tl-fact button[data-code]')`);
    await chrome.waitFor(`document.querySelector('#detail .tl-fact button[data-code]')?.getAttribute('aria-expanded') === 'true'`);
    await chrome.waitFor(`document.querySelector('#detail .tl-fact .code')?.textContent.includes('Demo spec')`);
    assert.match(await chrome.stable(`document.querySelector('#detail .tl-fact .code')?.textContent || ''`), /Demo spec/, 'the code reference opens the committed lines');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('in-text item references stay inline and open their target at phone and desktop widths [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for item-reference layout checks.');

  const box = machine();
  const demo = project(box, 'inline-references', SPEC, { practice: 'ways.md' });
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n- G1 [approved, must] Items carry the page behavior. | gate: review\n');
  await box.inProcess(demo.repo, 'add', 'web', 'Target item', '--specs', 'G1', '--criterion', 'the linked target');
  await box.inProcess(demo.repo, 'add', 'web', 'Title links to #1', '--specs', 'G1', '--criterion', 'Criterion links to #1', '--brief', 'Brief links to #1');
  await box.inProcess(demo.web, 'claim', '2');
  await box.inProcess(demo.repo, 'shout', 'person', 'Please choose #1 next', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-inline-references-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('document.querySelectorAll("#chain .row").length >= 2 && document.querySelector("#needs .needs-call")');

    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // Needs you heads the Items list under Active; the steps below leave other tabs and filters open.
      await chrome.click("document.querySelector('[data-tab=items]')"); await chooseFilter(chrome, 'state:active');
      await openItemsNeeds(chrome);
      const decision = "document.querySelector('#needs details[data-needs-key^=\"decision:\"]')";
      if (await chrome.stable(`${decision}.open`) !== true) await chrome.click(`${decision}.querySelector('summary')`);
      // The inline reference stays on its actual question line in the approved Needs disclosure.
      const rendered = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const row = document.querySelector('#chain .row[data-item="2"]');
        const plain = document.querySelector('#chain .row[data-item="1"]');
        const titleRef = row?.querySelector('.t a.ref[data-go]');
        const need = [...document.querySelectorAll('#needs .needs-call')].find((entry) => entry.textContent.includes('Please choose'));
        const needRef = need?.querySelector('.needs-detail p a.ref[data-go]');
        const needAction = need?.querySelector('.needs-detail button[data-go]');
        const realButton = document.querySelector('#new-item');
        /** Measure the element box independently of the inline-link assertion. */
        const rect = node => { const r=node.getBoundingClientRect(); return {height:r.height,width:r.width}; };
        return {
          titleRef: titleRef && { ...rect(titleRef), border:getComputedStyle(titleRef).borderWidth, lineHeight:getComputedStyle(titleRef).lineHeight },
          linkedTitle: row && rect(row.querySelector('.t')),
          plainTitle: plain && rect(plain.querySelector('.t')),
          needRef: needRef && { ...rect(needRef), border:getComputedStyle(needRef).borderWidth, lineHeight:getComputedStyle(needRef).lineHeight },
          needText: need?.querySelector('.needs-detail p') && rect(need.querySelector('.needs-detail p')),
          needAction: needAction && rect(needAction), realButton: realButton && rect(realButton),
        };
      })())`));
      assert.ok(rendered.titleRef && rendered.needRef, `${width}: list and Needs-you references are links: ${JSON.stringify(rendered)}`);
      assert.equal(rendered.titleRef.border, '0px', `${width}: the title reference has no button border`);
      assert.equal(rendered.needRef.border, '0px', `${width}: the Needs-you reference has no button border`);
      assert.ok(Math.abs(rendered.linkedTitle.height - rendered.plainTitle.height) < 1,
        `${width}: the title line matches a plain title: ${JSON.stringify(rendered)}`);
      assert.ok(Math.abs(rendered.titleRef.height - rendered.linkedTitle.height) < 1,
        `${width}: the title link has the surrounding line height: ${JSON.stringify(rendered)}`);
      assert.ok(Math.abs(rendered.needRef.height - rendered.needText.height) < 1,
        `${width}: the Needs-you link has the surrounding line height: ${JSON.stringify(rendered)}`);
      assert.ok(rendered.needAction.height >= tapTarget(width) && rendered.realButton.height >= tapTarget(width),
        `${width}: real controls keep their targets: ${JSON.stringify(rendered)}`);

      for (const section of ['agents', 'spec', 'doctrine']) {
        if (section === 'agents') {
          await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
          const agent = await chrome.stable("(() => { const item=data.project.items.find(i => i.id===2); return item.claim?.by || item.builtBy; })()");
          if (!await chrome.stable(`!!document.querySelector('#agents .agent-card.on [data-agent="${agent}"]')`)) await chrome.click(`document.querySelector('#agents [data-agent="${agent}"]')`);
          await chrome.waitFor('document.querySelector("#agents [data-item=\\"2\\"]")');
        } else {
          await chrome.click(`document.querySelector('[data-tab="${section}"]')`);
          await chrome.click(`document.querySelector('[data-rows="${section}:all"]')`);
          const citedRow = 'G1';
          if (section === 'doctrine') {
            await chrome.waitFor('data?.project?.practice?.some(row => row.id === "G1") && data?.project?.items?.some(item => item.id === 2 && item.specs.includes("G1"))');
          }
          await chrome.waitFor(`document.querySelector('#${section}-list [data-row="${section}:${citedRow}"]')`);
          await chrome.click(`document.querySelector('#${section}-list [data-row="${section}:${citedRow}"]')`);
          await chrome.waitFor(`document.querySelector('#${section}-detail [data-item="2"]')`);
        }
        const selector = section === 'agents' ? '#agents [data-item="2"] .ref' : `#${section}-detail .links [data-item="2"] .ref`;
        const metrics = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const ref = document.querySelector(${JSON.stringify(selector)});
          const container = ref?.closest('[data-item="2"]');
          const r = ref?.getBoundingClientRect();
          const c = container?.getBoundingClientRect();
          return { present:!!ref, border:ref && getComputedStyle(ref).borderWidth,
            refHeight:r?.height, lineHeight:ref && parseFloat(getComputedStyle(ref).lineHeight),
            containerHeight:c?.height, nestedButtons:container ? [...container.querySelectorAll('.ref')].filter(link => link.parentElement.closest('button')).length : 0 };
        })())`));
        assert.ok(metrics.present, `${width}: ${section} citing title renders a compact item reference: ${JSON.stringify(metrics)}`);
        assert.equal(metrics.border, '0px', `${width}: ${section} reference has no button border`);
        assert.ok(Math.abs(metrics.refHeight - metrics.lineHeight) < 1, `${width}: ${section} reference keeps the text line height: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.containerHeight >= tapTarget(width), `${width}: ${section} containing item keeps a target`);
        assert.equal(metrics.nestedButtons, 0, `${width}: ${section} title has no nested controls`);
        await chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
        await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");
        await chrome.click(`document.querySelector('[data-tab="${section === 'agents' ? 'shouts' : section}"]')`);
        await chrome.click(`document.querySelector(${JSON.stringify(selector)}).closest('[data-item="2"]')`);
        await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Title links to #1')");
      }

      await chrome.click(`document.querySelector('[data-tab="items"]')`);
      await chrome.click(`document.querySelector('#chain .row[data-item="2"] .t a.ref[data-go]')`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
      await chooseFilter(chrome, 'state:active');
      if (await chrome.stable(`${decision}.open`) !== true) await chrome.click(`${decision}.querySelector('summary')`);
      await chrome.click(`${decision}.querySelector('.needs-detail p a.ref[data-go]')`);
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");

      await chrome.click(`document.querySelector('[data-tab="activity"]')`);
      await chrome.waitFor(`document.querySelector('#activity .activity-quote a.ref[data-go="item:1"]')`);
      await chrome.click(`document.querySelector('#activity .activity-quote a.ref[data-go="item:1"]')`);
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");

      await chrome.click(`document.querySelector('#chain .row[data-item="2"]')`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Title links to #1') && document.querySelector('#detail .text a.ref[data-go]') && document.querySelector('#detail .text.muted a.ref[data-go]')");
      await chrome.click(`document.querySelector('#detail .text a.ref[data-go]')`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
      await chrome.click(`document.querySelector('#chain .row[data-item="2"]')`);
      await chrome.waitFor("document.querySelector('#detail .text.muted a.ref[data-go]')");
      await chrome.click(`document.querySelector('#detail .text.muted a.ref[data-go]')`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('list rows hold their shape: one-line titles end in an ellipsis, every row as tall as the next [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for list row checks.');

  const box = machine();
  const demo = project(box, 'row-shape');
  const long = 'A title far too long for one line of the list: it names `pullboard land` and #1, then keeps on going past every width a phone or a laptop gives a row, so only an ellipsis can end it';
  const titles = { 1: 'Short title', 2: long, 3: 'Waits on the short one', 4: 'Built, then sent back with a long reason', 5: 'Being built right now' };
  await box.inProcess(demo.repo, 'add', 'web', titles[1], '--specs', 'G1', '--criterion', 'short');
  await box.inProcess(demo.repo, 'add', 'web', titles[2], '--specs', 'G1', '--criterion', 'long');
  await box.inProcess(demo.repo, 'add', 'web', titles[3], '--specs', 'G1', '--criterion', 'gated', '--after', '1');
  await box.inProcess(demo.repo, 'add', 'web', titles[4], '--specs', 'G1', '--criterion', 'back');
  await box.inProcess(demo.repo, 'add', 'web', titles[5], '--specs', 'G1', '--criterion', 'busy');
  build(box, demo, 4, 'four.txt');
  sendBack(box, demo, 4, `It misses the edge: ${'the criterion names a blank name and the page still greets it, '.repeat(4)}`);
  await box.inProcess(demo.web, 'claim', '5');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-row-shape-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 5');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const rows = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#chain .row')].map((row) => {
        const box = (node) => node.getBoundingClientRect();
        const lines = (node) => Math.round(box(node).height / parseFloat(getComputedStyle(node).lineHeight));
        const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
        const title = row.querySelector('.t'), meta = row.querySelector('.meta'), chip = row.querySelector('.row-side .item-stage');
        return { id: row.dataset.item, tip: row.title, height: Math.round(box(row).height),
          titleLines: lines(title), ellipsis: getComputedStyle(title).textOverflow === 'ellipsis' && getComputedStyle(title).whiteSpace === 'nowrap',
          cut: title.scrollWidth > title.clientWidth, metaLines: lines(meta), stage: chip.querySelector('.stage-word')?.textContent.trim() || chip.getAttribute('aria-label').split(': ')[0], detail: chip.querySelector('.stage-detail').textContent.trim(),
          chipHeight: Math.round(box(chip).height), chipClear: apart(box(chip), box(meta)) && apart(box(chip), box(title)),
          code: [...title.querySelectorAll('code')].map((code) => getComputedStyle(code).display) };
      }))`));
      const place = (row) => `${width}, #${row.id}: ${JSON.stringify(row)}`;
      assert.deepEqual(rows.map((row) => row.id).sort(), ['1', '2', '3', '4', '5'], `${width}: every item has a row`);
      for (const row of rows) {
        assert.equal(row.tip, titles[row.id], `${width}: the row's tooltip is its whole title`);
        assert.ok(row.titleLines === 1 && row.ellipsis, `title is one line, set to end in an ellipsis at ${place(row)}`);
        assert.equal(row.metaLines, 1, `the meta line never wraps, a long verdict reason included, at ${place(row)}`);
        assert.ok(row.chipHeight < 40 && row.chipClear, `the stage and detail stay together without overlapping title or metadata at ${place(row)}`);
      }
      assert.ok(rows.find((row) => row.id === '2').cut, `${width}: the long title is cut, so its ellipsis shows`);
      assert.deepEqual(rows.find((row) => row.id === '2').code, ['inline'], `${width}: inline code in a title stays a word in the line, not a block`);
      assert.equal(new Set(rows.map((row) => row.height)).size, 1, `${width}: every row is as tall as the next: ${JSON.stringify(rows.map((row) => [row.id, row.height]))}`);
      assert.equal(new Set(rows.map((row) => row.chipHeight)).size, 1, `${width}: every chip is the same size`);
      const chips = Object.fromEntries(rows.map((row) => [row.id, `${row.stage}: ${row.detail}`]));
      assert.deepEqual([chips[1], chips[2], chips[3], chips[4]], ['Ready: strong route', 'Ready: strong route', 'Gated: by #1', 'Ready: strong route'], `${width}: each item's stage and short detail`);
      assert.match(chips[5], /^Building: by web-\d+ \(Test Model\)$/, `${width}: a claimed item names who builds it below the stage`);
      // The same state wears the same chip in the item's detail as in its row.
      for (const row of rows) {
        await chrome.click(`document.querySelector('#chain .row[data-item="${row.id}"]')`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.startsWith('#${row.id}')`);
        const detail = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const chip = document.querySelector('#detail .item-panel-status .item-stage'), listed = document.querySelector('#chain .row[data-item="${row.id}"] .row-side .item-stage');
          const word = chip.querySelector('.stage-word'), listedWord = listed.querySelector('.stage-word'), seat = listed.querySelector('.item-seat');
          const paint = (node) => [getComputedStyle(node).backgroundColor, getComputedStyle(node).color, getComputedStyle(node).outlineStyle];
          return { chip: word.textContent.trim() + ': ' + chip.querySelector('.stage-detail').textContent.trim(), samePaint: listedWord ? JSON.stringify(paint(word)) === JSON.stringify(paint(listedWord)) : null, seat: seat?.textContent.trim(), seatStage: seat?.getAttribute('aria-label'), seatVisible: seat ? seat.getClientRects().length > 0 : false };
        })())`));
        if (detail.seat) {
          assert.ok(detail.seatVisible && detail.seatStage.startsWith(row.stage + ': '), `${width}: ruling 49037 keeps the visible seat and accessible stage: ${JSON.stringify(detail)}`);
        } else assert.ok(detail.samePaint, `${width}: #${row.id}'s unheld stage has its row's appearance in the detail: ${JSON.stringify(detail)} vs ${chips[row.id]}`);
        assert.equal(detail.chip, chips[row.id], `${width}: #${row.id}'s detail says what its row says`);
      }
    }
    // Ruling 49037: a long model stays in the hover; the visible native seat remains whole.
    // Keep the long name in the real fixture so a live refresh cannot replace it between widths.
    const configPath = join(demo.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.agents = { names: 'prefix' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    await box.inProcess(demo.web, 'join', 'web', '--model', 'claude-opus-designer-on-a-long-review-model-name');
    await chrome.stable('refresh()');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain .row[data-item="5"] .stage-detail')?.textContent.startsWith('by claude-opus')`);
      const named = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const row = document.querySelector('#chain .row[data-item="5"]'), chip = row.querySelector('.row-side .item-seat'), meta = row.querySelector('.meta');
        const a = chip.getBoundingClientRect(), b = meta.getBoundingClientRect();
        return { seat: chip.textContent.trim(), hover: chip.title, chipWidth: a.width, cap: 10 * parseFloat(getComputedStyle(document.documentElement).fontSize), cut: chip.scrollWidth > chip.clientWidth,
          ellipsis: getComputedStyle(chip).textOverflow === 'ellipsis', clear: b.right <= a.left + 0.5, heights: [...new Set([...document.querySelectorAll('#chain .row')].map((r) => Math.round(r.getBoundingClientRect().height)))] };
      })())`));
      assert.ok(/^web-\d+$/u.test(named.seat) && !named.cut && named.hover.includes('claude-opus-designer-on-a-long-review-model-name') && named.hover.includes('Building:'), `${width}: the native seat stays whole and the long model and stage are available on hover: ${JSON.stringify(named)}`);
      assert.ok(named.clear && named.heights.length === 1, `${width}: and the row keeps its meta clear and its height: ${JSON.stringify(named)}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

/** Native lifecycle writers on a private clock give each pipeline stage a known arrival. */
function pipelineBoard(box, alpha) {
  const base = Date.now() - 60 * 60_000, commit = box.git(alpha.repo, 'rev-parse', 'HEAD'), tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}'), digest = 'a'.repeat(64);
  const at = (minute, move) => earlier(alpha.repo, base + minute * 60_000, move);
  at(0, board => store.register(board, { lane: 'tests', path: join(box.dir, 'pipeline-reviewer') }));
  for (const [id, minute] of [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 2]]) at(minute, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Pipeline item ' + id + (id === 6 ? ' ' + 'Averylongword'.repeat(35) : ''), specIds: ['G1'], criterion: 'Shows the stage' }));
  const claim = (id, minute) => at(minute, board => store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 24 * 60 * 60_000, head: commit, freeze: () => ({ text: '{}', digest }) }));
  const submit = (id, minute) => at(minute, board => submitFixture(board, id, { agentId: 'web-1', commit, tree }));
  const acceptAt = (id, minute) => at(minute, board => store.verify(board, id, { agentId: 'tests-1', decision: 'ACCEPT', note: 'Private pipeline fixture', head: commit, digest, policy: 'any' }));
  claim(1, 3); submit(1, 4); acceptAt(1, 5);
  at(6, board => store.merged(board, 1, { agentId: 'coordinator', commit }));
  claim(2, 7); submit(2, 8); acceptAt(2, 9);
  claim(3, 10); submit(3, 11); claim(4, 12); claim(4, 20);
  at(20, board => store.editItem(board, 5, { agentId: 'coordinator', brief: 'Edited after the newer open item was added' }));
  return { base, arrivals: { open: [5, 0], claimed: [4, 12], submitted: [3, 11], accepted: [2, 9], merged: [1, 6] } };
}

/** Installs capture diagnostics for real Pipeline card presses and leaves the original timeout error intact. */
async function installPipelinePressDiagnostics(chrome) {
  const setup = await chrome.stable(`(() => {
    const pipeline = document.querySelector('#pipeline');
    if (!pipeline) throw new Error('Pipeline container is missing');
    const state = { armed: false, redraws: 0, redrawsAtArm: 0, expected: null, down: null, up: null, click: null };
    const observer = new MutationObserver(records => { state.redraws += records.filter(record => record.target === pipeline && record.type === 'childList').length; });
    observer.observe(pipeline, { childList: true });
    const flush = () => { state.redraws += observer.takeRecords().filter(record => record.target === pipeline && record.type === 'childList').length; return state.redraws; };
    const describe = node => node instanceof Element ? node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '') : String(node);
    const listen = kind => event => {
      if (!state.armed) return;
      const card = event.composedPath().find(node => node instanceof Element && node.classList.contains('pipeline-item')) ?? null;
      state[kind] = { target: describe(event.target), dataItem: card?.dataset.item ?? null, connected: card?.isConnected ?? false,
        viewItem: view.item, pathname: location.pathname, innerWidth, redraws: flush(), node: card };
      if (kind === 'up' && state.down) state.down.connectedAtUp = Boolean(state.down.node?.isConnected);
      if (kind === 'click' && state.down) state.click.sameNodeAsDown = state.click.node === state.down.node;
    };
    document.addEventListener('mousedown', listen('down'), true);
    document.addEventListener('mouseup', listen('up'), true);
    document.addEventListener('click', listen('click'), true);
    state.arm = card => { flush(); state.expected = { dataItem: card?.dataset.item ?? null, connected: Boolean(card?.isConnected), disabled: card?.disabled ?? null };
      state.expectedNode = card; state.down = state.up = state.click = null; state.redrawsAtArm = state.redraws; state.armed = true; return state.expected; };
    state.snapshot = () => {
      const redraws = flush();
      const clean = event => event && ({ target: event.target, dataItem: event.dataItem, connected: event.connected, connectedAtUp: event.connectedAtUp,
        disabled: event.disabled, viewItem: event.viewItem, pathname: event.pathname, innerWidth: event.innerWidth, redraws: event.redraws,
        sameNodeAsDown: event.sameNodeAsDown });
      return { expected: state.expected, down: clean(state.down), up: clean(state.up), click: clean(state.click), refresh: state.refresh ?? null, expectedNodeConnected: Boolean(state.expectedNode?.isConnected),
        downNodeConnectedNow: Boolean(state.down?.node?.isConnected), viewItem: view.item, pathname: location.pathname, innerWidth,
        // press() scrolls and settles the target after arm(); those redraws precede the native press.
        pipelineRedrawsBeforeDown: state.down ? state.down.redraws - state.redrawsAtArm : null,
        pipelineRedrawsSinceDown: state.down ? redraws - state.down.redraws : null,
        pipelineRedrawsBetweenDownAndUp: state.down && state.up ? state.up.redraws - state.down.redraws : null };
    };
    globalThis.__pipelinePressDiagnostic = state;
    return { ready: true, pathname: location.pathname, selected: view.item };
  })()`);
  assert.equal(setup.ready, true, 'the real Pipeline diagnostics are installed');
}

/** Waits for the original Pipeline selection predicate and adds real press diagnostics if its wait times out. */
async function waitForPipelineItem(chrome, id) {
  try {
    await chrome.waitFor(`view.item === ${id}`);
  } catch (error) {
    let snapshot = 'diagnostics unavailable';
    try { snapshot = await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic?.snapshot() ?? null)'); } catch {}
    error.message += `; Pipeline press diagnostics for #${id}: ${snapshot}`;
    throw error;
  }
}

test('Pipeline view shows every stage, status counts, stage ages, detail links and its phone address [N26,N38]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Pipeline view criterion');
  const box = machine(), alpha = project(box, 'pipeline-board');
  const { base, arrivals } = pipelineBoard(box, alpha);
  const status = JSON.parse(await box.inProcess(alpha.repo, 'status', '--json')).stats.items;
  assert.deepEqual(status, { open: 2, claimed: 1, submitted: 1, verified: 2, withdrawn: 0 });
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    const listRead = "JSON.stringify([...document.querySelectorAll('#chain > li[data-item]')].map(row => ({id:Number(row.dataset.item),title:row.title,meta:row.querySelector('.meta').textContent,tag:row.lastElementChild.textContent})))";
    const listBefore = await chrome.stable(listRead);
    await press(chrome, "document.querySelector('[data-items-view=\"pipeline\"]')");
    assert.equal(await chrome.stable('location.pathname'), '/items/pipeline', 'Pipeline has its own shareable address');
    await chrome.waitFor("typeof data !== 'undefined' && location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    const expectedCounts = [0, status.open, status.claimed, status.submitted, 1, 0, 1];
    const read = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#pipeline [data-pipeline-stage]')].map(stage => ({ stage:stage.dataset.pipelineStage, label:stage.querySelector('h2').textContent, count:Number(stage.querySelector('[data-stage-count]').textContent), oldest:Number(stage.querySelector('.pipeline-oldest a[data-go]')?.dataset.go.slice('item:'.length) || 0), since:stage.querySelector('.pipeline-oldest time')?.dataset.ago || null, age:stage.querySelector('.pipeline-oldest time')?.textContent || '', ids:[...stage.querySelectorAll('.pipeline-item')].map(item => Number(item.dataset.item)) })))`));
    assert.deepEqual(read.map(stage => stage.label), ['Gated', 'Ready', 'Building', 'In review', 'Verified', 'Landing', 'Merged']);
    assert.deepEqual(read.map(stage => stage.count), expectedCounts, 'the seven ordered stage columns preserve the native status counts');
    assert.equal(read[4].count + read[6].count, status.verified);
    assert.deepEqual(read.map(stage => stage.ids), [[], [5, 6], [4], [3], [2], [], [1]], 'an accept without a merge remains verified');
    const observedAt = await chrome.stable('Date.now()');
    for (const stage of read) {
      const arrivalKey = { ready: 'open', building: 'claimed', 'in-review': 'submitted', verified: 'accepted' }[stage.stage] || stage.stage;
      if (!stage.ids.length) { assert.equal(stage.oldest, 0, stage.stage + ': empty stage has no oldest item'); continue; }
      const [id, minute] = arrivals[arrivalKey], since = new Date(base + minute * 60_000).toISOString();
      assert.equal(stage.oldest, id, stage.stage + ': oldest item');
      assert.equal(stage.since, since, stage.stage + ': stage arrival survives edit or lease renewal');
      assert.ok(stage.age.length > 0, stage.stage + ': visible elapsed age');
      assert.match(stage.age, /^\d+(m|h)$/, stage.stage + ': a visible elapsed time');
      const elapsed = parseInt(stage.age, 10) * (stage.age.endsWith('h') ? 60 : 1);
      assert.ok(Math.abs(elapsed - (observedAt - Date.parse(since)) / 60_000) <= 1, stage.stage + ': elapsed time matches native fixture arrival'); // budget: one minute is the display's measured-age rounding unit.
    }
    assert.equal(await chrome.stable("document.querySelector('#item-list').hidden"), true);
    await installPipelinePressDiagnostics(chrome);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme',value:scheme}] });
      await chrome.stable('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()');
      assert.equal(await chrome.stable('document.documentElement.dataset.scheme'), scheme);
      for (const id of [1, 2, 3, 4, 5, 6]) {
        const selector = `document.querySelector('#pipeline .pipeline-item[data-item="${id}"]')`;
        await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(${selector})`);
        await press(chrome, selector);
        await waitForPipelineItem(chrome, id); // budget: hang-only ceiling for the opened Pipeline item; no speed target.
        assert.equal(await chrome.stable('view.item'), id, `${width}: every item opens its detail`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('#${id}')`);
      }
      const geometry = JSON.parse(await chrome.stable("JSON.stringify({ width:innerWidth, body:document.documentElement.scrollWidth, stages:[...document.querySelectorAll('.pipeline-stage')].map(node => ({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})) })"));
      assert.ok(geometry.body <= width, `${width}: no sideways scroll: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.stages.every(stage => stage.left >= 0 && stage.right <= width), `${width}: the flow fits the screen`);
      if (process.env.PULLBOARD_PIPELINE_SHOTS) {
        mkdirSync(process.env.PULLBOARD_PIPELINE_SHOTS, {recursive:true});
        await chrome.stable('scrollTo(0,0)');
        const shot = await chrome.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
        writeFileSync(join(process.env.PULLBOARD_PIPELINE_SHOTS, `pipeline-${width}-${scheme}.png`), Buffer.from(shot.data,'base64'));
      }
      }
    }
    await box.inProcess(alpha.repo, 'merged', '2', box.git(alpha.repo, 'rev-parse', 'HEAD'));
    await chrome.waitFor("document.querySelector('[data-stage-count=verified]').textContent === '0' && document.querySelector('[data-stage-count=merged]').textContent === '2'");
    assert.equal(await chrome.stable("document.querySelector('#pipeline [data-pipeline-stage=verified] .pipeline-oldest').textContent"), 'No items', 'a recorded merge advances only the verified item and leaves an honest empty stage');
    await press(chrome, "document.querySelector('[data-items-view=\"list\"]')");
    await chrome.waitFor("!location.hash && !document.querySelector('#item-list').hidden && document.querySelector('#pipeline').hidden");
    assert.equal(await chrome.stable(listRead), listBefore, 'returning to List preserves its Active rows, metadata and ordering');
    assert.deepEqual(JSON.parse(listBefore).map(row => row.id).sort((a,b)=>a-b), [3,4,5,6]);
    await travel(chrome, -1);
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/6' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Page.reload', {});
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/6' && data?.project && !document.querySelector('#pipeline').hidden");
    assert.equal(await chrome.stable("document.querySelector('.tab.on').dataset.tab"), 'items', 'the Pipeline address reloads within Items');
    await travel(chrome, 1);
    await settled(chrome, "!location.hash && !document.querySelector('#item-list').hidden");
    assert.deepEqual(chrome.exceptions, [], 'the pipeline has no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** A real card press records click delivery, Pipeline redraws and address selection under CPU throttling [N26,N38,C7]. */
test('the pipeline opens the clicked item under a 6× CPU throttle [N26,N38,C7]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for one browser journey at the declared 6× CPU load.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the throttled Pipeline click diagnostic');
  const box = machine(), alpha = project(box, 'pipeline-click-under-load');
  pipelineBoard(box, alpha);
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-click-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "document.querySelector('[data-items-view=\"pipeline\"]')");
    await chrome.waitFor("location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await installPipelinePressDiagnostics(chrome);
    const id = 2;
    const selector = `document.querySelector('#pipeline .pipeline-item[data-item="${id}"]')`;
    const armed = await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(${selector})`);
    assert.deepEqual(armed, { dataItem: String(id), connected: true, disabled: false }, 'the intended real card is present and enabled before press');
    let failure = null;
    try {
      await press(chrome, selector);
      await chrome.waitFor(`(() => { const evidence = globalThis.__pipelinePressDiagnostic.snapshot(); globalThis.__pipelinePressDiagnostic.last = evidence; return evidence.viewItem === ${id}; })()`, 15_000); // budget: hang ceiling for the clicked item to reach its detail, not a speed target.
    } catch (error) {
      failure = error;
    }
    const evidence = JSON.parse(await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic.last || globalThis.__pipelinePressDiagnostic.snapshot())'));
    assert.equal(failure, null, `${failure?.message || 'the selected item matched'}; Pipeline click evidence: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.down?.dataItem, String(id), `the mousedown reached the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.up?.dataItem, String(id), `the mouseup remained on the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.dataItem, String(id), `the real click reached the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.viewItem, id, `the intended item is selected: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pathname, `/items/${id}`, `the address names the intended item: ${JSON.stringify(evidence)}`);
    await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('#${id}')`);
    t.diagnostic(`375px 6× Pipeline click: ${JSON.stringify(evidence)}`);
    assert.deepEqual(chrome.exceptions, [], 'the throttled Pipeline click has no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** A real API refresh while the pointer is held must leave the pressed Pipeline card for its click. */
test('a refresh between pointer down and up does not lose the click [N26,N38,C7]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for one native press and forced local refresh; no speed threshold.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the held-pointer refresh journey');
  const box = machine(), alpha = project(box, 'pipeline-refresh-under-press');
  pipelineBoard(box, alpha);
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-refresh-press-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "document.querySelector('[data-items-view=\"pipeline\"]')");
    await chrome.waitFor("location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await installPipelinePressDiagnostics(chrome);
    await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(document.querySelector('#pipeline .pipeline-item[data-item="2"]'))`);
    let refreshObservation;
    await press(chrome, "document.querySelector('#pipeline .pipeline-item[data-item=\"2\"]')", {
      afterMouseDown: async () => {
        const title = 'A new item arrives during the held Pipeline press';
        await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'Refresh the board while a card is pressed');
        refreshObservation = JSON.parse(await chrome.stable(`(async () => {
          await refresh();
          const old = globalThis.__pipelinePressDiagnostic.down?.node;
          const press = globalThis.__pipelinePressDiagnostic.snapshot();
          const observation = { fetchedNewItem: data.project.items.some(item => item.title === ${JSON.stringify(title)}),
            originalCardConnectedWhileHeld: Boolean(old?.isConnected), selected: view.item, pathname: location.pathname, innerWidth,
            pipelineRedrawsBeforeRelease: press.pipelineRedrawsSinceDown, pipelineRedrawsBeforeDown: press.pipelineRedrawsBeforeDown };
          globalThis.__pipelinePressDiagnostic.refresh = observation;
          return JSON.stringify(observation);
        })()`));
        assert.equal(refreshObservation.fetchedNewItem, true, `the real API refresh received the new native board item: ${JSON.stringify(refreshObservation)}`);
        assert.equal(refreshObservation.originalCardConnectedWhileHeld, true, `the changed board does not replace the pressed card before mouseup: ${JSON.stringify(refreshObservation)}`);
        assert.equal(refreshObservation.pipelineRedrawsBeforeRelease, 0, `the Pipeline has not redrawn while the pointer is held: ${JSON.stringify(refreshObservation)}`);
      },
    });
    const evidence = JSON.parse(await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic.snapshot())'));
    assert.equal(evidence.down?.dataItem, '2', `mousedown reached the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.up?.dataItem, '2', `mouseup reached the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.dataItem, '2', `the browser dispatched click to the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.down?.connectedAtUp, true, `the original card remained connected through mouseup: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.sameNodeAsDown, true, `the click belongs to the card that received mousedown: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.viewItem, 2, `the native click opens item #2: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pathname, '/items/2', `the item address agrees with the real selection: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pipelineRedrawsBetweenDownAndUp, 0, `no Pipeline redraw separates mousedown and mouseup: ${JSON.stringify(evidence)}`);
    await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('#2')");
    await chrome.stable('refresh()');
    assert.equal(await chrome.stable('view.item'), 2, 'refresh preserves the selected item instead of an address candidate');
    await chrome.send('Page.reload', {});
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/2' && view.item === 2");
    assert.equal(await chrome.stable('view.item'), 2, 'reload restores the selected item from its address');
    t.diagnostic(`375px 6× held-pointer API refresh: ${JSON.stringify({ refreshObservation, evidence })}`);
    assert.deepEqual(chrome.exceptions, [], 'the refresh and held-pointer click produce no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
