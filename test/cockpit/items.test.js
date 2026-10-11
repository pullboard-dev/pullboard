/** Cockpit items checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { addItem, closeBoard, completeCheckBaseline, openBoard } from '../../src/board.js';
import { tapTarget, SPEC, machine, project, build, sendBack, startView, element, target, openPage, agentEntries, accept, itemRow, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, settled, earlier, press, travel } from './fixture.js';


test('an added item confirmation names its returned id [A3,N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'An existing item', '--specs', 'G1');
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
  box.run(second, 'join', 'web');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  box.run(second, 'next', '--verify');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.match(itemRow(page.show('chain'), 1), /<span class="chip warn" title="reviewing until [^"]+">web-2 \(Test Model\) reviewing<\/span><\/li>$/, 'the row names who holds the review');
    assert.doesNotMatch(page.show('needs'), /Greeting/, "a review is the agents' work, so it stays out of Needs-you");
    page.run('view.open.idle = true; render();');
    const holds = (id) => agentEntries(page.show('agents')).find((agent) => agent.id === id).holds;
    assert.deepEqual(holds('web-2'), ['#1 Greeting: reviewing'], 'the reviewer holds it');
    assert.deepEqual(holds('web-1'), ['#1 Greeting: to verify'], 'the builder waits on it');
    // A name is board text, so it is escaped: give the board on hand a reviewer with markup and redraw.
    page.run('data.project.items.find((i) => i.id === 1).reviewer = "web<b>"; render();');
    assert.match(itemRow(page.show('chain'), 1), />web&lt;b&gt; reviewing<\/span><\/li>$/);
    await page.run('refresh()');

    box.git(second, 'switch', '-q', '--detach', alpha.branch);
    box.run(second, 'verify', '1', 'accept', '--note', 'opened the page and read the greeting');
    await page.run('refresh()');
    await page.click({ state: 'all' });
    assert.match(itemRow(page.show('chain'), 1), /<span class="chip ok">verified<\/span><\/li>$/, 'once the verdict lands, the review is over');
    assert.deepEqual(holds('web-2'), []);
  } finally {
    await view.stop();
  }
});
test('each row says what it waits on [N26]', async () => {
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'alpha', SPEC, { lanes });
  const add = (lane, title, ...more) => box.run(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'renders', ...more);
  add('web', 'Free');
  add('web', 'Base');
  add('web', 'Depends', '--after', '2');
  add('api', 'Api work');
  add('web', 'Shipped');
  add('web', 'Bounced');
  build(box, alpha, 5, 'shipped.html');
  build(box, alpha, 6, 'bounced.html');
  sendBack(box, alpha, 6, 'not yet');
  box.run(alpha.web, 'claim', '2');
  box.run(alpha.repo, 'hold', 'api', '--reason', 'API <freeze> until Friday');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const rows = Object.fromEntries(page.show('chain').split('<li class="row').slice(1).map((row) => [/data-item="(\d+)"/.exec(row)[1], {
      chip: /<span class="chip ([^"]*)"[^>]*>([^<]*)<\/span><\/li>$/.exec(row).slice(1).join(': '),
      edge: /^[^"]*\bgated\b/.test(row),
      waits: [...row.matchAll(/<span class="gate">(.*?)<\/span>/g)].map((match) => match[1]),
    }]));
    assert.deepEqual(rows['1'], { chip: 'free: unclaimed', edge: false, waits: [] }, 'free to claim');
    assert.deepEqual(rows['2'], { chip: 'busy: web-1 (Test Model)', edge: false, waits: [] }, 'a claim names its holder');
    assert.deepEqual(rows['3'], { chip: 'gate: gated', edge: true, waits: ['<span class="wait-unit">waits on <button class="ref" data-go="item:2" type="button">#2</button>'] }, 'gated on #2, which is still being built');
    assert.deepEqual(rows['4'], { chip: 'gate: lane held', edge: true, waits: ['lane held: API &lt;freeze&gt; until Friday'] });
    assert.deepEqual(rows['5'], { chip: 'warn: to verify', edge: false, waits: [] });
    assert.deepEqual(rows['6'], { chip: 'no: sent back', edge: false, waits: [] });

    await page.click({ go: 'item:2' });
    assert.match(page.show('detail'), /<h2><span>#2<\/span>Base<\/h2>/, 'the gate links to what it waits on');
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
      assert.ok(detail.indexOf('<h3>Criterion</h3>') < detail.indexOf('<h3>Check</h3>')
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
        assert.match(completed, /<h2><span>#\d+<\/span>Pending baseline<\/h2>/, 'the open detail stays on the pending item');
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
  box.run(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets by name', '--brief', 'Files: web/greeting.html');
  box.run(p.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye', '--brief', 'Files: web/farewell.html');
  box.run(p.repo, 'add', 'web', 'Heading', '--specs', 'G1', '--criterion', 'has a heading', '--brief', 'Files: web/heading.html');
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
  box.run(p.repo, 'add', 'web', 'Banner', '--specs', 'G1', '--criterion', 'shows a banner', '--brief', 'Files: web/banner.html');
  box.run(p.repo, 'add', 'web', 'Footer', '--specs', 'G1', '--criterion', 'shows a footer', '--brief', 'Files: web/footer.html');
  build(box, p, 4, 'banner.html');
  sendBack(box, p, 4, 'the banner covers the heading');
  box.run(p.repo, 'withdraw', '4', 'the banner is dropped');
  build(box, p, 5, 'footer.html');
  sendBack(box, p, 5, 'the footer is empty');
  box.run(p.web, 'claim', '5');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const beforeCriterion = () => page.show('detail').slice(0, Math.max(0, page.show('detail').indexOf('<h3>Criterion</h3>')));
    const needs = page.show('needs');
    assert.doesNotMatch(needs, /Greeting|Farewell/, "work sent back is the agents' to move, so it stays out of Needs-you; its row says why");
    const row = itemRow(page.show('chain'), 1);
    assert.ok(row.includes('<b>BEHAVIOR_MISMATCH</b> no &lt;b&gt;greeting&lt;/b&gt; on the page'), row);
    assert.ok(!row.includes('second line'), 'the row shows the first line of the note only');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b>BEHAVIOR_MISMATCH</b> the farewell is missing'));

    await page.click({ item: '1', classes: 'row' });
    const detail = page.show('detail');
    const verdict = (await boardOf(view, p.repo)).items.find((item) => item.id === 1).verdict;
    const time = new Date(verdict.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const top = detail.slice(0, detail.indexOf('<h3>Criterion</h3>'));
    assert.ok(detail.indexOf('<h3>Criterion</h3>') > 0, 'the criterion is shown');
    assert.match(top, /<h3>Sent back<\/h3>/);
    assert.match(top, /<b>REJECT BEHAVIOR_MISMATCH<\/b>/);
    assert.match(top, new RegExp(`coordinator \\(unknown\\) · (\\w+ \\d+ )?${time} · at ${verdict.commit.slice(0, 12)}`), 'who sent it back, when, and at which commit');
    assert.ok(top.includes('no &lt;b&gt;greeting&lt;/b&gt; on the page\nsecond line of the note'), 'the full note, escaped, before the criterion');
    assert.ok(!detail.includes('<b>greeting</b>'), 'the note cannot inject markup');
    assert.ok(detail.indexOf('<h3>Criterion</h3>') < detail.indexOf('<h3>Spec rows it serves</h3>'));
    assert.ok(detail.indexOf('<h3>Spec rows it serves</h3>') < detail.indexOf('<h3>Brief</h3>'));
    assert.equal(detail.split('second line of the note').length, 2, 'the note is shown once');

    await page.click({ item: '2', classes: 'row' });
    assert.match(beforeCriterion(), /<h3>Sent back, resubmitted<\/h3>[^]*the farewell is missing/);

    assert.ok(itemRow(page.show('chain'), 5).includes('<b>BEHAVIOR_MISMATCH</b> the footer is empty'), 'a row being reworked still says why');
    await page.click({ item: '5', classes: 'row' });
    assert.match(beforeCriterion(), /<h3>Sent back, being reworked<\/h3>[^]*<b>REJECT BEHAVIOR_MISMATCH<\/b>[^]*the footer is empty/);

    // A withdrawn item has no row; the person reaches it from a spec row or the activity feed.
    assert.equal(itemRow(page.show('chain'), 4), '');
    await page.click({ go: 'item:4' });
    assert.match(page.show('detail'), /<h2><span>#4<\/span>Banner<\/h2>/);
    assert.match(beforeCriterion(), /<h3>Sent back, then withdrawn<\/h3>[^]*<b>REJECT BEHAVIOR_MISMATCH<\/b>[^]*the banner covers the heading/, 'withdrawn after a reject, it still opens with why');
    assert.ok(page.show('detail').indexOf('<h3>Criterion</h3>') < page.show('detail').indexOf('<h3>Brief</h3>'));

    await page.click({ item: '3', classes: 'row' });
    const verified = page.show('detail');
    assert.doesNotMatch(verified, /Sent back/);
    assert.ok(verified.indexOf('<h3>Criterion</h3>') < verified.indexOf('<h3>Brief</h3>'));
    assert.ok(verified.indexOf('<h3>Brief</h3>') < verified.indexOf('<h3>Verdicts</h3>'), 'a verified item keeps its verdicts after the brief');
    assert.ok(verified.indexOf('<h3>Verdicts</h3>') < verified.indexOf('no heading yet'));
    assert.ok(verified.indexOf('no heading yet') < verified.indexOf('the page shows it'), 'every verdict, oldest first');
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
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'the sent-back note reads clearly');
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
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 2');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain .row[data-item="1"] .why')`);
      for (const [id, title, expectedRow, expectedCard] of [
        ['1', 'Duplicate reason', 'BEHAVIOR_MISMATCH a78c361: selected-lane exception is unclear', 'a78c361: selected-lane exception is unclear'],
        ['2', 'Plain note', 'BEHAVIOR_MISMATCH BEHAVIOR_MISMATCHED is a separate code-like prefix: the issue remains', 'BEHAVIOR_MISMATCHED is a separate code-like prefix: the issue remains'],
      ]) {
        await chrome.evaluate(`document.querySelector('#chain .row[data-item="${id}"]').click()`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('${title}')`);
        const rendered = JSON.parse(await chrome.evaluate(`JSON.stringify({
          row: document.querySelector('#chain .row[data-item="${id}"] .why')?.textContent,
          card: document.querySelector('#detail .sentback .verdict .note')?.textContent,
          reason: document.querySelector('#detail .sentback .verdict b')?.textContent,
        })`));
        assert.equal(rendered.row, expectedRow, `${width}px item #${id}: the row shows the reason code once`);
        assert.equal(rendered.card, expectedCard, `${width}px item #${id}: the card removes only a duplicated leading code`);
        assert.equal(rendered.reason, 'REJECT BEHAVIOR_MISMATCH', `${width}px item #${id}: the card retains its verdict heading`);
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
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'api', 'Endpoint', '--specs', 'G1', '--criterion', 'answers');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const control = () => [...page.show('state-chips').matchAll(/<button data-state="([a-z]+)" class="(on)?" type="button">([A-Za-z]+)<b>(\d+)<\/b><\/button>/g)].map((match) => `${match[3]} ${match[4]}${match[2] ? ' (shown)' : ''}`);
    const rows = () => [...page.show('chain').matchAll(/data-item="(\d+)"/g)].map((match) => Number(match[1])).sort();
    assert.deepEqual(control(), ['Active 1 (shown)', 'Verified 1', 'All 2'], 'three choices, each with its count');
    assert.deepEqual(rows(), [2]);
    await page.click({ state: 'verified' });
    assert.deepEqual(rows(), [1]);
    await page.click({ state: 'all' });
    assert.deepEqual(rows(), [1, 2]);
    assert.match(page.html, /<div class="card-panel toolbar"><div class="seg" id="state-chips" role="group" aria-label="Show"><\/div><select class="lane-pick" id="lane-pick" aria-label="Lane"><\/select><button class="go" id="new-item"/, 'the control sits in the toolbar beside the lane picker and New item');
    assert.match(page.html, /<header class="top">[^]*<div class="top-find"><input id="q" type="search"[^]*<\/header>/, 'and the search is in the top bar');
    assert.doesNotMatch(page.html, /id="lane-filter"|class="chips" id="state-chips"/, 'no lane menu and no row of chips');

    await page.click({ state: 'active' });
    await page.type('q', 'api');
    assert.deepEqual(rows(), [2], 'typing a lane finds its items');
  } finally {
    await view.stop();
  }
});
test('shout ids, search and narrow windows reach the item [N26]', async () => {
  const box = machine();
  const p = project(box, 'desk');
  box.run(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(p.repo, 'add', 'web', 'Farewell banner', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, p, 2, 'farewell.html');
  accept(box, p, 2);
  // Item 39 exists, so an escaped apostrophe (&#39;) read as an id would turn into a link.
  for (let id = 3; id <= 39; id += 1) box.run(p.repo, 'add', 'web', `Filler ${id}`, '--specs', 'G1', '--criterion', 'fills');
  box.run(p.repo, 'add', 'web', 'Retired widget', '--specs', 'G1', '--criterion', 'retires');
  box.run(p.repo, 'withdraw', '40', 'nobody needs the widget');
  box.run(p.web, 'shout', 'coordinator', "#1 is next; #2 shipped (#99 is not an item) and it's done");
  box.run(p.web, 'shout', 'coordinator', "#7, see#7 and #7#8: it's 5 o'clock");
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.run('view.state'), 'active');
    assert.doesNotMatch(page.show('chain'), /Farewell banner/, 'Active hides the verified item');
    await page.type('q', 'farewell');
    assert.match(page.show('chain'), /Farewell banner/, 'a search finds the verified item');
    assert.match(page.show('state-chips'), /data-state="all" class="on"/, 'and says it looks in every state');
    assert.match(page.show('state-chips'), /Verified<b>1<\/b>/);
    assert.match(page.show('state-chips'), /Active<b>0<\/b>/, 'the chips count the matches');
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
    assert.match(found, /<span class="chip ">withdrawn<\/span>/);
    assert.match(page.show('state-chips'), /All<b>1<\/b>/);
    assert.match(page.show('state-chips'), /Active<b>0<\/b>/, 'a withdrawn item is not active');
    await page.type('q', '');

    const feed = page.show('feed');
    assert.ok(feed.includes('<button class="ref" data-go="item:1" title="Greeting" type="button">#1</button> is next;'), feed);
    assert.ok(feed.includes('<button class="ref" data-go="item:2" title="Farewell banner" type="button">#2</button> shipped'));
    assert.ok(feed.includes('(#99 is not an item) and it&#39;s done'), 'no link for a missing item, and the apostrophe stays intact');
    const ref = (id, title) => `<button class="ref" data-go="item:${id}" title="${title}" type="button">#${id}</button>`;
    assert.ok(feed.includes(`${ref(7, 'Filler 7')}, see${ref(7, 'Filler 7')} and ${ref(7, 'Filler 7')}${ref(8, 'Filler 8')}: it&#39;s 5 o&#39;clock`), 'every #id links, whatever stands next to it');
    assert.equal(feed.match(/class="ref"/g).length, 6);
    await page.click({ go: 'item:2', classes: 'ref' });
    assert.equal(page.run('view.tab'), 'items', 'the link opens the Items tab');
    assert.match(page.show('detail'), /<h2><span>#2<\/span>Farewell banner<\/h2>/, 'on that item');
    assert.equal(page.element('detail').scrolled, 0, 'side by side, the detail is already in view');

    const narrow = await openPage(view, { width: 600 });
    await narrow.click({ item: '1', classes: 'row' });
    assert.match(narrow.show('detail'), /Greeting/);
    assert.equal(narrow.element('detail').scrolled, 1, 'under 900px, picking an item brings its detail into view');
    await narrow.click({ go: 'item:2', classes: 'ref' });
    assert.equal(narrow.element('detail').scrolled, 2, 'and so does a link to one');
  } finally {
    await view.stop();
  }
});
test('the detail opens on the top item, not a blank form [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  // Beta's first row is #3, while its #1 and #2 share ids with alpha's first row and pick.
  const beta = project(box, 'beta');
  for (const title of ['Beta one', 'Beta two', 'Beta three']) box.run(beta.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  const empty = project(box, 'empty');
  const done = project(box, 'done');
  box.run(done.repo, 'add', 'web', 'Shipped page', '--specs', 'G1', '--criterion', 'renders');
  build(box, done, 1, 'shipped.html');
  accept(box, done, 1);
  const gone = project(box, 'gone');
  box.run(gone.repo, 'add', 'web', 'Dropped page', '--specs', 'G1', '--criterion', 'renders');
  box.run(gone.repo, 'withdraw', '1', 'nobody needs it');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const shown = () => /<h2><span>#(\d+)<\/span>([^<]*)</.exec(page.show('detail'))?.slice(1).join(' ');
    const rows = () => [...page.show('chain').matchAll(/<li class="row s-[a-z]+( on)?[^"]*" data-item="(\d+)"/g)].map((match) => match[2] + (match[1] ? '*' : ''));
    const form = () => [page.element('add-form').hidden, page.element('detail').hidden];

    assert.equal(shown(), '2 Farewell', 'the first row, the item updated last');
    assert.deepEqual(rows(), ['2*', '1'], 'its row is marked');
    assert.deepEqual(form(), [true, false], 'no blank form');

    box.run(alpha.web, 'claim', '1');
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
    const stored = (id) => JSON.parse(box.run(alpha.repo, 'show', String(id), '--json')).item_brief;

    const brief = 'Files: web/greeting.html\nTest: the page says hello';
    const ran = await add({ 'add-lane': 'web', 'add-title': 'Greeting', 'add-specs': 'G1', 'add-brief': brief });
    assert.ok(ran.startsWith(`$ pullboard add web Greeting --specs G1 --brief ${brief}\n`), ran);
    assert.equal(stored(1), brief, 'the brief reaches the board as written, its line break kept');
    assert.equal(page.element('add-brief').value, '', 'a successful add clears it');

    const plain = await add({ 'add-lane': 'web', 'add-title': 'Farewell', 'add-specs': 'G2', 'add-brief': '  ' });
    assert.ok(plain.startsWith('$ pullboard add web Farewell --specs G2\n'), plain);
    assert.ok(!stored(2), 'left empty, the item gets no brief');
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
  box.run(alpha.repo, 'add', 'web', 'Thread fixture', '--specs', 'G1', '--criterion', 'The item keeps its evidence.');
  box.run(alpha.web, 'claim', '1');
  const sourceHead = box.git(alpha.repo, 'rev-parse', 'HEAD');
  /** Append a real board fact and return the identity the correction must name. */
  const addFact = (kind, text, ...flags) => JSON.parse(box.run(alpha.web, 'fact', '1', kind, text, ...flags, '--json')).fact;
  const oldNote = addFact('note', 'Earlier observation, now replaced.');
  addFact('capture', 'Captured the rendered page.', '--ref', `SPEC.md:1-2@${sourceHead}`);
  box.run(alpha.web, 'release', '1');
  addFact('measurement', 'The view settles in 8 seconds.');
  box.run(alpha.web, 'claim', '1');
  addFact('diff', 'The detail gained a thread.');
  addFact('decision', 'Keep the thread in the item.');
  addFact('rejection', 'The first layout wrapped poorly.');
  const replacement = addFact('supersession', 'Correction: the note is replaced.', '--supersedes', oldNote.id);
  addFact('root-cause', 'The missing projection hid the facts.');

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
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.items?.find((item) => item.id === 1)?.thread?.length === ' + expected.length);
    await chrome.waitFor('document.querySelectorAll("#detail .tl [data-event-id]").length === ' + expected.length);
    const expectedIds = expected.map((entry) => entry.eventId);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#detail .tl')?.getBoundingClientRect().width > 0`);
      const rendered = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const timeline = document.querySelector('#detail .tl');
        const old = document.querySelector('#detail #fact-${oldNote.id}');
        const replacement = document.querySelector('#detail #fact-${replacement.id}');
        const live = document.querySelector('#detail #fact-${expected.find((entry) => entry.type === 'fact' && entry.kind === 'capture').id}');
        const plain = document.querySelector('#detail .tl-fact:not(.tl-judgement):not(.tl-superseded)');
        const judgementColors = Object.fromEntries(['decision', 'rejection', 'supersession', 'root-cause'].map((kind) => {
          const row = [...timeline.querySelectorAll('.tl-fact')].find((entry) => entry.querySelector('.tl-fact-head .chip')?.textContent === kind);
          return [kind, row ? getComputedStyle(row, '::before').backgroundColor : null];
        }));
        return {
          ids: [...timeline.querySelectorAll('[data-event-id]')].map((row) => Number(row.dataset.eventId)),
          rows: timeline.querySelectorAll('li').length,
          kinds: [...timeline.querySelectorAll('.tl-fact-head .chip')].map((chip) => chip.textContent),
          authors: [...timeline.querySelectorAll('.tl-fact-head b')].map((name) => name.textContent),
          ages: timeline.querySelectorAll('.tl-fact small time[data-ago]').length,
          oldClass: old?.className,
          replacementHref: old?.querySelector('.thread-replacement')?.getAttribute('href'),
          oldOpacity: Number(old && getComputedStyle(old).opacity),
          replacementOpacity: Number(replacement && getComputedStyle(replacement).opacity),
          liveOpacity: Number(live && getComputedStyle(live).opacity),
          plainMarker: plain ? getComputedStyle(plain, '::before').backgroundColor : null,
          judgementColors,
          judgementKinds: Object.keys(judgementColors).filter((kind) => judgementColors[kind] !== null),
          ref: timeline.querySelector('.tl-fact button[data-code]')?.dataset.code,
          viewport: document.documentElement.clientWidth,
          pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        };
      })())`));
      assert.deepEqual(rendered.ids, expectedIds, `${width}px: moves and facts follow the API's event order`);
      assert.equal(rendered.rows, expected.length, `${width}px: each API event appears exactly once`);
      const expectedFacts = expected.filter((entry) => entry.type === 'fact');
      assert.deepEqual(rendered.kinds, expectedFacts.map((entry) => entry.kind), `${width}px: every fact kind is a visible chip`);
      assert.deepEqual(rendered.authors, expectedFacts.map((entry) => entry.by + ' (Test Model)'), `${width}px: each fact names its API author`);
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
    const scrollBefore = JSON.parse(await chrome.evaluate(`JSON.stringify({ page: document.documentElement.scrollTop, detail: document.querySelector('#detail').scrollTop })`));
    await chrome.evaluate(`document.querySelector('#detail #fact-${oldNote.id} .thread-replacement').click()`);
    await chrome.waitFor(`location.hash === '#fact-${replacement.id}' && document.querySelector('#detail #fact-${replacement.id}')`);
    const target = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
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
    await chrome.evaluate(`document.querySelector('#detail .tl-fact button[data-code]').click()`);
    await chrome.waitFor(`document.querySelector('#detail .tl-fact button[data-code]')?.getAttribute('aria-expanded') === 'true'`);
    await chrome.waitFor(`document.querySelector('#detail .tl-fact .code')?.textContent.includes('Demo spec')`);
    assert.match(await chrome.evaluate(`document.querySelector('#detail .tl-fact .code')?.textContent || ''`), /Demo spec/, 'the code reference opens the committed lines');
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
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Items carry the page behavior. | gate: review\n');
  box.run(demo.repo, 'add', 'web', 'Target item', '--specs', 'G1', '--criterion', 'the linked target');
  box.run(demo.repo, 'add', 'web', 'Title links to #1', '--specs', 'G1', '--criterion', 'Criterion links to #1', '--brief', 'Brief links to #1');
  box.run(demo.web, 'claim', '2');
  box.run(demo.repo, 'shout', 'person', 'Please choose #1 next', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-inline-references-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('document.querySelectorAll("#chain .row").length >= 2 && document.querySelector("#needs .row")');

    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // Needs you heads the Items list under Active; the steps below leave other tabs and filters open.
      await chrome.evaluate("document.querySelector('[data-tab=items]').click(); document.querySelector('[data-state=active]').click()");
      // The row inlineReference stays on its title line beside the text.
      const rendered = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const row = document.querySelector('#chain .row[data-item="2"]');
        const plain = document.querySelector('#chain .row[data-item="1"]');
        const titleRef = row?.querySelector('.t button.ref');
        const need = [...document.querySelectorAll('#needs .row')].find((entry) => entry.textContent.includes('Please choose'));
        const needRef = need?.querySelector('.t button.ref');
        const needAction = need;
        const realButton = document.querySelector('#new-item');
        /** Measure the element box independently of the inline-link assertion. */
        const rect = node => { const r=node.getBoundingClientRect(); return {height:r.height,width:r.width}; };
        return {
          titleRef: titleRef && { ...rect(titleRef), border:getComputedStyle(titleRef).borderWidth, lineHeight:getComputedStyle(titleRef).lineHeight },
          linkedTitle: row && rect(row.querySelector('.t')),
          plainTitle: plain && rect(plain.querySelector('.t')),
          needRef: needRef && { ...rect(needRef), border:getComputedStyle(needRef).borderWidth, lineHeight:getComputedStyle(needRef).lineHeight },
          needText: need?.querySelector('.t') && rect(need.querySelector('.t')),
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
          await chrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);
          await chrome.evaluate("(() => { const item = data.project.items.find((i) => i.id === 2); const who = item.owner || item.reviewer || item.builtBy; if (!document.querySelector('#agents .agent-card.on [data-agent=\"' + who + '\"]')) document.querySelector('#agents [data-agent=\"' + who + '\"]').click(); })()");
          await chrome.waitFor('document.querySelector("#agents [data-item=\\"2\\"]")');
        } else {
          await chrome.evaluate(`document.querySelector('[data-tab="${section}"]').click()`);
          await chrome.evaluate(`document.querySelector('[data-rows="${section}:all"]').click()`);
          const citedRow = section === 'doctrine' ? 'R1' : 'G1';
          if (section === 'doctrine') {
            // Item citations normally point to SPEC ids; add the distinct practice id to the
            // browser projection to exercise the shared doctrine citing-item renderer.
            await chrome.evaluate("data.project.items.find(item => item.id === 2).specs.push('R1'); render();");
          }
          await chrome.waitFor(`document.querySelector('#${section}-list [data-row="${section}:${citedRow}"]')`);
          await chrome.evaluate(`document.querySelector('#${section}-list [data-row="${section}:${citedRow}"]').click()`);
          await chrome.waitFor(`document.querySelector('#${section}-detail [data-item="2"]')`);
        }
        const selector = section === 'agents' ? '#agents [data-item="2"] .ref' : `#${section}-detail .links [data-item="2"] .ref`;
        const metrics = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
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
        await chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");
        await chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('[data-item="2"]').click()`);
        await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Title links to #1')");
      }

      await chrome.evaluate(`document.querySelector('#chain .row[data-item="2"] .t button.ref').click()`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
      await chrome.evaluate(`document.querySelector('#needs .row .t button.ref').click()`);
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");

      await chrome.evaluate(`document.querySelector('[data-tab="activity"]').click()`);
      await chrome.waitFor("document.querySelector('#activity .what button.ref')");
      await chrome.evaluate(`document.querySelector('#activity .what button.ref').click()`);
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");

      await chrome.evaluate(`document.querySelector('#chain .row[data-item="2"]').click()`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Title links to #1') && document.querySelector('#detail .text button.ref') && document.querySelector('#detail .text.muted button.ref')");
      await chrome.evaluate(`document.querySelector('#detail .text button.ref').click()`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
      await chrome.evaluate(`document.querySelector('#chain .row[data-item="2"]').click()`);
      await chrome.waitFor("document.querySelector('#detail .text.muted button.ref')");
      await chrome.evaluate(`document.querySelector('#detail .text.muted button.ref').click()`);
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
  box.run(demo.repo, 'add', 'web', titles[1], '--specs', 'G1', '--criterion', 'short');
  box.run(demo.repo, 'add', 'web', titles[2], '--specs', 'G1', '--criterion', 'long');
  box.run(demo.repo, 'add', 'web', titles[3], '--specs', 'G1', '--criterion', 'gated', '--after', '1');
  box.run(demo.repo, 'add', 'web', titles[4], '--specs', 'G1', '--criterion', 'back');
  box.run(demo.repo, 'add', 'web', titles[5], '--specs', 'G1', '--criterion', 'busy');
  build(box, demo, 4, 'four.txt');
  sendBack(box, demo, 4, `It misses the edge: ${'the criterion names a blank name and the page still greets it, '.repeat(4)}`);
  box.run(demo.web, 'claim', '5');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-row-shape-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 5');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const rows = JSON.parse(await chrome.evaluate(`JSON.stringify([...document.querySelectorAll('#chain .row')].map((row) => {
        const box = (node) => node.getBoundingClientRect();
        const lines = (node) => Math.round(box(node).height / parseFloat(getComputedStyle(node).lineHeight));
        const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
        const title = row.querySelector('.t'), meta = row.querySelector('.meta'), chip = row.querySelector(':scope > .chip');
        return { id: row.dataset.item, tip: row.title, height: Math.round(box(row).height),
          titleLines: lines(title), ellipsis: getComputedStyle(title).textOverflow === 'ellipsis' && getComputedStyle(title).whiteSpace === 'nowrap',
          cut: title.scrollWidth > title.clientWidth, metaLines: lines(meta), chip: chip.className + ': ' + chip.textContent,
          chipHeight: Math.round(box(chip).height), chipClear: apart(box(chip), box(meta)) && apart(box(chip), box(title)),
          code: [...title.querySelectorAll('code')].map((code) => getComputedStyle(code).display) };
      }))`));
      const place = (row) => `${width}, #${row.id}: ${JSON.stringify(row)}`;
      assert.deepEqual(rows.map((row) => row.id).sort(), ['1', '2', '3', '4', '5'], `${width}: every item has a row`);
      for (const row of rows) {
        assert.equal(row.tip, titles[row.id], `${width}: the row's tooltip is its whole title`);
        assert.ok(row.titleLines === 1 && row.ellipsis, `title is one line, set to end in an ellipsis at ${place(row)}`);
        assert.equal(row.metaLines, 1, `the meta line never wraps, a long verdict reason included, at ${place(row)}`);
        assert.ok(row.chipHeight < 24 && row.chipClear, `the chip is one line and nothing runs over it at ${place(row)}`);
      }
      assert.ok(rows.find((row) => row.id === '2').cut, `${width}: the long title is cut, so its ellipsis shows`);
      assert.deepEqual(rows.find((row) => row.id === '2').code, ['inline'], `${width}: inline code in a title stays a word in the line, not a block`);
      assert.equal(new Set(rows.map((row) => row.height)).size, 1, `${width}: every row is as tall as the next: ${JSON.stringify(rows.map((row) => [row.id, row.height]))}`);
      assert.equal(new Set(rows.map((row) => row.chipHeight)).size, 1, `${width}: every chip is the same size`);
      const chips = Object.fromEntries(rows.map((row) => [row.id, row.chip]));
      assert.deepEqual([chips[1], chips[2], chips[3], chips[4]], ['chip free: unclaimed', 'chip free: unclaimed', 'chip gate: gated', 'chip no: sent back'], `${width}: each state's chip in the list`);
      assert.match(chips[5], /^chip busy: web-\d+ \(Test Model\)$/, `${width}: a claimed item names who builds it, in the building colour`);
      // The same state wears the same chip in the item's detail as in its row.
      for (const row of rows) {
        await chrome.evaluate(`document.querySelector('#chain .row[data-item="${row.id}"]').click()`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.startsWith('#${row.id}')`);
        const detail = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
          const chip = document.querySelector('#detail .meta.spaced .chip'), listed = document.querySelector('#chain .row[data-item="${row.id}"] > .chip');
          const paint = (node) => [getComputedStyle(node).backgroundColor, getComputedStyle(node).color, getComputedStyle(node).outlineStyle];
          return { chip: chip.className + ': ' + chip.textContent, samePaint: JSON.stringify(paint(chip)) === JSON.stringify(paint(listed)) };
        })())`));
        assert.ok(detail.samePaint, `${width}: #${row.id}'s chip has its row's colours in the detail: ${JSON.stringify(detail)} vs ${row.chip}`);
        if (row.id !== '5') assert.equal(detail.chip, row.chip, `${width}: #${row.id}'s detail says what its row says`);
        else assert.equal(detail.chip, 'chip busy: building', `${width}: the detail says building, in the colour of its row's builder chip`);
      }
    }
    // A builder's name can be long; its chip stops at its cap and ends in an ellipsis, leaving the title its line.
    await chrome.evaluate("data.project.items.find((item) => item.id === 5).owner = 'claude-opus-designer-on-the-studio-7'; render();");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain .row[data-item="5"] > .chip')?.textContent.startsWith('claude-opus')`);
      const named = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const row = document.querySelector('#chain .row[data-item="5"]'), chip = row.querySelector(':scope > .chip'), meta = row.querySelector('.meta');
        const a = chip.getBoundingClientRect(), b = meta.getBoundingClientRect();
        return { chipWidth: a.width, cap: 10 * parseFloat(getComputedStyle(document.documentElement).fontSize), cut: chip.scrollWidth > chip.clientWidth,
          ellipsis: getComputedStyle(chip).textOverflow === 'ellipsis', clear: b.right <= a.left + 0.5, heights: [...new Set([...document.querySelectorAll('#chain .row')].map((r) => Math.round(r.getBoundingClientRect().height)))] };
      })())`));
      assert.ok(named.chipWidth <= named.cap + 0.5 && named.cut && named.ellipsis, `${width}: a long builder name stops at the chip's cap, cut with an ellipsis: ${JSON.stringify(named)}`);
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
  const submit = (id, minute) => at(minute, board => store.submit(board, id, { agentId: 'web-1', commit, tree }));
  const acceptAt = (id, minute) => at(minute, board => store.verify(board, id, { agentId: 'tests-1', decision: 'ACCEPT', note: 'Private pipeline fixture', head: commit, digest, policy: 'any' }));
  claim(1, 3); submit(1, 4); acceptAt(1, 5);
  at(6, board => store.merged(board, 1, { agentId: 'coordinator', commit }));
  claim(2, 7); submit(2, 8); acceptAt(2, 9);
  claim(3, 10); submit(3, 11); claim(4, 12); claim(4, 20);
  at(20, board => store.editItem(board, 5, { agentId: 'coordinator', brief: 'Edited after the newer open item was added' }));
  return { base, arrivals: { open: [5, 0], claimed: [4, 12], submitted: [3, 11], accepted: [2, 9], merged: [1, 6] } };
}

test('Pipeline view shows every stage, status counts, stage ages, detail links and its phone address [N26,N38]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Pipeline view criterion');
  const box = machine(), alpha = project(box, 'pipeline-board');
  const { base, arrivals } = pipelineBoard(box, alpha);
  const status = JSON.parse(box.run(alpha.repo, 'status', '--json')).stats.items;
  assert.deepEqual(status, { open: 2, claimed: 1, submitted: 1, verified: 2, withdrawn: 0 });
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    const listRead = "JSON.stringify([...document.querySelectorAll('#chain > li[data-item]')].map(row => ({id:Number(row.dataset.item),title:row.title,meta:row.querySelector('.meta').textContent,tag:row.lastElementChild.textContent})))";
    const listBefore = await chrome.evaluate(listRead);
    await press(chrome, "document.querySelector('[data-items-view=\"pipeline\"]')");
    assert.equal(await chrome.evaluate('location.hash'), '#items/pipeline', 'Pipeline has its own shareable address');
    await chrome.waitFor("location.hash === '#items/pipeline' && !document.querySelector('#pipeline').hidden");
    const expectedCounts = [status.open, status.claimed, status.submitted, 1, 1];
    const read = JSON.parse(await chrome.evaluate(`JSON.stringify([...document.querySelectorAll('[data-pipeline-stage]')].map(stage => ({ stage:stage.dataset.pipelineStage, label:stage.querySelector('h2').textContent, count:Number(stage.querySelector('[data-stage-count]').textContent), oldest:Number(stage.querySelector('.pipeline-oldest [data-item]')?.dataset.item || 0), since:stage.querySelector('.pipeline-oldest time')?.dataset.ago || null, age:stage.querySelector('.pipeline-oldest time')?.textContent || '', ids:[...stage.querySelectorAll('.pipeline-item')].map(item => Number(item.dataset.item)) })))`));
    assert.deepEqual(read.map(stage => stage.label), ['Not started', 'Building', 'Waiting for review', 'Accepted, waiting to merge', 'Merged']);
    assert.deepEqual(read.map(stage => stage.count), expectedCounts, 'open/claimed/submitted match status; accepted plus merged equals verified');
    assert.equal(read[3].count + read[4].count, status.verified);
    assert.deepEqual(read.map(stage => stage.ids), [[5, 6], [4], [3], [2], [1]], 'an accept without a merge remains waiting to merge');
    const observedAt = await chrome.evaluate('Date.now()');
    for (const stage of read) {
      const [id, minute] = arrivals[stage.stage], since = new Date(base + minute * 60_000).toISOString();
      assert.equal(stage.oldest, id, stage.stage + ': oldest item');
      assert.equal(stage.since, since, stage.stage + ': stage arrival survives edit or lease renewal');
      assert.ok(stage.age.length > 0, stage.stage + ': visible elapsed age');
      assert.match(stage.age, /^\d+(m|h)$/, stage.stage + ': a visible elapsed time');
      const elapsed = parseInt(stage.age, 10) * (stage.age.endsWith('h') ? 60 : 1);
      assert.ok(Math.abs(elapsed - (observedAt - Date.parse(since)) / 60_000) <= 1, stage.stage + ': elapsed time matches native fixture arrival');
    }
    assert.equal(await chrome.evaluate("document.querySelector('#item-list').hidden"), true);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme',value:scheme}] });
      await chrome.evaluate('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()');
      assert.equal(await chrome.evaluate('document.documentElement.dataset.scheme'), scheme);
      for (const id of [1, 2, 3, 4, 5, 6]) {
        await press(chrome, `document.querySelector('#pipeline .pipeline-item[data-item="${id}"]')`);
        assert.equal(await chrome.evaluate('view.item'), id, `${width}: every item opens its detail`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('#${id}')`);
      }
      const geometry = JSON.parse(await chrome.evaluate("JSON.stringify({ width:innerWidth, body:document.documentElement.scrollWidth, stages:[...document.querySelectorAll('.pipeline-stage')].map(node => ({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})) })"));
      assert.ok(geometry.body <= width, `${width}: no sideways scroll: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.stages.every(stage => stage.left >= 0 && stage.right <= width), `${width}: the flow fits the screen`);
      if (process.env.PULLBOARD_PIPELINE_SHOTS) {
        mkdirSync(process.env.PULLBOARD_PIPELINE_SHOTS, {recursive:true});
        await chrome.evaluate('scrollTo(0,0)');
        const shot = await chrome.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
        writeFileSync(join(process.env.PULLBOARD_PIPELINE_SHOTS, `pipeline-${width}-${scheme}.png`), Buffer.from(shot.data,'base64'));
      }
      }
    }
    box.run(alpha.repo, 'merged', '2', box.git(alpha.repo, 'rev-parse', 'HEAD'));
    await chrome.waitFor("document.querySelector('[data-stage-count=accepted]').textContent === '0' && document.querySelector('[data-stage-count=merged]').textContent === '2'");
    assert.equal(await chrome.evaluate("document.querySelector('[data-pipeline-stage=accepted] .pipeline-oldest').textContent"), 'No items', 'a recorded merge advances only the accepted item and leaves an honest empty stage');
    await press(chrome, "document.querySelector('[data-items-view=\"list\"]')");
    await chrome.waitFor("!location.hash && !document.querySelector('#item-list').hidden && document.querySelector('#pipeline').hidden");
    assert.equal(await chrome.evaluate(listRead), listBefore, 'returning to List preserves its Active rows, metadata and ordering');
    assert.deepEqual(JSON.parse(listBefore).map(row => row.id).sort((a,b)=>a-b), [3,4,5,6]);
    await travel(chrome, -1);
    await settled(chrome, "location.hash === '#items/pipeline' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Page.reload', {});
    await settled(chrome, "location.hash === '#items/pipeline' && data?.project && !document.querySelector('#pipeline').hidden");
    assert.equal(await chrome.evaluate("document.querySelector('.tab.on').dataset.tab"), 'items', 'the Pipeline address reloads within Items');
    await travel(chrome, 1);
    await settled(chrome, "!location.hash && !document.querySelector('#item-list').hidden");
    assert.deepEqual(chrome.exceptions, [], 'the pipeline has no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Pipeline view dates an expired claim from its recorded deadline [N26,N38]', async () => {
  const box = machine(), alpha = project(box, 'pipeline-lapse');
  const base = Date.now() - 60 * 60_000, commit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const at = (minute, write) => earlier(alpha.repo, base + minute * 60_000, write);
  at(0, board => store.addItem(board, { by:'coordinator', lane:'web', title:'Expired claim', specIds:['G1'] }));
  at(10, board => store.claim(board, 1, { agentId:'web-1', lane:'web', leaseMs:30*60_000, head:commit, freeze:()=>({text:'{}',digest:'a'.repeat(64)}) }));
  at(35, board => store.addItem(board, { by:'coordinator', lane:'web', title:'Older open item', specIds:['G1'] }));
  const status = JSON.parse(box.run(alpha.repo, 'status', '--json')).stats.items;
  assert.equal(status.open, 2);
  assert.equal(status.claimed, 0);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({itemsView:'pipeline'});
    const open = () => page.show('pipeline').split('data-pipeline-stage="open"')[1].split('</header>')[1].split('</p>')[0];
    assert.match(open(), /data-item="2"/, 'an open item from minute35 is older than a claim that lapses at minute40');
    assert.match(open(), new RegExp(new Date(base+35*60_000).toISOString()), 'the oldest open timestamp is the arrival');
    box.run(alpha.repo, 'withdraw', '2', 'Private fixture now isolates the lapse age');
    await page.run('refresh()');
    assert.match(open(), /data-item="1"/);
    assert.match(open(), new RegExp(new Date(base+40*60_000).toISOString()), 'expired claim age starts at its native lease deadline');
  } finally { await view.stop(); }
});
