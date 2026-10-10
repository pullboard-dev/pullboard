/** Cockpit shouts checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { register, shout as shoutOnBoard } from '../../src/board.js';
import { tapTarget, SPEC, machine, project, build, startView, styleOf, element, storage, openPage, boardId, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, earlier, shoutsAt, press, pressedInto } from './fixture.js';


test('the shouts tab counts shouts you have not seen [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'shout', 'web', 'first');
  box.run(alpha.repo, 'shout', 'web', 'second');
  const beta = project(box, 'beta');
  box.run(beta.repo, 'shout', 'web', 'beta has its own');
  const view = await startView(box);
  try {
    const store = storage();
    const count = (page) => { const unread = page.element('status-unread'); return unread.hidden ? '' : /<b>(\d+)<\/b> unread/.exec(unread.innerHTML)?.[1] ?? unread.innerHTML; };
    const page = await openPage(view, { store });
    assert.equal(count(page), '', 'the shouts there before the first look count as seen, not as 2');

    box.run(alpha.web, 'shout', 'coordinator', 'web-1 is on it');
    await page.run('refresh()');
    assert.equal(count(page), '1', 'a shout since then counts');
    await page.click({ tab: 'shouts' });
    assert.equal(count(page), '', 'opening Shouts sees it');
    box.run(alpha.web, 'shout', 'coordinator', 'and done');
    await page.run('refresh()');
    assert.equal(count(page), '', 'a shout that arrives while Shouts is open is seen');
    await page.click({ tab: 'items' });

    // A shout lands while the page is closed: the reload counts it, and only it.
    box.run(alpha.web, 'shout', 'coordinator', 'while you were away');
    const reloaded = await openPage(view, { store });
    assert.equal(count(reloaded), '1', 'what was seen is remembered across a reload');
    await reloaded.click({ tab: 'shouts' });
    assert.equal(count(reloaded), '');

    // A burst larger than the forty shouts the page loads still counts in full, after a reload too.
    await reloaded.click({ tab: 'items' });
    for (let n = 1; n <= 41; n += 1) box.run(alpha.web, 'shout', 'coordinator', `burst ${n}`);
    await reloaded.run('refresh()');
    assert.equal(count(reloaded), '41', 'every arrival counts, not just the forty loaded');
    const again = await openPage(view, { store });
    assert.equal(count(again), '41');

    // Each project keeps its own mark: a first look at beta sees its shouts, and alpha still counts.
    await again.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(count(again), '');
    await again.click({ root: alpha.repo, classes: 'proj side' });
    assert.equal(count(again), '41');

    // A switch to beta that is slow to arrive: tabs clicked meanwhile must not mark alpha's shouts as
    // beta's, or beta's next shout would never count.
    const racing = await openPage(view, { store });
    const betaId = await boardId(view, beta.repo);
    racing.run(`const plain = fetch; globalThis.fetch = (path, init) => path.includes(${JSON.stringify('/api/v1/boards/' + betaId + '/state')}) ? new Promise((done) => setTimeout(done, 300)).then(() => plain(path, init)) : plain(path, init);`);
    racing.run(`switchTo(${JSON.stringify(beta.repo)})`);
    await racing.click({ tab: 'shouts' });
    await racing.click({ tab: 'items' });
    await new Promise((done) => setTimeout(done, 600));
    await racing.run('refresh()');
    assert.equal(racing.element('proj-name').textContent, 'beta');
    box.run(beta.repo, 'shout', 'web', 'beta moves on');
    await racing.run('refresh()');
    assert.equal(count(racing), '1', 'the shout that came after counts');
  } finally {
    await view.stop();
  }
});

test('an empty feed says so on one line [N26]', async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.show('feed'), '<div class="empty">No shouts yet.</div>', 'one line, with no bar while the feed shows everything');
    assert.match(page.html, /<div class="card-panel shouts-card">[^]*<div class="feed" id="feed"><\/div><\/div>/, 'the shouts feed, in the Shouts card');
    assert.match(page.html, /<div class="card-panel feed" id="activity"><\/div>/, 'and the activity feed are both feeds');
    const style = await styleOf(view);
    assert.match(style, /\n\.feed > div \{ display: grid; grid-template-columns: 4\.6em minmax\(0, 1fr\);[^\n]*\n\.feed > \.empty \{ display: block; \}\n/, 'a feed row has a time column; its empty note takes the whole width');
  } finally {
    await view.stop();
  }
});
test('a shout shows the evidence it carries [B22]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  const head = box.git(alpha.web, 'rev-parse', 'HEAD');
  box.run(alpha.web, 'shout', 'all', 'the page loads in 80ms', '--evidence', 'receipt', '--outcome', 'measured <fast>', '--item', '1', '--commit', head.slice(0, 7));
  box.run(alpha.web, 'shout', 'all', 'tried a cache', '--evidence', 'attempt', '--outcome', 'failed', '--item', '1', '--commit', 'HEAD');
  box.run(alpha.web, 'shout', 'all', 'nothing to show');
  const view = await startView(box);
  try {
    const feed = (await openPage(view)).show('feed');
    const card = (kind, outcome) => `<div class="receipt"><div><span class="badge">${kind}</span> <span class="outcome">${outcome}</span></div><div class="receipt-foot"><button class="ref" data-go="item:1" title="Greeting" type="button">#1</button> · web-1 (Test Model) · <code class="inline sha" title="${head}">${head.slice(0, 10)}</code></div></div>`;
    const after = (text) => feed.slice(feed.indexOf(text + '</div>') + text.length + 6).replace(/^<button class="more" data-more type="button">more<\/button>/, '');
    assert.ok(after('the page loads in 80ms').startsWith(card('receipt', 'measured &lt;fast&gt;')), `what was measured, for which item, by whom, at which commit: ${after('the page loads in 80ms').slice(0, 400)}`);
    assert.ok(after('tried a cache').startsWith(card('attempt', 'failed')), 'and what was tried');
    assert.match(feed, /<span class="item">#1<\/span>/, 'the card names its item on top');
    assert.ok(feed.includes('nothing to show</div>'), 'a shout with no evidence has no card');
  } finally {
    await view.stop();
  }
});

test('a short code chip at a line end stays whole, and long code stays one chip inside the screen [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for code chip checks.');

  const box = machine();
  const demo = project(box, 'chip-ends');
  const long = 'docs/a/very/long/path/that/keeps/going/well/past/any/phone/screen/width.md';
  box.run(demo.repo, 'shout', 'all', `Pass the --flag option, then read ${long} before you submit.`);
  // Twenty-four wide characters are short by count but take two columns each: about 320px of one chip.
  const wide = '中文'.repeat(12);
  box.run(demo.repo, 'shout', 'all', 'Wide code `' + wide + '` wraps too.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-chip-end-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!document.querySelector(\'[data-tab="shouts"]\')');
    await chrome.evaluate('document.querySelector(\'[data-tab="shouts"]\').click()');
    await chrome.waitFor(`[...document.querySelectorAll('#feed code.inline')].some((code) => code.textContent === ${JSON.stringify(wide)})`);
    for (const width of [320, 375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const seen = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const chips = [...document.querySelectorAll('#feed code.inline')];
        const flag = chips.find((code) => code.textContent === '--flag'), path = chips.find((code) => code.textContent === ${JSON.stringify(long)});
        const text = flag.parentElement.closest('div');
        // Long code stays one chip, cut short with an ellipsis where the line is shorter, and inside the screen.
        const pathRects = [...path.getClientRects()];
        // Measured where the chips live: no shout's text runs wider than its column. (The page as a whole is
        // other lanes' layout; at 320 on Linux a 15px scrollbar leaves 305px for it.)
        const longCode = { fragments: pathRects.length, title: path.title, right: Math.max(...pathRects.map((r) => r.right)), screen: document.documentElement.clientWidth,
          overflow: [...document.querySelectorAll('#feed .shout .text')].some((column) => column.scrollWidth > column.clientWidth + 0.5) };
        const wideRects = [...chips.find((code) => code.textContent === ${JSON.stringify(wide)}).getClientRects()];
        const wideCode = { fragments: wideRects.length, right: Math.max(...wideRects.map((r) => r.right)), screen: document.documentElement.clientWidth };
        // Then end the chip's line three pixels inside the chip, whatever this machine's fonts measure.
        const start = text.getBoundingClientRect().left, end = flag.getBoundingClientRect().right, line = text.getBoundingClientRect().width;
        text.style.width = (end - start - 3) + 'px';
        const rects = [...flag.getClientRects()];
        const atEnd = { fragments: rects.length, display: getComputedStyle(flag).display, width: Math.max(...rects.map((r) => r.width)), line };
        text.style.width = '';
        return { atEnd, longCode, wideCode };
      })())`));
      assert.equal(seen.atEnd.fragments, 1, `${width}: a short chip at a line's end moves to the next line whole, never broken after its "--": ${JSON.stringify(seen)}`);
      assert.equal(seen.atEnd.display, 'inline', `${width}: and it is still inline code, not a bar`);
      assert.ok(seen.atEnd.width < seen.atEnd.line / 2, `${width}: and compact: ${JSON.stringify(seen.atEnd)}`);
      assert.deepEqual([seen.longCode.fragments, seen.longCode.title], [1, long], `${width}: code longer than its line stays one chip, the whole of it on hover: ${JSON.stringify(seen.longCode)}`);
      assert.equal(seen.wideCode.fragments, 1, `${width}: so does code of wide characters: ${JSON.stringify(seen.wideCode)}`);
      assert.ok(seen.wideCode.right <= seen.wideCode.screen + 0.5, `${width}: inside the screen, by the columns it takes: ${JSON.stringify(seen.wideCode)}`);
      assert.ok(seen.longCode.right <= seen.longCode.screen + 0.5 && !seen.longCode.overflow, `${width}: and never runs past the screen: ${JSON.stringify(seen.longCode)}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('real Chrome styles shout code and item text without growing linked lines [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'shout-code');
  const title = 'A `title` <img src=x onerror=alert(1)> #1';
  box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'Criterion `value` stays safe', '--brief', 'Run $ pullboard claim 1\nKeep `<safe>` literal.');
  box.run(alpha.web, 'claim', '1');
  const sourceHead = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const sample = 'Inline `code <b>safe</b>`; pullboard shout --decision; --flag; src/cockpit.js; 0123456789abcdef0123456789abcdef01234567.\nPreview SPEC.md:1-2@' + sourceHead + '. Invalid prefix:SPEC.md:1-2@' + sourceHead + '.\n```js\n<script>alert(1)</script>\n```\n$ pullboard claim 1\n<script>alert(1)</script>';
  const wrappedLinkedText = 'This deliberately long linked sample wraps across lines so text length does not define line height. '.repeat(3) + '#1';
  box.run(alpha.repo, 'shout', 'person', sample, '--decision');
  box.run(alpha.web, 'shout', 'coordinator', 'A linked line #1');
  box.run(alpha.web, 'shout', 'coordinator', 'A plain line here');
  box.run(alpha.web, 'shout', 'coordinator', 'X #1');
  box.run(alpha.web, 'shout', 'coordinator', 'X');
  box.run(alpha.web, 'shout', 'coordinator', wrappedLinkedText);
  box.run(alpha.web, 'shout', 'coordinator', 'OK');
  box.run(alpha.web, 'shout', 'coordinator', '<script>alert(2)</script> outside code');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shout-code-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    const consoleErrors = [];
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    });
    await chrome.send('Log.enable');
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 4 && document.querySelectorAll("#feed > .shout").length >= 4');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280 && document.querySelector("#detail .text.muted code.inline")?.getBoundingClientRect().width > 0');
    const desktopBrief = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const code=document.querySelector('#detail .text.muted code.inline'), line=code?.parentElement;
      const rect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return {display:code&&getComputedStyle(code).display,width:rect?.width,lineWidth:lineRect?.width};
    })())`));
    assert.equal(desktopBrief.display, 'inline', `1280px brief code computes inline: ${JSON.stringify(desktopBrief)}`);
    assert.ok(desktopBrief.width > 0 && desktopBrief.width < desktopBrief.lineWidth / 2, `1280px brief code is a compact chip: ${JSON.stringify(desktopBrief)}`);
    await chrome.evaluate("document.querySelector('#new-item').click()");
    await chrome.waitFor("!document.querySelector('#add-form').hidden && getComputedStyle(document.querySelector('#add-form')).display === 'grid'");
    const desktopForm = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const form=document.querySelector('#add-form'), box=form.getBoundingClientRect();
      const fields=[...form.querySelectorAll('label')].map(field=>{const r=field.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      return {display:getComputedStyle(form).display,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},fields,actions:getComputedStyle(form.querySelector('.actions')).display};
    })())`));
    assert.equal(desktopForm.display, 'grid', `1280px add-item form keeps its grid: ${JSON.stringify(desktopForm)}`);
    assert.equal(desktopForm.actions, 'flex', `1280px add-item actions keep their row: ${JSON.stringify(desktopForm)}`);
    assert.equal(desktopForm.fields.length, 5, '1280px add-item form keeps all five fields');
    assert.ok(desktopForm.fields.every((field, index, fields) => field.width > 0 && field.left >= desktopForm.box.left && field.right <= desktopForm.box.right && field.top >= desktopForm.box.top && field.bottom <= desktopForm.box.bottom && (index === 0 || field.top >= fields[index - 1].bottom)), `1280px add-item fields remain a non-overlapping grid: ${JSON.stringify(desktopForm)}`);
    await chrome.evaluate("document.querySelector('#add-cancel').click()");
    await chrome.waitFor("document.querySelector('#add-form').hidden");
    await chrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);

    const rendered = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const shout = [...document.querySelectorAll('#feed > .shout')].find((row) => row.textContent.includes('Inline'));
      const shoutCode=[...(shout?.querySelectorAll('code.inline')||[])].find(code=>code.textContent==='--flag'), shoutLine=shout?.querySelector('.text');
      const shoutRect=shoutCode?.getBoundingClientRect(), shoutLineRect=shoutLine?.getBoundingClientRect();
      const ask = [...document.querySelectorAll('#decisions .shout')].find((row) => row.textContent.includes('Inline'));
      const titleNode = document.querySelector('#chain .row .t');
      const outside = [...document.querySelectorAll('#feed > .shout')].find((row) => row.textContent.includes('alert(2)'));
      const itemDetail = document.querySelector('#detail');
      const agentItem = document.querySelector('#agents .agent-row');
      /** Measure the complete rendered content line box, including its item link. */
      const lineMetrics = (message) => {
        const row = [...document.querySelectorAll('#feed > .shout')].find((entry) => {
          const content = entry.querySelector('.text');
          return content && content.textContent.trim() === message;
        });
        const content = row.querySelector('.text');
        const height = content.getBoundingClientRect().height;
        const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
        return { height, lineHeight, lines: Math.round(height / lineHeight) };
      };
      return {
        shoutHtml: shout.innerHTML, shoutScripts: shout.querySelectorAll('script').length,
        shoutCodeMetrics: {display:shoutCode&&getComputedStyle(shoutCode).display,width:shoutRect?.width,lineWidth:shoutLineRect?.width},
        askHtml: ask.innerHTML, titleHtml: titleNode.innerHTML,
        linkedMetrics: lineMetrics('X #1'), plainMetrics: lineMetrics('X'),
        wrapLinked: lineMetrics(${JSON.stringify(wrappedLinkedText)}), wrapPlain: lineMetrics('OK'),
        linkedButtons: [...document.querySelectorAll('#feed > .shout')].find((entry) => entry.textContent.includes('A linked line'))?.querySelectorAll('button.ref').length,
        previewLinks: shout.querySelectorAll('button[data-code^="SPEC.md:1-2@"]').length,
        outsideHtml: outside.innerHTML, askNestedButtons: [...ask.querySelectorAll('button')].filter(link => link.parentElement.closest('button')).length,
        criterionHtml: itemDetail.querySelector('.text')?.innerHTML, briefHtml: itemDetail.querySelector('.text.muted')?.innerHTML,
        needsNestedButtons: [...document.querySelectorAll('#needs button.ref')].filter(link => link.parentElement.closest('button')).length,
        agentNestedButtons: [...document.querySelectorAll('#agents button.ref')].filter(link => link.parentElement.closest('button')).length,
        agentItemHeight: agentItem?.getBoundingClientRect().height,
      };
    })())`));
    assert.equal(rendered.shoutCodeMetrics.display, 'inline', `1280px shout code computes inline: ${JSON.stringify(rendered.shoutCodeMetrics)}`);
    assert.ok(rendered.shoutCodeMetrics.width > 0 && rendered.shoutCodeMetrics.width < rendered.shoutCodeMetrics.lineWidth / 2,
      `1280px shout code is a compact chip: ${JSON.stringify(rendered.shoutCodeMetrics)}`);
    assert.match(rendered.shoutHtml, /<code class="inline">code &lt;b&gt;safe&lt;\/b&gt;<\/code>/, 'backticks create escaped inline code');
    assert.match(rendered.shoutHtml, /<code class="inline cmd(?: long" title="pullboard shout --decision)?">pullboard shout --decision<\/code>/, 'a pullboard command is inline code, with the flags that follow it');
    assert.match(rendered.shoutHtml, /<code class="inline cmd">--flag<\/code>/, 'a flag on its own is a command chip');
    assert.match(rendered.shoutHtml, /<code class="inline path">src\/cockpit\.js<\/code>/, 'slash paths are path chips');
    assert.match(rendered.shoutHtml, /<code class="inline sha" title="0123456789abcdef0123456789abcdef01234567">0123456789<\/code>/, 'a hex SHA is a ten-character chip with the whole SHA on hover');
    assert.ok((rendered.shoutHtml.match(/<code class="code block">/g) ?? []).length >= 2, 'fences and dollar-prefixed lines are code blocks');
    assert.match(rendered.shoutHtml, /<code class="code block">\$ pullboard claim 1<\/code>/, 'the shell prompt stays visible in command blocks');
    assert.match(rendered.shoutHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'script text is escaped inside code');
    assert.equal(rendered.shoutScripts, 0, 'a shout cannot create a script element');
    assert.match(rendered.outsideHtml, /&lt;script&gt;alert\(2\)&lt;\/script&gt; outside code/, 'script text outside code is escaped too');
    assert.equal(rendered.previewLinks, 1, 'only a path:lines@SHA reference with the original whole-word boundaries becomes an actionable preview');
    assert.match(rendered.shoutHtml, /Invalid prefix:<code class="inline long" title="SPEC\.md:1-2@[0-9a-f]+">SPEC\.md:1-2@/, 'a path:lines@SHA suffix after a colon stays plain inline code');
    await chrome.evaluate(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"]').click()`);
    await chrome.waitFor(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"]').getAttribute('aria-expanded') === 'true'`);
    await chrome.waitFor(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"] + .code-ref .code-wrap > .code')?.textContent.includes('Demo spec')`);
    assert.match(await chrome.evaluate(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"] + .code-ref .code-wrap > .code')?.textContent || ''`), /Demo spec/, 'the original code preview still opens its referenced lines');
    assert.match(rendered.askHtml, /<code class="inline cmd(?: long" title="pullboard shout --decision)?">pullboard shout --decision<\/code>/, 'needs-you uses the same code renderer');
    assert.equal(rendered.askNestedButtons, 0, 'formatted text in an ask cannot nest interactive controls');
    assert.equal(rendered.needsNestedButtons, 0, 'needs-you keeps its button markup valid');
    assert.equal(rendered.agentNestedButtons, 0, 'agent item buttons never nest reference controls');
    assert.ok(rendered.agentItemHeight >= 44, 'agent item controls keep a 44px touch target');
    assert.match(rendered.titleHtml, /<code class="inline">title<\/code>/, 'item titles use the same code renderer');
    assert.match(rendered.titleHtml, /&lt;img src=x onerror=alert\(1\)&gt;/, 'item text remains escaped');
    assert.match(rendered.criterionHtml, /<code class="inline">value<\/code>/, 'criterion text uses the renderer');
    assert.match(rendered.briefHtml, /<code class="inline">&lt;safe&gt;<\/code>/, 'brief text uses the renderer without interpreting markup');
    assert.equal(rendered.linkedButtons, 1, 'the compared row contains a rendered item link');
    assert.equal(rendered.linkedMetrics.lines, 1, 'the short linked sample occupies one desktop line');
    assert.equal(rendered.plainMetrics.lines, 1, 'the short plain sample occupies one desktop line');
    assert.ok(Math.abs(rendered.linkedMetrics.height - rendered.plainMetrics.height) < 1, 'the complete one-line desktop boxes match within 1px');
    assert.ok(Math.abs(rendered.linkedMetrics.height - rendered.linkedMetrics.lineHeight) < 1, 'the linked desktop box equals one computed line-height');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375 && document.querySelector("#feed > .shout")?.getBoundingClientRect().width > 0');
    await chrome.evaluate("document.querySelector('[data-tab=items]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=items]:not([hidden])") && document.querySelector("#detail .text.muted code.inline")?.getBoundingClientRect().width > 0');
    const phoneBrief = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const code=document.querySelector('#detail .text.muted code.inline'), line=code?.parentElement;
      const rect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return {display:code&&getComputedStyle(code).display,width:rect?.width,lineWidth:lineRect?.width};
    })())`));
    assert.equal(phoneBrief.display, 'inline', `375px brief code computes inline: ${JSON.stringify(phoneBrief)}`);
    assert.ok(phoneBrief.width > 0 && phoneBrief.width < phoneBrief.lineWidth / 2, `375px brief code is a compact chip: ${JSON.stringify(phoneBrief)}`);
    await chrome.evaluate("document.querySelector('#new-item').click()");
    await chrome.waitFor("!document.querySelector('#add-form').hidden && getComputedStyle(document.querySelector('#add-form')).display === 'grid'");
    const phoneForm = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const form=document.querySelector('#add-form'), box=form.getBoundingClientRect();
      const fields=[...form.querySelectorAll('label')].map(field=>{const r=field.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      return {display:getComputedStyle(form).display,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},fields,actions:getComputedStyle(form.querySelector('.actions')).display};
    })())`));
    assert.equal(phoneForm.display, 'grid', `375px add-item form keeps its grid: ${JSON.stringify(phoneForm)}`);
    assert.equal(phoneForm.actions, 'flex', `375px add-item actions keep their row: ${JSON.stringify(phoneForm)}`);
    assert.equal(phoneForm.fields.length, 5, '375px add-item form keeps all five fields');
    assert.ok(phoneForm.fields.every((field, index, fields) => field.width > 0 && field.left >= phoneForm.box.left && field.right <= phoneForm.box.right && field.top >= phoneForm.box.top && field.bottom <= phoneForm.box.bottom && (index === 0 || field.top >= fields[index - 1].bottom)), `375px add-item fields remain a non-overlapping grid: ${JSON.stringify(phoneForm)}`);
    await chrome.evaluate("document.querySelector('#add-cancel').click()");
    await chrome.waitFor("document.querySelector('#add-form').hidden");
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden])") && document.querySelector("#feed code.inline")?.getBoundingClientRect().width > 0');
    const phoneMetrics = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      /** Measure the complete rendered content line box, including its item link. */
      const lineMetrics = (message) => {
        const row = [...document.querySelectorAll('#feed > .shout')].find((entry) => {
          const content = entry.querySelector('.text');
          return content && content.textContent.trim() === message;
        });
        const content = row.querySelector('.text');
        const height = content.getBoundingClientRect().height;
        const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
        return { height, lineHeight, lines: Math.round(height / lineHeight) };
      };
      const row=[...document.querySelectorAll('#feed > .shout')].find(entry=>entry.textContent.includes('Inline'));
      const code=[...(row?.querySelectorAll('code.inline')||[])].find(entry=>entry.textContent==='--flag'), line=row?.querySelector('.text'), codeRect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return { linked: lineMetrics('X #1'), plain: lineMetrics('X'), wrapLinked: lineMetrics(${JSON.stringify(wrappedLinkedText)}), wrapPlain: lineMetrics('OK'), shoutCode:{display:code&&getComputedStyle(code).display,width:codeRect?.width,lineWidth:lineRect?.width} };
    })())`));
    assert.equal(phoneMetrics.shoutCode.display, 'inline', `375px shout code computes inline: ${JSON.stringify(phoneMetrics.shoutCode)}`);
    assert.ok(phoneMetrics.shoutCode.width > 0 && phoneMetrics.shoutCode.width < phoneMetrics.shoutCode.lineWidth / 2,
      `375px shout code is a compact chip: ${JSON.stringify(phoneMetrics.shoutCode)}`);
    assert.equal(phoneMetrics.linked.lines, 1, 'the short linked sample occupies one phone line');
    assert.equal(phoneMetrics.plain.lines, 1, 'the short plain sample occupies one phone line');
    assert.ok(Math.abs(phoneMetrics.linked.height - phoneMetrics.plain.height) < 1, 'the complete one-line phone boxes match within 1px');
    assert.ok(Math.abs(phoneMetrics.linked.height - phoneMetrics.linked.lineHeight) < 1, 'the linked phone box equals one computed line-height');
    assert.ok(phoneMetrics.wrapLinked.lines > 1, 'the long linked probe actually wraps at 375px');
    assert.equal(phoneMetrics.wrapPlain.lines, 1, 'the short plain wrap probe remains on one line');
    assert.ok(Math.abs(phoneMetrics.wrapLinked.height / phoneMetrics.wrapLinked.lines - phoneMetrics.wrapPlain.lineHeight) < 1,
      'normalizing the forced wrap by its rendered line count proves the same per-line height');
    assert.ok(Math.abs(phoneMetrics.wrapLinked.height - phoneMetrics.wrapPlain.height) >= 1,
      'the old whole-text-box comparison would fail on the deliberately wrapped sample');
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception on its first load');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('shouts read as cards [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'cards');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G1', '--criterion', 'says goodbye');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'cards-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/cards2');
  box.run(second, 'join', 'web');
  // A committed page at a path too long for a phone, for a code reference to name.
  const deep = 'docs/a/very/long/path/that/keeps/going/past/a/phone/screen.md';
  mkdirSync(join(alpha.repo, deep, '..'), { recursive: true });
  writeFileSync(join(alpha.repo, deep), 'Deep line one\n');
  box.git(alpha.repo, 'add', deep);
  box.git(alpha.repo, 'commit', '-q', '-m', 'docs: a deep page');
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const lines = (first, n) => [first, ...Array.from({ length: n - 1 }, (_, k) => `Line ${k + 2} of the note.`)].join('\n');
  const older = 'Started on #1 two days back.';
  const colour = lines('Which colour for the button? #99 is no item.', 8);
  const ship = 'Ship #1 today?';
  const chips = `See #1 in src/cockpit.js at ${sha}; run pullboard check --json, then \`npm test\`.`;
  const long = lines('A long note that folds.', 12);
  const mixed = 'Moved #2 along.';
  const longCommand = 'node bin/run-tests.js test/relay-person-requests.test.js', longPath = 'test/relay-person-requests.test.js';
  const longerPath = 'docs/a/very/long/path/that/keeps/going/well/past/any/phone/screen/width.md';
  const longChips = `Ran \`${longCommand}\` on ${longPath} and ${longerPath} today.`;
  const sourceRefs = [`SPEC.md:1-2@${head}`, `${deep}:1@${head}`];
  const refsShout = `Check ${sourceRefs[0]} and ${sourceRefs[1]} before you merge.`;
  const blockShout = `Evidence for the page:\n${sourceRefs[0]}`;
  const twoDays = new Date(); twoDays.setDate(twoDays.getDate() - 2); twoDays.setHours(12, 0, 0, 0);
  earlier(alpha.repo, twoDays, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: older, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 65 * 60e3, (board) => shoutOnBoard(board, { from: 'web-2', to: 'coordinator', text: colour, decision: true, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 125e3, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: ship, decision: true, lanes: ['web'] }));
  const asked = JSON.parse(box.run(alpha.repo, 'decisions', '--json')).decisions.find((d) => d.shout_text === ship);
  box.run(alpha.repo, 'answer', String(asked.shout_id), 'Yes, ship it.');
  box.run(alpha.web, 'shout', 'all', 'the page loads in 80ms', '--evidence', 'receipt', '--outcome', 'measured 80ms', '--item', '1', '--commit', head);
  box.run(alpha.web, 'shout', 'all', chips);
  box.run(alpha.web, 'shout', 'all', mixed, '--evidence', 'receipt', '--outcome', 'moved', '--item', '1', '--commit', head);
  box.run(alpha.web, 'shout', 'all', longChips);
  box.run(alpha.web, 'shout', 'all', refsShout);
  box.run(alpha.web, 'shout', 'all', blockShout);
  box.run(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  box.run(alpha.web, 'shout', 'all', long);

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-cards-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 12');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    await chrome.evaluate("(() => { const fold = document.querySelector('.asks-toggle[data-fold=\"waiting\"]'); if (fold && fold.getAttribute('aria-expanded') !== 'true') fold.click(); })()");
    const ids = JSON.parse(await chrome.evaluate('JSON.stringify(Object.fromEntries(data.project.shouts.map((s) => [s.shout_text, s.shout_id])))'));
    const answerId = await chrome.evaluate(`data.project.shouts.find((s) => s.shout_answers === ${asked.shout_id}).shout_id`);
    const stamps = JSON.parse(await chrome.evaluate('JSON.stringify(data.project.shouts.map((s) => [s.shout_id, s.shout_at]))'));

    /** Everything a card shows, measured where it stands. */
    const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const style = (e) => getComputedStyle(e);
      const card = (place, id) => {
        const e = document.querySelector(place + ' #shout-' + id) ?? [...document.querySelectorAll(place + ' .shout')].find((c) => c.dataset.shoutId === String(id));
        if (!e) return null;
        const avatar = e.querySelector('.avatar'), who = e.querySelector('.who'), time = e.querySelector('header time'), text = e.querySelector('.text');
        const edges = [e, ...e.querySelectorAll('.receipt, .band')].map((part) => { const s = style(part); return { left: [s.borderLeftWidth, s.borderLeftColor], right: [s.borderRightWidth, s.borderRightColor] }; });
        return {
          classes: e.className, avatar: { text: avatar.textContent, svg: !!avatar.querySelector('svg'), radius: style(avatar).borderTopLeftRadius, color: style(avatar).color, background: style(avatar).backgroundColor, box: box(avatar) },
          who: { text: who.textContent, color: style(who).color }, to: e.querySelector('.to')?.textContent, item: e.querySelector('header .item')?.textContent ?? null,
          item_color: e.querySelector('header .item') && style(e.querySelector('header .item')).color, ink: style(text).color,
          time: { text: time.textContent, title: time.title, box: box(time) }, header: box(e.querySelector('header')), text: { box: box(text), lines: Math.round(text.clientHeight / parseFloat(style(text).lineHeight)), clamped: text.scrollHeight > text.clientHeight + 1 },
          more: (() => { const m = e.querySelector('.more'); return m && style(m).display !== 'none' ? m.textContent : null; })(),
          band: e.querySelector('.band') ? { text: e.querySelector('.band').textContent, done: e.querySelector('.band').classList.contains('done'), href: e.querySelector('.band a')?.getAttribute('href') ?? null } : null,
          receipt: e.querySelector('.receipt') ? { badge: e.querySelector('.receipt .badge').textContent, outcome: e.querySelector('.receipt .outcome').textContent, foot: e.querySelector('.receipt-foot').textContent,
            sha: e.querySelector('.receipt-foot code.sha')?.textContent, shaTitle: e.querySelector('.receipt-foot code.sha')?.title } : null,
          answer: e.querySelector('.answer')?.textContent ?? null, edges,
        };
      };
      const chip = (selector) => { const e = document.querySelector('#feed #shout-${ids[chips]} .text ' + selector); return e && { text: e.textContent, title: e.title, display: style(e).display, rects: e.getClientRects().length, color: style(e).color, background: style(e).backgroundColor }; };
      const feed = document.querySelector('#feed'), rule = feed.querySelector('.day-rule'), label = rule?.querySelector('span');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        feedKinds: [...feed.children].map((e) => e.classList.contains('day-rule') ? 'rule:' + e.textContent : e.classList.contains('shout') ? 'shout:' + e.dataset.shoutId : e.className),
        rule: rule && { box: box(rule), label: box(label) },
        heads: [...document.querySelectorAll('#decisions .head')].map((h) => h.textContent),
        decisions: [...document.querySelectorAll('#decisions .shout')].map((e) => e.dataset.shoutId),
        feed: { older: card('#feed', ${ids[older]}), colour: card('#feed', ${ids[colour]}), ship: card('#feed', ${ids[ship]}), chips: card('#feed', ${ids[chips]}), long: card('#feed', ${ids[long]}),
          receipt: card('#feed', ${ids['the page loads in 80ms']}), answer: card('#feed', ${answerId}), friday: card('#feed', ${ids['Launch on Friday?']}), mixed: card('#feed', ${ids[mixed]}) },
        longs: [...document.querySelectorAll('#feed #shout-${ids[longChips]} .text code.inline')].map((e) => {
          const c = e.getBoundingClientRect(), t = e.closest('.text').getBoundingClientRect();
          return { text: e.textContent, title: e.title, rects: e.getClientRects().length, inside: c.left >= t.left - 0.5 && c.right <= t.right + 0.5, cut: e.scrollWidth > e.clientWidth + 1, ends: getComputedStyle(e).textOverflow };
        }),
        block: (() => {
          const b = document.querySelector('#feed #shout-${ids[blockShout]} .text .code-ref > button.ref.block');
          if (!b) return null;
          const c = b.getBoundingClientRect(), t = b.closest('.text').getBoundingClientRect(), edge = getComputedStyle(b.parentElement);
          return { label: b.textContent, height: c.height, full: Math.abs(c.width - t.width) < 3, caret: (() => { const k = getComputedStyle(b, '::before'); return k.content === 'none' || k.content === 'normal' || !(parseFloat(k.width) > 0) ? 'none' : k.clipPath.startsWith('polygon') ? 'drawn' : 'unshaped'; })(),
            edges: [edge.borderLeftWidth, edge.borderLeftColor].join() === [edge.borderRightWidth, edge.borderRightColor].join() };
        })(),
        refs: [...document.querySelectorAll('#feed #shout-${ids[refsShout]} .text button[data-code]')].map((e) => {
          const c = e.getBoundingClientRect(), t = e.closest('.text').getBoundingClientRect(), path = e.querySelector('.ref-path'), tail = e.querySelector('.ref-at').getBoundingClientRect();
          return { text: e.textContent, title: e.title, code: e.dataset.code, rects: e.getClientRects().length, inside: c.left >= t.left - 0.5 && c.right <= t.right + 0.5,
            tail: tail.width > 0 && tail.left >= c.left - 0.5 && tail.right <= c.right + 0.5, cut: path.scrollWidth > path.clientWidth + 1, ends: getComputedStyle(path).textOverflow };
        }),
        asks: { friday: card('#decisions', ${ids['Launch on Friday?']}), colour: card('#decisions', ${ids[colour]}) },
        answerTarget: !!document.getElementById('shout-${answerId}'),
        repeated: [...document.querySelectorAll('[id]')].map((e) => e.id).filter((id, n, all) => all.indexOf(id) !== n),
        chips: { ref: chip('button.ref'), path: chip('code.path'), sha: chip('code.sha'), cmd: chip('code.cmd'), code: chip('code.inline:not(.path):not(.sha):not(.cmd)') },
      };
    })())`));

    const seen = {};
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll: ${JSON.stringify(r.page)}`);
        const { older: old, colour: asking, ship: shipped, chips: chipCard, long: folded, receipt, answer, friday, mixed: both } = r.feed;

        // A card: avatar, name in its colour, arrow and recipient, item, and the age at the top right over the text.
        for (const [name, c] of Object.entries(r.feed)) {
          assert.ok(c, `${at}: the ${name} shout is a card`);
          assert.equal(c.classes.includes('lead') ? c.avatar.background : c.avatar.color, c.who.color, `${at}: ${name}: the name is in its avatar's colour`);
          assert.ok(Math.abs(c.time.box.right - c.header.right) <= 1 && c.time.box.top < c.text.box.top, `${at}: ${name}: the age sits at the top right: ${JSON.stringify([c.time, c.header])}`);
          assert.ok(c.text.box.top >= c.header.bottom - 1, `${at}: ${name}: the text sits below the header`);
          for (const edge of c.edges) assert.deepEqual(edge.left, edge.right, `${at}: ${name}: no box in the card carries a coloured edge`);
        }
        assert.deepEqual([old.avatar.text, old.who.text, old.to], ['W1', 'web-1 (Test Model)', '→ coordinator (unknown)'], `${at}: initials, name, arrow and recipient`);
        assert.equal(old.avatar.radius, '50%', `${at}: an agent's avatar is a circle`);
        assert.equal(chipCard.avatar.color, old.avatar.color, `${at}: one agent keeps one colour`);
        assert.notEqual(asking.avatar.color, old.avatar.color, `${at}: another agent has its own`);
        assert.ok(answer.avatar.svg && answer.avatar.radius !== '50%' && Math.abs(answer.avatar.box.width - answer.avatar.box.height) < 1 && answer.classes.includes('lead'),
          `${at}: the coordinator's avatar is a square with the Pullboard mark: ${JSON.stringify(answer.avatar)}`);
        assert.deepEqual([old.item, chipCard.item, receipt.item, asking.item, both.item], ['#1', '#1', '#1', null, '#2'], `${at}: the item is the first #N that names one, or else the evidence's`);
        assert.notEqual(old.item_color, old.who.color, `${at}: the item is muted, not the agent's colour`);
        assert.deepEqual([folded.time.text, shipped.time.text, asking.time.text], ['now', '2m ago', '1h ago'], `${at}: ages read now, 2m ago, 1h ago`);
        assert.ok(/\d\d:\d\d$/.test(shipped.time.title) && /^\S+ \d+ \d\d:\d\d$/.test(old.time.title), `${at}: the clock time is on hover, with the date when it was another day`);

        // Chips: inline, whole, ref, path and hash each in a colour of their own; a sha shows ten characters.
        for (const [kind, c] of Object.entries(r.chips)) {
          assert.ok(c, `${at}: the ${kind} chip renders`);
          assert.match(c.display, /^inline/, `${at}: the ${kind} chip stays inline`);
          assert.equal(c.rects, 1, `${at}: the ${kind} chip never breaks across lines`);
        }
        assert.equal(new Set([r.chips.ref.color, r.chips.path.color, r.chips.sha.color]).size, 3, `${at}: item refs, paths and hashes each have a colour: ${JSON.stringify(r.chips)}`);
        assert.deepEqual([r.chips.sha.text, r.chips.sha.title], [sha.slice(0, 10), sha], `${at}: a full sha shows its first ten characters, the whole on hover`);
        assert.deepEqual([r.chips.ref.text, r.chips.path.text, r.chips.cmd.text, r.chips.code.text], ['#1', 'src/cockpit.js', 'pullboard check --json', 'npm test']);
        // Long chips too: each one piece inside the text, the whole of it on hover; one longer than the line is cut short.
        assert.deepEqual(r.longs.map((c) => [c.text, c.title, c.rects, c.inside]), [longCommand, longPath, longerPath].map((text) => [text, text, 1, true]),
          `${at}: a long command, path and code stay one chip each: ${JSON.stringify(r.longs)}`);
        if (width === 375) assert.ok(r.longs[2].cut && r.longs[2].ends === 'ellipsis', `${at}: a chip longer than its line is cut short with an ellipsis: ${JSON.stringify(r.longs)}`);
        // A code reference reads path:lines@ten characters as one piece, the whole reference on hover and in its action.
        assert.deepEqual(r.refs.map((c) => [c.text, c.title, c.code, c.rects, c.inside, c.tail]), sourceRefs.map((ref) => [ref.replace(head, head.slice(0, 10)), ref, ref, 1, true, true]),
          `${at}: each code reference is one piece with its lines and short commit in view: ${JSON.stringify(r.refs)}`);
        if (width === 375) assert.ok(r.refs[1].cut && r.refs[1].ends === 'ellipsis', `${at}: a path too long for the line is cut short first: ${JSON.stringify(r.refs)}`);
        // A reference on a line of its own is a block, collapsed: a caret header the width of the text, no coloured edge.
        assert.deepEqual(r.block && [r.block.label, r.block.height >= tapTarget(width), r.block.full, r.block.caret, r.block.edges], [sourceRefs[0].replace(head, head.slice(0, 10)), true, true, 'drawn', true],
          `${at}: a whole-line reference is a collapsed block: ${JSON.stringify(r.block)}`);

        // Decisions: a band until answered, then who answered and a link to the answer.
        assert.deepEqual(asking.band, { text: 'Decision needed', done: false, href: null }, `${at}: an open ask carries a Decision needed band`);
        assert.deepEqual(shipped.band, { text: 'Answered by coordinator (unknown): see the answer', done: true, href: `#shout-${answerId}` }, `${at}: an answered one says who answered, linking the answer`);
        assert.ok(r.answerTarget, `${at}: the link lands on the answer`);
        assert.deepEqual(r.repeated, [], `${at}: an ask shown in the feed and above the composer never repeats an id`);

        // Evidence: a receipt with kind, outcome and a footer of item, agent and short sha.
        assert.deepEqual([receipt.receipt.badge, receipt.receipt.outcome], ['receipt', 'measured 80ms']);
        assert.ok(receipt.receipt.foot.startsWith('#1 · web-1 (Test Model) · ') && receipt.receipt.sha === head.slice(0, 10) && receipt.receipt.shaTitle === head, `${at}: the receipt's footer: ${JSON.stringify(receipt.receipt)}`);

        // A long shout folds at six lines; the asks above the composer are the same cards, folded at three.
        assert.deepEqual([folded.text.lines, folded.text.clamped, folded.more], [6, true, 'more'], `${at}: a long shout folds at six lines with more`);
        assert.equal(old.more, null, `${at}: a short shout has no more`);
        assert.deepEqual(r.heads, ['Decision needed'], `${at}: the asks above the composer: the person's under their head, the rest opened from their fold line`);
        assert.deepEqual([r.asks.friday.answer, r.asks.colour.answer], ['Answer', null], `${at}: the person's ask has an Answer button; one waiting on others has none`);
        assert.deepEqual([r.asks.colour.text.lines, r.asks.colour.text.clamped, r.asks.colour.more], [3, true, 'more'], `${at}: an ask folds at three lines`);
        assert.ok(r.asks.friday.avatar.svg && r.asks.friday.who.text === 'coordinator (unknown)', `${at}: the asks are the feed's cards`);

        // Days: none above today's shouts; a rule in the middle names the earlier day where the feed crosses into it.
        let day = new Date().toDateString();
        const expected = [...stamps.flatMap(([id, iso]) => { const was = day; day = new Date(iso).toDateString(); return day === was ? [`shout:${id}`] : ['rule', `shout:${id}`]; })];
        assert.deepEqual(r.feedKinds.map((k) => k.startsWith('rule:') ? 'rule' : k), expected, `${at}: a rule only where the day changes, none above today's: ${r.feedKinds}`);
        assert.ok(r.feedKinds[r.feedKinds.indexOf(`shout:${ids[older]}`) - 1].startsWith('rule:') && !r.feedKinds.some((k) => k === 'rule:Today'), `${at}: the earlier day is named above its first shout`);
        assert.ok(Math.abs((r.rule.label.left + r.rule.label.right) / 2 - (r.rule.box.left + r.rule.box.right) / 2) < 2, `${at}: the day sits in the middle of its rule`);
        seen[at] = { ink: old.ink, who: old.who.color };
      }
    }
    assert.notDeepEqual(seen['1280px light'], seen['1280px dark'], 'dark mode changes the cards');

    // Folding: more opens the whole shout, less closes it, and an open shout stays open across a refresh.
    await shoutsAt(chrome, 1280, 'light');
    const foldOf = () => chrome.evaluate(`JSON.stringify((() => { const c = document.querySelector('#feed #shout-${ids[long]}'), t = c.querySelector('.text'); return [c.querySelector('.more').textContent, Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight))]; })())`).then(JSON.parse);
    await chrome.evaluate(`document.querySelector('#feed #shout-${ids[long]} .more').click()`);
    assert.deepEqual(await foldOf(), ['less', 12], 'more shows every line');
    box.run(alpha.web, 'shout', 'all', 'A later shout.');
    await chrome.waitFor(`data.project.shouts.some((s) => s.shout_text === 'A later shout.') && document.querySelector('#feed .shout .text')?.textContent === 'A later shout.'`, 15_000);
    assert.deepEqual(await foldOf(), ['less', 12], 'an open shout stays open across a refresh');
    await chrome.evaluate(`document.querySelector('#feed #shout-${ids[long]} .more').click()`);
    assert.deepEqual(await foldOf(), ['more', 6], 'less folds it again');

    // The block opens on its header to the lines it names, in its own frame.
    const blockRef = `document.querySelector('#feed #shout-${ids[blockShout]} .code-ref > button.ref.block')`;
    await chrome.evaluate(`${blockRef}.click()`);
    await chrome.waitFor(`${blockRef}.parentElement.classList.contains('open') && ${blockRef}.getAttribute('aria-expanded') === 'true' && ${blockRef}.parentElement.querySelector('.code-wrap .code')?.textContent.includes('Demo spec')`, 15_000);

    // The short label still opens the code it names, at that commit.
    const deepRef = `[...document.querySelectorAll('#feed #shout-${ids[refsShout]} button[data-code]')][1]`;
    await chrome.evaluate(`${deepRef}.click()`);
    await chrome.waitFor(`${deepRef}.getAttribute('aria-expanded') === 'true' && ${deepRef}.nextElementSibling?.textContent.includes('Deep line one')`, 15_000);
    // An inline reference keeps its label in the sentence and opens the same block a reference on its own line is.
    const opened = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const inline = ${deepRef}, block = inline.nextElementSibling, header = block?.querySelector(':scope > button.ref.block');
      const standalone = document.querySelector('#feed #shout-${ids[blockShout]} .code-ref.open');
      return { label: !inline.classList.contains('block') && inline.textContent, next: block?.className, header: header && [header.dataset.code, header.textContent, header.getAttribute('aria-expanded')],
        lines: block?.querySelector(':scope > .code-wrap .code')?.textContent.includes('Deep line one'),
        shape: block && [...block.children].map((e) => e.className), standalone: standalone && [...standalone.children].map((e) => e.className) };
    })())`));
    assert.deepEqual([opened.next, opened.header, opened.lines], ['code-ref open', [sourceRefs[1], opened.label, 'true'], true],
      `an inline reference opens the collapsed block with its own header, under its label: ${JSON.stringify(opened)}`);
    assert.deepEqual(opened.shape, opened.standalone, 'the same block a reference on its own line opens to');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the shout composer, agent filter and agents panel [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'composer');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1');
  const idle = join(box.dir, 'composer-web-2'), fresh = join(box.dir, 'composer-web-3');
  box.git(alpha.repo, 'worktree', 'add', '-q', idle, '-b', 'web/composer2');
  // web-2 joined and spoke three hours ago, and has not moved since.
  earlier(alpha.repo, Date.now() - 3 * 36e5, (board) => {
    assert.equal(register(board, { lane: 'web', path: idle }), 'web-2');
    shoutOnBoard(board, { from: 'web-2', to: 'coordinator', text: 'An idle agent spoke this morning.', lanes: ['web'] });
  });
  box.run(alpha.repo, 'shout', 'web-2', 'The coordinator wrote to the idle agent.');
  box.git(alpha.repo, 'worktree', 'add', '-q', fresh, '-b', 'web/composer3');
  box.run(fresh, 'join', 'web');
  box.run(fresh, 'shout', 'all', 'A fresh agent says hello.');
  box.run(alpha.web, 'shout', 'all', 'The claim holder reports in.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-composer-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 4');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    await chrome.evaluate("(() => { const fold = document.querySelector('.fold-line[data-fold=\"idle\"]'); if (fold && fold.getAttribute('aria-expanded') !== 'true') fold.click(); })()");
    const agents = JSON.parse(await chrome.evaluate('JSON.stringify(data.project.agents.map((a) => [a.agent_id, a.agent_path]))'));
    assert.deepEqual(agents.filter(([, path]) => [alpha.web, idle, fresh].includes(path)).map(([id]) => id).sort(), ['web-1', 'web-2', 'web-3'], 'three agents joined the web lane');
    const total = await chrome.evaluate('data.project.shouts.length');
    const state = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
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
    const click = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
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
    assert.deepEqual(s.cards, [['coordinator (unknown)', 'web-2 (unknown)'], ['web-2 (unknown)', 'coordinator (unknown)']], 'only shouts from or to web-2');
    assert.deepEqual([s.bar, s.to, s.on], ['Shouts with web-2 (unknown) show all', 'web-2', ['web-2']], 'the bar says whose, the composer is addressed to them, and the agent is marked');
    await click('#feed .feed-bar [data-agent=""]');
    s = await state();
    assert.deepEqual([s.cards.length, s.bar, s.on, s.to], [total, '', [], 'coordinator'], 'show all undoes the filter, and the composer goes back to the coordinator');
    await click('#agents .all-agents');

    // The message grows as it is typed; Shift+Enter starts a line, Enter sends.
    await chrome.evaluate("document.querySelector('#shout-text').focus()");
    const height = () => chrome.evaluate("document.querySelector('#shout-text').getBoundingClientRect().height");
    const one = await height();
    await chrome.send('Input.insertText', { text: 'First line' });
    await key(8);
    await chrome.send('Input.insertText', { text: 'second line' });
    await key(8);
    await chrome.send('Input.insertText', { text: 'third line' });
    assert.equal(await chrome.evaluate("document.querySelector('#shout-text').value"), 'First line\nsecond line\nthird line', 'Shift+Enter starts a new line');
    assert.ok(await height() > one + 20, 'the message grows as it is typed');
    assert.equal(await chrome.evaluate('data.project.shouts.length'), total, 'and sends nothing');
    await key(0);
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_text === 'First line\\nsecond line\\nthird line' && s.shout_to === 'coordinator')", 15_000);
    await chrome.waitFor("document.querySelector('#shout-text').value === ''");
    assert.ok(Math.abs(await height() - one) < 1, 'Enter sends, and the bar shrinks back to one line');
    assert.ok(await chrome.evaluate("!document.querySelector('#console').hidden && !document.querySelector('.composer #console') && document.querySelector('#console').getBoundingClientRect().bottom <= document.querySelector('.composer').getBoundingClientRect().top"),
      'the result stands above the bar, never inside it');

    // The panel hides and shows, and the browser remembers.
    await click('.panel-head [data-agents-toggle]');
    s = await state();
    const wide = s.feed.width;
    assert.deepEqual([s.bare, s.panel, s.toggle, s.kept], [true, false, 'Show agents', 'hidden'], 'Hide agents hides the panel and remembers it');
    await chrome.send('Page.reload');
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length > 0 && !!document.querySelector("[data-tab=shouts]")');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
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
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'shout', 'coordinator', 'Starting on the greeting.');
  earlier(alpha.repo, Date.now(), (board) => shoutOnBoard(board, { from: 'person', to: 'docs', text: 'Docs, anyone?', lanes: ['web', 'docs'] }));
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-heard-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 1');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    await chrome.evaluate("document.querySelector('#agents .fold-line[data-fold=\"idle\"]').click()");
    /** The composer and every shout of the person's, with what its Heard line says. */
    const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
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
        await chrome.evaluate(`document.querySelector('#agents [data-agent="web-1"]').click()`);
        const picked = await read();
        assert.ok(picked.chip === 'to web-1 (Test Model)×' && picked.clear[0] >= tapTarget(width) && picked.clear[1] >= tapTarget(width), `${at}: the chip's x is a square target: ${JSON.stringify(picked.clear)}`);
        await chrome.evaluate(`document.querySelector('#agents [data-agent="web-1"]').click()`);
        assert.equal((await read()).chip, null, `${at}: picking the agent again returns the composer to the coordinator`);
      }
    }

    // The person shouts with Enter: it goes to the coordinator, and says it is not heard until the coordinator reads it.
    await shoutsAt(chrome, 1280, 'light');
    await chrome.evaluate("document.querySelector('#shout-text').focus()");
    await chrome.send('Input.insertText', { text: 'Ship the greeting?' });
    await key();
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_from === 'person' && s.shout_to === 'coordinator' && s.shout_text === 'Ship the greeting?')", 15_000);
    await chrome.waitFor(`${heardOf('Ship the greeting?')} === 'Not heard yet'`, 15_000);
    box.run(alpha.repo, 'inbox');
    await chrome.waitFor(`${heardOf('Ship the greeting?')} === 'Heard by coordinator (unknown)'`, 15_000);
    // A shout that reaches everyone says who of them has read it: the coordinator first, then how many agents.
    // (The person reaches every agent through the relay's requests; here the board records one directly.)
    earlier(alpha.repo, Date.now(), (board) => shoutOnBoard(board, { from: 'person', to: 'all', text: 'Hold the merge, please.', lanes: ['web'] }));
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_from === 'person' && s.shout_to === 'all')", 15_000);
    box.run(alpha.repo, 'inbox');
    box.run(alpha.web, 'inbox');
    await chrome.waitFor(`${heardOf('Hold the merge, please.')} === 'Heard by coordinator (unknown) and 1 agent'`, 15_000);
    const all = (await read()).heard.find(([text]) => text === 'Hold the merge, please.');
    assert.deepEqual(all.slice(2), [2, 'Heard by coordinator (unknown), web-1 (Test Model)'], 'with their avatars, and every name on hover');

    // Picking an agent addresses the composer to it; the chip's x returns it to the coordinator.
    await chrome.evaluate(`document.querySelector('#agents [data-agent="web-1"]').click()`);
    let r = await read();
    assert.deepEqual([r.chip, r.to, r.placeholder], ['to web-1 (Test Model)×', 'web-1', 'Shout to web-1 (Test Model)'], 'a picked agent shows as a chip');
    const clearAt = tapTarget(await chrome.evaluate('innerWidth'));
    assert.ok(r.clear[0] >= clearAt && r.clear[1] >= clearAt, 'whose x is a square target');
    await chrome.evaluate(`document.querySelector('#shout-to-chip [data-to-clear]').click()`);
    r = await read();
    assert.deepEqual([r.chip, r.to, r.placeholder], [null, 'coordinator', 'Shout to the coordinator'], 'the x returns it to the coordinator');
    // An item's Shout button addresses its lane the same way.
    await chrome.evaluate("document.querySelector('[data-tab=items]').click()");
    await chrome.waitFor('!!document.querySelector("#chain [data-item=\\"1\\"]")');
    await chrome.evaluate(`document.querySelector('#chain [data-item="1"]').click()`);
    await chrome.waitFor('!!document.querySelector("#detail [data-shout]")');
    await chrome.evaluate(`document.querySelector('#detail [data-shout]').click()`);
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
test("a waiting ask's who and when stay on one line with wide fonts [N26]", { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the wide-font regression');
  const box = machine();
  const demo = project(box, 'wide-waiting-ask');
  box.run(demo.web, 'shout', 'coordinator', 'Does this waiting ask fit with a wider font?', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-wide-ask-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("data?.project && innerWidth === 375");
    await press(chrome, "document.querySelector('[data-tab=shouts]')");
    await pressedInto(chrome, "view.tab === 'shouts' && !!document.querySelector('.asks-toggle')");
    await press(chrome, "document.querySelector('.asks-toggle')");
    await pressedInto(chrome, "!!document.querySelector('#decisions .shout:not(:has(.answer)) header')");
    // Change font metrics only: the production layout must fit the same real waiting ask.
    await chrome.evaluate("(() => { const sheet = document.styleSheets[0]; sheet.insertRule('#decisions .shout header { font-family: monospace; letter-spacing: 1px; }', sheet.cssRules.length); })()");
    const result = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const card = document.querySelector('#decisions .shout:not(:has(.answer))'), header = card.querySelector('header');
      const rect = (element) => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      const who = header.querySelector('.who'), address = who.querySelector('.agent-id') || who, age = header.querySelector('time'), kind = header.querySelector('.mark');
      const range = document.createRange(); range.selectNodeContents(address);
      const recipient = header.querySelector('.to .agent-id') || header.querySelector('.to'), recipientRange = document.createRange(); recipientRange.selectNodeContents(recipient);
      const copy = header.cloneNode(true); copy.style.cssText += ';position:fixed;visibility:hidden;width:max-content'; header.parentElement.append(copy);
      const natural = copy.getBoundingClientRect().width; copy.remove();
      return { header:rect(header), age:rect(age), ageText:age.textContent, ageWidth:age.clientWidth, ageScroll:age.scrollWidth,
        address:rect(address), addressText:address.textContent, addressInk:rect(range), line:parseFloat(getComputedStyle(who).lineHeight),
        recipient:rect(recipient), recipientInk:rect(recipientRange), recipientText:recipient.textContent, spacing:getComputedStyle(header).letterSpacing, natural, kind:{ text:kind.textContent, width:kind.clientWidth, scroll:kind.scrollWidth, overflow:getComputedStyle(kind).textOverflow, title:kind.title, label:kind.getAttribute('aria-label') },
        page:[document.documentElement.clientWidth, document.documentElement.scrollWidth] };
    })())`));
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

test('shout cards fit beside a classic scrollbar [N26]', { timeout: 120_000 }, async () => {
  assert.ok(chromeExecutable(), 'this scrollbar regression proof requires actual Chrome');
  const box = machine();
  const alpha = project(box, 'cards');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G1', '--criterion', 'says goodbye');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'cards-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/cards2');
  box.run(second, 'join', 'web');
  // A committed page at a path too long for a phone, for a code reference to name.
  const deep = 'docs/a/very/long/path/that/keeps/going/past/a/phone/screen.md';
  mkdirSync(join(alpha.repo, deep, '..'), { recursive: true });
  writeFileSync(join(alpha.repo, deep), 'Deep line one\n');
  box.git(alpha.repo, 'add', deep);
  box.git(alpha.repo, 'commit', '-q', '-m', 'docs: a deep page');
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const lines = (first, n) => [first, ...Array.from({ length: n - 1 }, (_, k) => `Line ${k + 2} of the note.`)].join('\n');
  const older = 'Started on #1 two days back.';
  const colour = lines('Which colour for the button? #99 is no item.', 8);
  const ship = 'Ship #1 today?';
  const chips = `See #1 in src/cockpit.js at ${sha}; run pullboard check --json, then \`npm test\`.`;
  const long = lines('A long note that folds.', 12);
  const mixed = 'Moved #2 along.';
  const longCommand = 'node bin/run-tests.js test/relay-person-requests.test.js', longPath = 'test/relay-person-requests.test.js';
  const longerPath = 'docs/a/very/long/path/that/keeps/going/well/past/any/phone/screen/width.md';
  const longChips = `Ran \`${longCommand}\` on ${longPath} and ${longerPath} today.`;
  const sourceRefs = [`SPEC.md:1-2@${head}`, `${deep}:1@${head}`];
  const refsShout = `Check ${sourceRefs[0]} and ${sourceRefs[1]} before you merge.`;
  const blockShout = `Evidence for the page:\n${sourceRefs[0]}`;
  const twoDays = new Date(); twoDays.setDate(twoDays.getDate() - 2); twoDays.setHours(12, 0, 0, 0);
  earlier(alpha.repo, twoDays, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: older, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 65 * 60e3, (board) => shoutOnBoard(board, { from: 'web-2', to: 'coordinator', text: colour, decision: true, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 125e3, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: ship, decision: true, lanes: ['web'] }));
  const asked = JSON.parse(box.run(alpha.repo, 'decisions', '--json')).decisions.find((d) => d.shout_text === ship);
  box.run(alpha.repo, 'answer', String(asked.shout_id), 'Yes, ship it.');
  box.run(alpha.web, 'shout', 'all', 'the page loads in 80ms', '--evidence', 'receipt', '--outcome', 'measured 80ms', '--item', '1', '--commit', head);
  box.run(alpha.web, 'shout', 'all', chips);
  box.run(alpha.web, 'shout', 'all', mixed, '--evidence', 'receipt', '--outcome', 'moved', '--item', '1', '--commit', head);
  box.run(alpha.web, 'shout', 'all', longChips);
  box.run(alpha.web, 'shout', 'all', refsShout);
  box.run(alpha.web, 'shout', 'all', blockShout);
  box.run(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  box.run(alpha.web, 'shout', 'all', long);


  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-classic-scrollbar-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(chromeExecutable(), view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 12');
    /** Press a real mouse at an uncovered control after layout settles. */
    const press = async (selector) => {
      const point = await chrome.evaluate(`(async () => {
        const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center',behavior:'instant'});
        await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
        const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
        if(!r.width||!r.height||(hit!==e&&!e.contains(hit)))throw Error('mouse target is hidden or covered');
        return {x,y};
      })()`);
      for (const type of ['mouseMoved','mousePressed','mouseReleased']) await chrome.send('Input.dispatchMouseEvent', {
        type,...point,...(type==='mouseMoved'?{}:{button:'left',clickCount:1}),
      });
    };
    await press('[data-tab="shouts"]');
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    if (await chrome.evaluate(`document.querySelector('.asks-toggle[data-fold="waiting"]')?.getAttribute('aria-expanded') === 'false'`)) await press('.asks-toggle[data-fold="waiting"]');
    for (const font of ['monospace', '']) for (const scheme of ['light','dark']) {
      // A portable fallback exercises the wider font metrics used by CI, alongside the native font.
      await chrome.evaluate(`document.documentElement.style.setProperty('--sans', ${JSON.stringify(font)})`);
      await shoutsAt(chrome,375,scheme);
      const gutter=await chrome.evaluate('innerWidth-document.documentElement.clientWidth');
      assert.ok(gutter>=0&&gutter<=30, 'the fixture measures the browser scrollbar before selecting the viewport');
      await shoutsAt(chrome,360+gutter,scheme);
      const metrics=await chrome.evaluate(`(() => {
        const width=document.documentElement.clientWidth;
        const edge=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
        const cards=[...document.querySelectorAll('#feed .shout,#decisions .shout')];
        return {width,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth,
          headers:cards.map(card=>({box:edge(card.querySelector('header')),text:edge(card.querySelector('.text')),age:{...edge(card.querySelector('time')),whole:card.querySelector('time').scrollWidth<=card.querySelector('time').clientWidth},children:[...card.querySelector('header').children].map(e=>({kind:e.className||e.tagName,...edge(e)}))})),
          models:[...document.querySelectorAll('#feed .agent-model')].map(e=>e.textContent),
          ids:cards.flatMap(card=>[...card.querySelectorAll('.agent-id')].map(id=>({id:edge(id),card:edge(card)}))),
          over:cards.flatMap(card=>[...card.querySelectorAll('header,header>*')].filter(e=>edge(e).right>width).map(e=>({kind:e.className||e.tagName,...edge(e)})))};
      })()`);
      assert.equal(metrics.width,360, scheme+': actual page content is 360px, including on classic-scrollbar Chrome');
      assert.ok(metrics.models.some(text=>text.includes('Test Model')), 'the regression fixture includes real API model names');
      assert.ok(metrics.scroll<=metrics.width&&metrics.body<=metrics.width, scheme+': no sideways scroll: '+JSON.stringify({width:metrics.width,scroll:metrics.scroll,body:metrics.body,over:metrics.over}));
      assert.ok(metrics.headers.every(h=>h.children.every(e=>e.left>=h.box.left-1&&e.right<=h.box.right+1)&&h.age.whole&&Math.abs(h.age.right-h.box.right)<=1&&h.age.bottom<=h.text.top+1),
        scheme+': each header fits one line with its complete age at the right: '+JSON.stringify(metrics.headers));
      assert.ok(metrics.ids.length>0&&metrics.ids.every(({id,card})=>id.width>0&&id.left>=card.left&&id.right<=card.right),
        scheme+': every address remains visible inside its card');
    }
    assert.deepEqual(chrome.exceptions, [], 'the real page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, {recursive:true,force:true});
    await view.stop();
  }
});
