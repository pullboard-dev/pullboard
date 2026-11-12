// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit shouts: composer, agent filter and waiting asks [N26], using the shared real-board fixtures. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  register,
  shout as shoutOnBoard,
} from '../../../../../packages/store/index.js';
import {
  tapTarget,
  SPEC,
  machine,
  project,
  startView,
  element,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  earlier,
  shoutsAt,
  press,
  pressedInto,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  MACHINE_MODEL,
} from '../../../tests/fixtures/cockpit/machine.js';

async function openConversation(chrome, key = 'none') {
  const selector = '#feed [data-shout-thread="' + key + '"]';
  await chrome.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  await chrome.waitFor("!!document.querySelector('#feed .conversation-heading')");
}


test('the shout composer, agent filter and agents panel [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'composer');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.web, 'claim', '1');
  const idle = join(box.dir, 'composer-web-2'), fresh = join(box.dir, 'composer-web-3');
  box.git(alpha.repo, 'worktree', 'add', '-q', idle, '-b', 'web/composer2');
  // web-2 joined and spoke three hours ago, and has not moved since.
  earlier(alpha.repo, Date.now() - 3 * 36e5, (board) => {
    assert.equal(register(board, { lane: 'web', path: idle }), 'web-2');
    shoutOnBoard(board, { from: 'web-2', to: 'coordinator', text: 'An idle agent spoke this morning.', lanes: ['web'] });
  });
  await box.inProcess(alpha.repo, 'shout', 'web-2', 'The coordinator wrote to the idle agent.');
  box.git(alpha.repo, 'worktree', 'add', '-q', fresh, '-b', 'web/composer3');
  await box.inProcess(fresh, 'join', 'web');
  await box.inProcess(fresh, 'shout', 'all', 'A fresh agent says hello.');
  await box.inProcess(alpha.web, 'shout', 'all', 'The claim holder reports in.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-composer-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 4');
    await chrome.click("document.querySelector('[data-tab=shouts]')");
    await openConversation(chrome);
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    await chrome.stable("(document.querySelector('.fold-line[data-fold=\"idle\"]'))?.getAttribute('aria-expanded') !== 'true' && !!(document.querySelector('.fold-line[data-fold=\"idle\"]'))").then(open => open ? chrome.click("document.querySelector('.fold-line[data-fold=\"idle\"]')") : undefined);
    const agents = JSON.parse(await chrome.stable('JSON.stringify(data.project.agents.map((a) => [a.agent_id, a.agent_path]))'));
    assert.deepEqual(agents.filter(([, path]) => [alpha.web, idle, fresh].includes(path)).map(([id]) => id).sort(), ['web-1', 'web-2', 'web-3'], 'three agents joined the web lane');
    const total = await chrome.stable('data.project.shouts.length');
    const state = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const pane = document.querySelector('[data-pane=shouts]'), list = document.querySelector('#agents');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        listed: [...list.querySelectorAll('[data-agent]')].map((e) => e.dataset.agent), on: [...list.querySelectorAll('.agent-card.on [data-agent], .agent-pill.on')].map((e) => e.dataset.agent),
        all: list.querySelector('.all-agents')?.textContent ?? null, panel: list.offsetParent !== null, bare: pane.classList.contains('bare'),
        toggle: document.querySelector('.asks-slot [data-agents-toggle], .panel-head [data-agents-toggle]')?.textContent, bar: document.querySelector('#feed .feed-bar span')?.textContent ?? '',
        cards: [...document.querySelectorAll('#feed .shout')].map((c) => [c.querySelector('.who').textContent, c.querySelector('.to').textContent.replace('→ ', '')]),
        to: document.querySelector('#shout-to').value, feed: box(document.querySelector('#feed')),
        composer: box(document.querySelector('.composer')), message: box(document.querySelector('#shout-text')), send: box(document.querySelector('#shout-send')),
        pickers: [...document.querySelectorAll('.composer select, .composer datalist, .composer input')].filter((e) => e.type !== 'hidden').length,
        kept: (() => { try { return localStorage.getItem('pb.agents'); } catch { return 'unreadable'; } })(),
      };
    })())`));
    const click = (selector) => chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
    const key = async (modifiers) => {
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    };

    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const s = await state();
        assert.ok(s.page.scroll <= s.page.width && s.page.body <= s.page.width, `${at}: no sideways scroll: ${JSON.stringify(s.page)}`);
        // One bar: the message, the send button on the right, in one row; no recipient picker.
        for (const part of ['message', 'send']) assert.ok(s[part].top >= s.composer.top - 0.5 && s[part].bottom <= s.composer.bottom + 0.5, `${at}: the ${part} sits inside the composer bar: ${JSON.stringify(s)}`);
        assert.ok(s.pickers === 0 && s.message.right <= s.send.left + 0.5 && s.composer.right - s.send.right < 12, `${at}: the message, then send: ${JSON.stringify(s)}`);
        assert.ok(s.send.width >= tapTarget(width) && s.send.height >= tapTarget(width), `${at}: the send button is a target, 44px where a finger taps`);
        // Only agents at work are listed, the idle ones in their fold, which ends with show all.
        assert.ok(s.panel && s.listed.includes('web-1') && s.listed.includes('web-3') && !s.listed.includes('web-2'), `${at}: the agents at work, and not the idle one: ${s.listed}`);
        assert.equal(s.all, `show all ${agents.length}`, `${at}: every agent is one click away`);
      }
    }

    await shoutsAt(chrome, 1280, 'light');
    await click('#agents .all-agents');
    let s = await state();
    assert.ok(s.listed.includes('web-2') && s.listed.length === agents.length && s.all === 'show only agents at work', `show all lists every agent: ${JSON.stringify(s.listed)}`);

    // An agent's name filters the feed to its shouts, from or to it, and addresses the composer to it.
    await click('#agents [data-agent="web-2"]');
    s = await state();
    assert.deepEqual(s.cards, [['web-2', 'coordinator'], ['coordinator', 'web-2']], 'the native conversation keeps only shouts from or to web-2 in chronological order');
    assert.deepEqual([s.bar, s.to, s.on], ['Shouts with web-2 show all', 'web-2', ['web-2']], 'the bar says whose, the composer is addressed to them, and the agent is marked');
    await click('#feed .feed-bar [data-agent=""]');
    s = await state();
    assert.deepEqual([s.cards.length, s.bar, s.on, s.to], [total, '', [], 'coordinator'], 'show all undoes the filter, and the composer goes back to the coordinator');
    await click('#agents .all-agents');

    // The message grows as it is typed; Shift+Enter starts a line, Enter sends.
    await chrome.stable("document.querySelector('#shout-text').focus()");
    const height = () => chrome.stable("document.querySelector('#shout-text').getBoundingClientRect().height");
    const one = await height();
    await chrome.send('Input.insertText', { text: 'First line' });
    await key(8);
    await chrome.send('Input.insertText', { text: 'second line' });
    await key(8);
    await chrome.send('Input.insertText', { text: 'third line' });
    assert.equal(await chrome.stable("document.querySelector('#shout-text').value"), 'First line\nsecond line\nthird line', 'Shift+Enter starts a new line');
    assert.ok(await height() > one + 20, 'the message grows as it is typed');
    assert.equal(await chrome.stable('data.project.shouts.length'), total, 'and sends nothing');
    await key(0);
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_text === 'First line\\nsecond line\\nthird line' && s.shout_to === 'coordinator')", 15_000); // budget: hang ceiling for the submitted multiline shout to be recorded; no throughput claim.
    await chrome.waitFor("document.querySelector('#shout-text').value === ''");
    assert.ok(Math.abs(await height() - one) < 1, 'Enter sends, and the bar shrinks back to one line');
    assert.ok(await chrome.stable("!document.querySelector('#console').hidden && !document.querySelector('.composer #console') && document.querySelector('#console').getBoundingClientRect().bottom <= document.querySelector('.composer').getBoundingClientRect().top"),
      'the result stands above the bar, never inside it');

    // The panel hides and shows, and the browser remembers.
    await click('.panel-head [data-agents-toggle]');
    s = await state();
    const wide = s.feed.width;
    assert.deepEqual([s.bare, s.panel, s.toggle, s.kept], [true, false, 'Show agents', 'hidden'], 'Hide agents hides the panel and remembers it');
    await chrome.send('Page.reload');
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length > 0 && !!document.querySelector("[data-tab=shouts]")');
    await chrome.click("document.querySelector('[data-tab=shouts]')");
    await openConversation(chrome);
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    s = await state();
    assert.deepEqual([s.bare, s.panel, s.toggle], [true, false, 'Show agents'], 'still hidden after a reload');
    for (const width of [375, 1280]) {
      await shoutsAt(chrome, width, 'dark');
      s = await state();
      assert.ok(s.page.scroll <= s.page.width && s.page.body <= s.page.width, `${width}px hidden: no sideways scroll`);
    }
    await click('.asks-slot [data-agents-toggle]');
    s = await state();
    assert.deepEqual([s.bare, s.panel, s.toggle, s.kept], [false, true, 'hide', 'shown'], 'Show agents brings it back');
    assert.ok(s.feed.width < wide, 'and the feed gives it room');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the composer goes to the coordinator and says who heard [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered composer checks.');

  const box = machine();
  // A docs lane nobody has joined: a shout to it reaches no agent.
  const alpha = project(box, 'heard', SPEC, { lanes: { web: { owns: ['web/'], specs: ['G'] }, docs: { owns: ['docs/'], specs: ['G'] } } });
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.web, 'shout', 'all', 'Starting on the greeting.');
  earlier(alpha.repo, Date.now(), (board) => shoutOnBoard(board, { from: 'person', to: 'docs', text: 'Docs, anyone?', lanes: ['web', 'docs'] }));
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-heard-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 1');
    await chrome.click("document.querySelector('[data-tab=shouts]')");
    await openConversation(chrome);
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    await chrome.click("document.querySelector('#agents .fold-line[data-fold=\"idle\"]')");
    /** The composer and every shout of the person's, with what its Heard line says. */
    const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const chip = document.querySelector('#shout-to-chip'), clear = chip.querySelector('[data-to-clear]');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        pickers: [...document.querySelectorAll('.composer select, .composer datalist, .composer input')].filter((e) => e.type !== 'hidden').length,
        to: document.querySelector('#shout-to').value, placeholder: document.querySelector('#shout-text').placeholder,
        chip: chip.hidden ? null : chip.textContent, clear: clear ? [clear.getBoundingClientRect().width, clear.getBoundingClientRect().height] : null,
        heard: [...document.querySelectorAll('#feed .shout')].filter((card) => card.querySelector('.heard')).map((card) => {
          const line = card.querySelector('.heard');
          return [card.querySelector('.text').textContent, line.lastChild.textContent, line.querySelectorAll('.heard-face').length, line.title];
        }),
      };
    })())`));
    const key = async () => {
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    };
    const heardOf = (text) => `[...document.querySelectorAll('#feed .shout')].find((card) => card.querySelector('.text').textContent === ${JSON.stringify(text)})?.querySelector('.heard')?.lastChild.textContent`;

    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        assert.deepEqual([r.pickers, r.to, r.placeholder, r.chip], [0, 'coordinator', 'Shout to the coordinator', null], `${at}: no recipient picker; a shout goes to the coordinator, and says so`);
        // A shout to a lane no agent has joined reached no one, so it has not been heard.
        assert.deepEqual(r.heard.find(([text]) => text === 'Docs, anyone?')?.slice(1), ['Not heard yet', 0, ''], `${at}: a shout that reached no agent says Not heard yet`);
        // A picked agent's chip has an x that is a 44px square target; picking the agent again puts it back.
        await chrome.click(`document.querySelector('#agents [data-agent="web-1"]')`);
        const picked = await read();
        assert.ok(picked.chip === `to web-1 (${MACHINE_MODEL})×` && picked.clear[0] >= tapTarget(width) && picked.clear[1] >= tapTarget(width), `${at}: the chip's x is a square target: ${JSON.stringify(picked.clear)}`);
        await chrome.click(`document.querySelector('#agents [data-agent="web-1"]')`);
        assert.equal((await read()).chip, null, `${at}: picking the agent again returns the composer to the coordinator`);
      }
    }

    // The person shouts with Enter: it goes to the coordinator, and says it is not heard until the coordinator reads it.
    await shoutsAt(chrome, 1280, 'light');
    await chrome.stable("document.querySelector('#shout-text').focus()");
    await chrome.send('Input.insertText', { text: 'Ship the greeting?' });
    await key();
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_from === 'person' && s.shout_to === 'coordinator' && s.shout_text === 'Ship the greeting?')", 15_000); // budget: hang ceiling for the person shout to be recorded; no throughput claim.
    await chrome.waitFor(`${heardOf('Ship the greeting?')} === 'Not heard yet'`, 15_000); // budget: hang ceiling for the initial unread state to appear; no throughput claim.
    await box.inProcess(alpha.repo, 'inbox');
    await chrome.waitFor(`${heardOf('Ship the greeting?')} === 'Heard by coordinator'`, 15_000); // budget: hang ceiling for coordinator inbox to mark the shout heard; no throughput claim.
    // A shout that reaches everyone says who of them has read it: the coordinator first, then how many agents.
    // (The person reaches every agent through the relay's requests; here the board records one directly.)
    earlier(alpha.repo, Date.now(), (board) => shoutOnBoard(board, { from: 'person', to: 'all', text: 'Hold the merge, please.', lanes: ['web'] }));
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_from === 'person' && s.shout_to === 'all')", 15_000); // budget: hang ceiling for the addressed-to-all shout to be recorded; no throughput claim.
    await box.inProcess(alpha.repo, 'inbox');
    await box.inProcess(alpha.web, 'inbox');
    await chrome.waitFor(`${heardOf('Hold the merge, please.')} === 'Heard by coordinator and 1 agent'`, 15_000); // budget: hang ceiling for both inbox reads to appear; no throughput claim.
    const all = (await read()).heard.find(([text]) => text === 'Hold the merge, please.');
    assert.deepEqual(all.slice(2), [0, `Heard by coordinator, web-1 (${MACHINE_MODEL})`], 'with no avatars, retaining every native recipient name on hover');

    // Picking an agent addresses the composer to it; the chip's x returns it to the coordinator.
    await chrome.click(`document.querySelector('#agents [data-agent="web-1"]')`);
    let r = await read();
    assert.deepEqual([r.chip, r.to, r.placeholder], [`to web-1 (${MACHINE_MODEL})×`, 'web-1', `Shout to web-1 (${MACHINE_MODEL})`], 'a picked agent shows as a chip');
    const clearAt = tapTarget(await chrome.stable('innerWidth'));
    assert.ok(r.clear[0] >= clearAt && r.clear[1] >= clearAt, 'whose x is a square target');
    await chrome.click(`document.querySelector('#shout-to-chip [data-to-clear]')`);
    r = await read();
    assert.deepEqual([r.chip, r.to, r.placeholder], [null, 'coordinator', 'Shout to the coordinator'], 'the x returns it to the coordinator');
    // An item's Shout button addresses its lane the same way.
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('!!document.querySelector("#chain [data-item=\\"1\\"]")');
    await chrome.click(`document.querySelector('#chain [data-item="1"]')`);
    await chrome.waitFor('!!document.querySelector("#detail [data-shout]")');
    await chrome.click(`document.querySelector('#detail [data-shout]')`);
    await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden");
    for (const width of [375, 1280]) {
      await shoutsAt(chrome, width, 'dark');
      r = await read();
      assert.deepEqual([r.chip, r.to], ['to web×', 'web'], `${width}px dark: an item's Shout button names its lane on the chip`);
      assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${width}px dark: no sideways scroll with the chip`);
    }
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

/** Keep a waiting ask's address and age readable when a fallback font widens its header [N26]. */
test("a waiting ask's who and when stay on one line with wide fonts [N26]", { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the wide-font regression');
  const box = machine();
  const demo = project(box, 'wide-waiting-ask');
  await box.inProcess(demo.web, 'shout', 'coordinator', 'Does this waiting ask fit with a wider font?', '--decision', '--kind', 'question');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-wide-ask-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("data?.project && innerWidth === 375");
    await press(chrome, "document.querySelector('[data-tab=shouts]')");
    await openConversation(chrome);
    await pressedInto(chrome, "!!document.querySelector('#feed .shout:not(:has(.answer)) header')");
    // Change font metrics only: the production layout must fit the same real waiting ask.
    await chrome.stable("(() => { const sheet = document.styleSheets[0]; sheet.insertRule('#feed .shout header { font-family: monospace; letter-spacing: 1px; }', sheet.cssRules.length); })()");
    const result = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const card = document.querySelector('#feed .shout:not(:has(.answer))'), header = card.querySelector('header');
      const rect = (element) => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      const who = header.querySelector('.who'), address = who.querySelector('.agent-id') || who, age = header.querySelector('time'), kind = header.querySelector('.mark');
      const range = document.createRange(); range.selectNodeContents(address);
      const recipient = header.querySelector('.to .agent-id') || header.querySelector('.to'), recipientRange = document.createRange(); recipientRange.selectNodeContents(recipient);
      const copy = header.cloneNode(true); copy.style.cssText += ';position:fixed;visibility:hidden;width:max-content'; header.parentElement.append(copy);
      const naturalBox = copy.getBoundingClientRect(), natural = naturalBox.width, line = naturalBox.height; copy.remove();
      return { header:rect(header), age:rect(age), ageText:age.textContent, ageWidth:age.clientWidth, ageScroll:age.scrollWidth,
        address:rect(address), addressText:address.textContent, addressInk:rect(range), line,
        recipient:rect(recipient), recipientInk:rect(recipientRange), recipientText:recipient.textContent, recipientStyle:{font:getComputedStyle(recipient).font,width:getComputedStyle(recipient).width,minWidth:getComputedStyle(recipient).minWidth,paddingRight:getComputedStyle(recipient).paddingRight,overflow:getComputedStyle(recipient).overflow,boxSizing:getComputedStyle(recipient).boxSizing}, spacing:getComputedStyle(header).letterSpacing, natural, kind:{ text:kind.textContent, width:kind.clientWidth, scroll:kind.scrollWidth, overflow:getComputedStyle(kind).textOverflow, title:kind.title, label:kind.getAttribute('aria-label') },
        page:[document.documentElement.clientWidth, document.documentElement.scrollWidth] };
    })())`));
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.spacing, '1px', 'the positive control widens the actual waiting header');
    assert.ok(result.natural > result.header.width, `the full header cannot fit without shortening text: ${JSON.stringify(result)}`);
    assert.ok(result.header.height <= result.line + 1, `the waiting ask stays on one line with wide fonts: ${JSON.stringify(result)}`);
    assert.equal(result.addressText, 'web-1', 'the sender address remains whole');
    assert.ok(result.addressInk.left >= result.address.left - 1 && result.addressInk.right <= result.address.right + 1, 'the complete address is drawn inside its element');
    assert.match(result.recipientText, /coordinator/u, 'the recipient address remains whole');
    assert.ok(result.recipientInk.left >= result.recipient.left - 1 && result.recipientInk.right <= result.recipient.right + 1 && result.recipient.right <= result.header.right + 1, 'the complete recipient address is drawn inside the header');
    assert.ok(result.age.top >= result.header.top - 1 && result.age.bottom <= result.header.bottom + 1 && result.age.right <= result.header.right + 1, 'the complete age stays on the same line inside the card');
    assert.equal(result.ageWidth, result.ageScroll, 'the age never clips');
    assert.ok(result.ageText.length > 0, 'the age remains visible');
    assert.ok(result.kind.width < result.kind.scroll, `the kind, rather than the address or age, shortens: ${JSON.stringify(result.kind)}`);
    assert.equal(result.kind.overflow, 'ellipsis', 'the shortened kind visibly ends with an ellipsis');
    assert.deepEqual([result.kind.title, result.kind.label], [result.kind.text, result.kind.text], 'the full kind remains in its title and accessible name');
    const accessibility = await chrome.send('Accessibility.getFullAXTree');
    assert.ok(accessibility.nodes.some(node => node.name?.value === result.kind.text && node.role?.value === 'group'), 'Chrome exposes the full shortened kind as an accessible name');
    assert.ok(result.page[1] <= result.page[0], 'the wider font never pushes the page sideways');
    assert.deepEqual(chrome.exceptions, [], 'the waiting ask raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

