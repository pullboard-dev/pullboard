/** Cockpit needs checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC, machine, project, build, sendBack, startView, styleOf, element, openPage, projectRows, agentEntries, needEntries, itemRow, shoutNameText, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';


test('a decision waits in needs-you until the view answers it [B21, B26, N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.web, 'shout', 'coordinator', 'Greet in <b>French</b> first?', '--decision');
  // Forty shouts after it: the ask is older than every shout the feed loads, and still waits.
  for (let n = 0; n < 40; n += 1) box.run(alpha.web, 'shout', 'all', `note ${n}`);
  // Another project's board numbers its shouts from 1 too.
  const beta = project(box, 'beta');
  box.run(beta.web, 'shout', 'coordinator', 'Beta asks too?', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // The question as the page escapes it, written as a pattern.
    const question = 'Greet in &lt;b&gt;French&lt;/b&gt; first\\?';
    // An agent asks its coordinator (B25): the ask waits on the board with who holds it, never in Needs-you.
    assert.doesNotMatch(page.show('needs'), /decide:/, "an agent's ask is its coordinator's to answer");
    assert.equal(page.element('decisions').hidden, true, 'an ask waiting on others stays folded');
    assert.match(page.show('asks-slot'), /^<button class="asks-toggle" data-fold="waiting" type="button" aria-expanded="false" title="Asks between agents, waiting on others: web-1 \(Test Model\) asks coordinator \(unknown\)">1 ask waiting <span aria-hidden="true">▾<\/span><\/button>$/, 'its toggle sits at the end of the composer line');
    page.run('view.open.waiting = true; render();');
    assert.match(shoutNameText(page.show('decisions')), new RegExp(`^<article class="shout h\\d" data-shout-id="1"><span class="avatar" aria-hidden="true">W1</span><div class="shout-main"><header><b class="who">web-1 \\(Test Model\\)</b><span class="to">→ coordinator \\(unknown\\)</span><span class="mark ask" role="group" title="decision" aria-label="decision">decision</span> <time class="long" data-ago="[^"]+" title="[^"]+">now</time></header><div class="text">${question}</div><button class="more" data-more type="button">more</button></div></article>$`), 'above the shouts as a card, saying who asked whom, with no Answer button');
    assert.doesNotMatch(page.show('feed'), /Greet in/, 'though the feed no longer reaches it');

    // The coordinator passes it up with its note (B27): now it is the person's call.
    box.run(alpha.repo, 'pass', '1', 'over to you');
    await page.run('refresh()');
    const passed = `Passed up from web-1: ${question}\nCoordinator note: over to you`;
    assert.match(page.show('needs'), new RegExp(`^<li class="row ask" data-go="decide:42"><span class="dot ask"></span><div><div class="t">${passed.replace('\n', '<br>')}</div><span class="row-age"><time data-ago="[^"]+">now</time></span><div class="meta"><span class="why"><b>NEEDS YOU</b> a decision, asked by coordinator \\(unknown\\)</span></div></div><span class="chip warn">decide</span></li>`), "first in Needs-you: who passed it, what, and since when");
    assert.match(shoutNameText(page.show('decisions')), new RegExp(`^<div class="head"><i></i>Decision needed</div><article class="shout h\\d lead" data-shout-id="42"><span class="avatar"><svg [\\s\\S]*?</svg></span><div class="shout-main"><header><b class="who">coordinator \\(unknown\\)</b><span class="to">→ person</span><span class="mark ask" role="group" title="decision" aria-label="decision">decision</span> <time class="long" data-ago="[^"]+" title="[^"]+">now</time></header><div class="text">${passed.replace('\n', '<br>')}</div><button class="more" data-more type="button">more</button><button class="ghost answer" data-go="decide:42" type="button">Answer</button></div></article>$`), 'and above the shouts as the coordinator\'s card, with an Answer button');

    const form = () => ({
      answering: !page.element('answering').hidden,
      who: page.element('answering-who').textContent,
      question: page.element('answering-q').textContent,
      to: page.element('shout-to').value,
      locked: Boolean(page.element('shout-to').disabled),
      button: page.element('shout-send').getAttribute('aria-label'),
    });
    page.element('shout-to').value = 'web';
    await page.click({ go: 'decide:42' });
    assert.equal(page.run('view.tab'), 'shouts');
    assert.deepEqual(form(), { answering: true, who: 'coordinator (unknown)', question: 'Passed up from web-1: Greet in <b>French</b> first?\nCoordinator note: over to you', to: 'coordinator', locked: true, button: 'Answer' }, 'Answer turns the form to answering the one who asked');
    await page.fire('answer-cancel', 'click');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'Cancel gives back the plain shout');

    await page.click({ go: 'decide:42' });
    page.element('shout-text').value = 'French, then English';
    await page.fire('shout-form', 'submit');
    assert.equal(page.element('console').textContent.split('\n')[0], '$ pullboard answer 42 French, then English --as person', 'the view answers as the person');
    assert.equal(page.element('console').className, 'console ok');
    const replies = JSON.parse(box.run(alpha.web, 'inbox', '--json')).shouts.filter((shout) => shout.shout_answers === 1);
    assert.deepEqual(replies.map((shout) => [shout.shout_from, shout.shout_to, shout.shout_answers, shout.shout_text]),
      [['person', 'web-1', 1, 'Person answered #42: French, then English']], 'the answer reaches the agent that asked');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'the form is a plain shout again');
    assert.equal(page.element('shout-text').value, '');
    assert.doesNotMatch(page.show('needs'), /decide:/, 'an answered decision leaves Needs-you');
    assert.equal(page.element('decisions').hidden, true, 'and the banner');

    box.run(alpha.web, 'shout', 'coordinator', 'Ship today?', '--decision');
    box.run(alpha.repo, 'pass', '45', 'yours');
    await page.run('refresh()');
    const feed = shoutNameText(page.show('feed'));
    assert.match(feed, /<b class="who">web-1 \(Test Model\)<\/b><span class="to">→ coordinator \(unknown\)<\/span><span class="mark ask" role="group" title="decision" aria-label="decision">decision<\/span> <time [^>]*>[^<]*<\/time><\/header><div class="text">Ship today\?<\/div>/, 'the feed marks an ask');
    assert.match(feed, /<b class="who">person<\/b><span class="to">→ coordinator \(unknown\)<\/span><span class="mark" role="group" title="answer" aria-label="answer">answer<\/span> <time [^>]*>[^<]*<\/time><\/header><div class="text">French, then English<\/div>/, 'and an answer');
    assert.match(page.show('needs'), /data-go="decide:46"/);

    // An answer belongs to the project whose question it shows.
    box.run(beta.repo, 'pass', '1', 'yours too');
    const plain = { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' };
    await page.click({ go: 'decide:46' });
    // The new project's board is held back, so this is the form the moment the switch is made.
    page.run('globalThis.plain = fetch; globalThis.fetch = (path, init) => new Promise((done) => { globalThis.resume = done; }).then(() => plain(path, init));');
    await page.click({ root: beta.repo });
    assert.deepEqual(form(), plain, 'leaving the project leaves answer mode at once');
    page.run('globalThis.fetch = plain; resume();');
    await page.run('refresh()');
    await page.click({ go: 'decide:2' });
    assert.equal(form().question, 'Passed up from web-1: Beta asks too?\nCoordinator note: yours too');
    await page.run(`view.root = ${JSON.stringify(alpha.repo)}; seen = ''; refresh()`);
    assert.deepEqual(form(), plain, 'and so does a board drawn for another project');
    await page.run(`view.root = ${JSON.stringify(beta.repo)}; seen = ''; refresh()`);
    await page.click({ go: 'decide:2' });
    page.run(`view.root = ${JSON.stringify(alpha.repo)}`);
    page.element('shout-text').value = 'yes';
    await page.fire('shout-form', 'submit');
    assert.deepEqual(form(), plain, 'an answer is never sent to another project');
    assert.equal(page.element('console').textContent.split('\n')[0], '$ pullboard answer 42 French, then English --as person', 'nothing ran');
    /** Read the still-open decision by stable identity, independently of display-name formatting. */
    const waiting = (repo, id) => JSON.parse(box.run(repo, 'decisions', '--as', 'person', '--json')).decisions
      .filter((shout) => shout.shout_id === id).map((shout) => [shout.shout_from, shout.shout_to, shout.shout_text]);
    assert.deepEqual(waiting(beta.repo, 2), [['coordinator', 'person', 'Passed up from web-1: Beta asks too?\nCoordinator note: yours too']], "beta's ask still waits");
    assert.deepEqual(waiting(alpha.repo, 46), [['coordinator', 'person', 'Passed up from web-1: Ship today?\nCoordinator note: yours']], "and so does alpha's");
  } finally {
    await view.stop();
  }
});
test("needs-you holds only the person's calls; the rest show on the board with who holds them [B26, N26]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', `${SPEC}- G3 [pending] Greet in French? | gate: review\n- G4 [draft, aim] A footer on every page. | gate: review\n`);
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell yet');
  box.run(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision');
  box.run(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'G3 is open');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const needs = page.show('needs');
    assert.deepEqual(needEntries(needs).map(([go, ref, words]) => [go.split(':')[0], ref, words]), [
      ['decide', null, 'Launch on Friday?'],
      ['spec', 'G3', 'Greet in French?'],
      ['tab', 'web', 'G3 is open'],
      ['tab', '1', 'draft spec rows to approve or drop'],
    ], "the person's calls, and only those: the decision asked of them, the spec's question, the held lane, the draft row");
    assert.equal(needEntries(needs)[0][3], 'a decision, asked by coordinator (unknown)', 'a decision says below who asked it');
    assert.doesNotMatch(needs, /Which colour|Greeting|Farewell/, "an agent's ask, work waiting for a verdict and work sent back are not the person's");
    assert.match(needs, /<li class="row ask" data-go="tab:shouts"><span class="dot ask"><\/span><div><div class="t"><span>web<\/span>G3 is open<\/div><span class="row-age"><time data-ago="[^"]+">(?:now|\d+[mhd])<\/time><\/span><div class="meta"><span class="why"><b>NEEDS YOU<\/b> lane held by coordinator \(unknown\)<\/span><\/div><\/div><span class="chip warn">release<\/span><\/li>/, 'a held lane says who set it and shows the API-provided hold age');

    // Each of the rest is on the board, with who holds it.
    page.run('view.open.waiting = true; render();');
    assert.match(shoutNameText(page.show('decisions')), /<article class="shout h\d" data-shout-id="\d+"><span class="avatar" aria-hidden="true">W1<\/span><div class="shout-main"><header><b class="who">web-1 \(Test Model\)<\/b><span class="to">→ coordinator \(unknown\)<\/span>/, "the agent's ask waits on its coordinator");
    assert.match(itemRow(page.show('chain'), 1), /<span class="chip [^"]*">to verify<\/span><\/li>$/, 'work waiting for a verdict');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b>BEHAVIOR_MISMATCH</b> no farewell yet'), 'and work sent back, with why');
    page.run("view.agent = 'web-1'; render();");
    assert.deepEqual(agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1').holds, ['#2 Farewell: sent back', '#1 Greeting: to verify'], 'the agent that built them holds both');
    page.run('view.agent = null; render();');
    assert.match(page.show('lanes'), /<b>web<\/b> <span class="chip no">held by coordinator \(unknown\)<\/span> <span class="muted">G3 is open<\/span>/, 'a held lane names who holds it');

    // The sidebar counts exactly the person's calls; its line still says what the agents are doing.
    assert.deepEqual(projectRows(page.show('proj-list')).map((row) => [row.needs, row.line]), [['4', '1 decision · 1 question · 1 draft row · 1 lane held · 1 sent back · 1 to verify']]);
    assert.equal(page.run('document.title'), '(4) alpha · Pullboard');
  } finally {
    await view.stop();
  }
});

test('needs-you lines keep their titles on a phone [N26]', async () => {
  const box = machine();
  project(box, 'alpha', `${SPEC}- G3 [pending] Should a greeting with a title long enough to need the room wrap? | gate: review\n`);
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    const style = await styleOf(view);
    // A need is an item's row: its reference and words on the title line, NEEDS YOU and its kind below, its action at the right.
    assert.match(style, /\n\.row \.t \{ grid-area: t; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/, 'the title line ends in an ellipsis rather than wrap');
    assert.deepEqual(needEntries(page.show('needs')), [['spec:G3', 'G3', 'Should a greeting with a title long enough to need the room wrap?', 'an open question in SPEC.md', 'answer']]);
  } finally {
    await view.stop();
  }
});

test('needs you and the asks sit in their lists [N26]', { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Needs you and Shouts checks.');
  const box = machine();
  const spec = `${SPEC}- G3 [pending] Should the greeting name the visitor? | gate: review\n- G4 [draft, must] The footer links home. | gate: web test\n- G5 [draft, aim] The header stays put. | gate: web test\n`;
  const alpha = project(box, 'asks', spec);
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'asks-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/asks2');
  box.run(second, 'join', 'web');
  // The person's calls: a decision passed up to them, the spec's open question, a held lane and two draft rows. And an
  // agent's ask that waits on its coordinator, not on the person.
  box.run(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision');
  box.run(alpha.repo, 'pass', '1', 'over to you');
  box.run(second, 'shout', 'coordinator', 'Ship the footer first?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Freeze for the demo');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-asks-chrome-'));
  let chrome;
  /** Items' head and Shouts' card as they read. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = (e) => !!e && !e.closest('[hidden]') && e.getBoundingClientRect().height > 0;
    const probe = document.createElement('i'); probe.style.color = 'var(--warn)'; document.body.append(probe); const warn = getComputedStyle(probe).color; probe.remove();
    const needs = document.querySelector('#needs');
    const card = document.querySelector('.shouts-card'), decisions = document.querySelector('#decisions');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      needsShown: shown(needs), inList: needs.parentElement === document.querySelector('#chain').parentElement, separateCard: !!document.querySelector('section.needs-you#needs'),
      needs: [...needs.querySelectorAll(':scope > .row')].map((row) => ({ go: row.dataset.go ?? null, words: row.querySelector('.t').textContent, ref: row.querySelector('.t > span')?.textContent ?? null,
        kind: row.querySelector('.meta .why').textContent, label: getComputedStyle(row.querySelector('.meta .why b')).color === warn && getComputedStyle(row.querySelector('.meta .why')).color === warn, chip: row.querySelector(':scope > .chip').textContent, age: !!row.querySelector('.row-age') })),
      card: card ? [...card.children].map((e) => e.id || e.className) : null,
      composer: box(document.querySelector('.shout-form .composer')), asks: box(document.querySelector('.asks-toggle[data-fold="waiting"]')),
      asksOpen: document.querySelector('.asks-toggle[data-fold="waiting"]')?.getAttribute('aria-expanded') ?? null, showAgents: box(document.querySelector('.asks-slot [data-agents-toggle]')),
      decisions: shown(decisions) ? [...decisions.querySelectorAll('.shout .text')].map((text) => text.textContent) : [], groupTint: getComputedStyle(decisions).backgroundColor, cardTint: card ? getComputedStyle(card).backgroundColor : null,
      firstRule: decisions.querySelector('.shout') ? getComputedStyle(decisions.querySelector('.shout')).borderTopWidth : null,
      feedBar: !!document.querySelector('#feed .feed-bar'), panelShown: shown(document.querySelector('#agents')), hide: !!document.querySelector('.panel-head [data-agents-toggle]'),
      agents: [...document.querySelectorAll('#agents .agent-card')].filter(shown).map((row) => ({ who: [...row.querySelector('.agent-who').children].map((part) => part.textContent.trim()).join(' '), what: row.querySelector('.agent-doing').textContent.trim(), chipInDoing: !!row.querySelector('.agent-doing .chip'), whatWidth: box(row.querySelector('.agent-what')).width, doingWidth: box(row.querySelector('.agent-doing')).width })),
      okNote: (() => { const c = document.querySelector('#console'); return !!c && !c.hidden && getComputedStyle(c).display !== 'none' && c.classList.contains('ok'); })(),
    };
  })())`));
  const click = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.decisions?.length === 1 && data.project.asked.length === 1 && data.project.holds.length === 1");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        await click('[data-tab=items]');
        await click('[data-state=active]');
        let r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll on Items`);
        // Needs you heads the list: each call a row shaped like an item, NEEDS YOU and its kind (for a decision, who
        // asked) in the warning colour below.
        assert.deepEqual([r.needsShown, r.inList, r.separateCard], [true, true, false], `${at}: Needs you is the head of the Items list, not a card of its own`);
        assert.deepEqual(r.needs.map(({ go, ref, words, kind, chip }) => [go.split(':')[0], ref, words.includes('Which colour for the button?') ? 'Which colour…' : words, kind, chip]), [
          ['decide', null, 'Which colour…', 'NEEDS YOU a decision, asked by coordinator (unknown)', 'decide'],
          ['spec', 'G3', 'G3Should the greeting name the visitor?', 'NEEDS YOU an open question in SPEC.md', 'answer'],
          ['tab', 'web', 'webFreeze for the demo', 'NEEDS YOU lane held by coordinator (unknown)', 'release'],
          ['tab', '2', '2draft spec rows to approve or drop', 'NEEDS YOU Spec rows waiting on you', 'review'],
        ], `${at}: the person's calls, each a row, the drafts one row with their count`);
        assert.ok(r.needs.every((need) => need.label), `${at}: NEEDS YOU and its kind in the warning colour`);
        assert.deepEqual(r.needs.map((need) => need.age), [true, false, true, false], `${at}: a call that has an age shows it at the right`);

        await click('[data-tab=shouts]');
        await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden && !!document.querySelector('#feed .shout')");
        r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll on Shouts`);
        // One card: the composer's line, the asks, the feed.
        assert.deepEqual(r.card, ['shout-form', 'decisions', 'feed'], `${at}: Shouts is one card`);
        if (width === 1280) assert.ok(Math.abs((r.composer.top + r.composer.height / 2) - (r.asks.top + r.asks.height / 2)) <= 4 && r.asks.left >= r.composer.right, `${at}: the asks waiting sit at the end of the composer's line: ${JSON.stringify([r.composer, r.asks])}`);
        assert.deepEqual([r.asksOpen, r.decisions.length, /Which colour for the button\?/.test(r.decisions[0] ?? '')], ['false', 1, true], `${at}: the asks waiting on others stay folded; the person's own decision shows`);
        assert.equal(r.feedBar, false, `${at}: no bar above the feed while it shows every shout`);
        assert.ok(r.hide && r.panelShown, `${at}: the agents panel carries its own hide`);
        // An agent's row: its name and state in words, then what it holds at the full width.
        const holder = r.agents.find((agent) => agent.who.startsWith('web-1'));
        assert.ok(holder && /^web-1 \(Test Model\) building (?:now|\d+[mhd])$/.test(holder.who) && holder.what === '#1 Greeting' && !holder.chipInDoing, `${at}: web-1's row reads as an item's: ${JSON.stringify(holder)}`);
      }
    }

    // Opened, the asks waiting on others are a group set apart from the feed, with no rule above the first.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await click('.asks-toggle[data-fold="waiting"]');
    let r = await read();
    assert.deepEqual([r.asksOpen, r.decisions.length, r.decisions[1]], ['true', 2, 'Ship the footer first?'], 'the toggle opens the ask waiting on others');
    assert.ok(r.groupTint !== r.cardTint && r.firstRule === '0px', `a tinted group with no rule above its first card: ${JSON.stringify([r.groupTint, r.cardTint, r.firstRule])}`);
    // Hidden, the agents come back from the composer's line, after the asks.
    await click('.panel-head [data-agents-toggle]');
    r = await read();
    assert.ok(!r.panelShown && r.showAgents && r.showAgents.left >= r.asks.right, `hidden, Show agents sits on the composer's line after the asks: ${JSON.stringify([r.asks, r.showAgents])}`);
    await click('.asks-slot [data-agents-toggle]');
    assert.ok((await read()).panelShown, 'and brings the panel back');
    // A sent shout shows as its card; no note pushes into the composer's line.
    await chrome.evaluate("document.querySelector('#shout-text').focus()");
    await chrome.send('Input.insertText', { text: 'Footer after the greeting.' });
    await click('#shout-send');
    await chrome.waitFor("[...document.querySelectorAll('#feed .shout .text')].some((text) => text.textContent === 'Footer after the greeting.')", 15_000);
    r = await read();
    assert.equal(r.okNote, false, 'a sent shout is its card, with no note beside the composer');
    // However many calls there are, each is a row: six more decisions make ten rows, none folded into a count.
    for (const n of [1, 2, 3, 4, 5, 6]) box.run(alpha.repo, 'shout', 'person', `Ship part ${n} today?`, '--decision');
    await click('[data-tab=items]');
    await chrome.waitFor("document.querySelectorAll('#needs > .row').length >= 10", 15_000);
    r = await read();
    assert.deepEqual([r.needs.length, r.needs.filter((need) => /^Ship part [1-6] today\?$/.test(need.words)).length, r.needs.every((need) => need.label)], [10, 6, true],
      `ten calls, ten rows, each with its kind in the warning colour: ${JSON.stringify(r.needs)}`);
    assert.equal(await chrome.evaluate("document.querySelector('#needs').textContent.includes('more need you')"), false, 'no call is folded into a count');
    // Narrowed to the unread shouts from the status bar, the feed carries its bar with show all; show all clears it.
    box.run(alpha.web, 'shout', 'coordinator', 'Greeting is half done.');
    await chrome.waitFor("!document.querySelector('#status-unread')?.hidden", 15_000);
    await click('#status-unread');
    await chrome.waitFor("view.tab === 'shouts' && !!document.querySelector('#feed .feed-bar')");
    assert.match(await chrome.evaluate("document.querySelector('#feed .feed-bar').textContent"), /^\d+ unread\s*show all$/, 'narrowed to the unread shouts, the feed carries its bar with show all');
    await click('#feed [data-unread]');
    assert.equal((await read()).feedBar, false, 'show all brings back every shout and clears the bar');
    // Under Verified, or a lane, the list is narrowed and Needs you steps aside.
    await click('[data-state=verified]');
    assert.equal((await read()).needsShown, false, 'under Verified, Needs you steps aside');
    await click('[data-state=active]');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
