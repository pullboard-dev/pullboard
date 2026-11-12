// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks, using the shared real-board fixtures [N26]. */
import '../init/geometry.test.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  request,
} from 'node:http';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  addItem,
  closeBoard,
  completeCheckBaseline,
} from '../../../../packages/store/index.js';
import {
  openBoard,
} from '../../../lib/index.js';
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
  press,
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
