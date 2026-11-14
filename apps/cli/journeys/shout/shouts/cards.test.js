// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit shouts: code chips, styling and cards [N26], using the shared real-board fixtures. */
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
  SPEC,
  machine,
  project,
  startView,
  element,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  earlier,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  assertFirstStateDelay,
} from '../../../tests/fixtures/cockpit/stable.js';

async function openConversation(chrome, key = 'none') {
  const selector = '#feed [data-shout-thread="' + key + '"]';
  await chrome.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  await chrome.waitFor("!!document.querySelector('#feed .sx-tp')");
  // Messages read in full here: expand every one, as a person does by pressing it.
  if (await chrome.stable("!!document.querySelector('#feed .sx-earlier-msgs[aria-expanded=\"false\"]')")) await press(chrome, "document.querySelector('#feed .sx-earlier-msgs')");
  await chrome.stable("(() => { document.querySelectorAll('#feed .sx-msg').forEach((m) => { openShouts.add(Number(m.dataset.shoutId)); m.classList.add('full'); }); return true; })()");
}


test('a short code chip at a line end stays whole, and long code stays one chip inside the screen [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for code chip checks.');

  const box = machine();
  const demo = project(box, 'chip-ends');
  const long = 'docs/a/very/long/path/that/keeps/going/well/past/any/phone/screen/width.md';
  await box.inProcess(demo.repo, 'shout', 'all', `Pass the --flag option, then read ${long} before you submit.`);
  // Twenty-four wide characters are short by count but take two columns each: about 320px of one chip.
  const wide = '中文'.repeat(12);
  await box.inProcess(demo.repo, 'shout', 'all', 'Wide code `' + wide + '` wraps too.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-chip-end-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!document.querySelector(\'[data-tab="shouts"]\')');
    await chrome.click('document.querySelector(\'[data-tab="shouts"]\')');
    await openConversation(chrome);
    await chrome.waitFor(`[...document.querySelectorAll('#feed code.inline')].some((code) => code.textContent === ${JSON.stringify(wide)})`);
    for (const width of [320, 375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const seen = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const chips = [...document.querySelectorAll('#feed code.inline')];
        const flag = chips.find((code) => code.textContent === '--flag'), path = chips.find((code) => code.textContent === ${JSON.stringify(long)});
        const text = flag.parentElement.closest('div');
        // Long code stays one chip, cut short with an ellipsis where the line is shorter, and inside the screen.
        const pathRects = [...path.getClientRects()];
        // Measured where the chips live: no shout's text runs wider than its column. (The page as a whole is
        // other lanes' layout; at 320 on Linux a 15px scrollbar leaves 305px for it.)
        const longCode = { fragments: pathRects.length, title: path.title, right: Math.max(...pathRects.map((r) => r.right)), screen: document.documentElement.clientWidth,
          overflow: [...document.querySelectorAll('#feed .sx-msg .sx-tx')].some((column) => column.scrollWidth > column.clientWidth + 0.5) };
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

  // Since 639c16dbb5 the item panel shows the criterion under Done when and the brief in .item-panel-brief.
test('clause 1: real Chrome styles shout code and item text without growing linked lines [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'shout-code');
  const title = 'A `title` <img src=x onerror=alert(1)> #1';
  await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'Criterion `value` stays safe', '--brief', 'Run $ pullboard claim 1\nKeep `<safe>` literal.');
  await box.inProcess(alpha.web, 'claim', '1');
  const sourceHead = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const sample = 'Inline `code <b>safe</b>`; pullboard shout --decision; --flag; src/cockpit.js; 0123456789abcdef0123456789abcdef01234567.\nPreview SPEC.md:1-2@' + sourceHead + '. Invalid prefix:SPEC.md:1-2@' + sourceHead + '.\n```js\n<script>alert(1)</script>\n```\n$ pullboard claim 1\n<script>alert(1)</script>';
  const wrappedLinkedText = 'This deliberately long linked sample wraps across lines so text length does not define line height. '.repeat(3) + '#1';
  await box.inProcess(alpha.repo, 'shout', 'person', sample, '--decision');
  await box.inProcess(alpha.web, 'shout', 'all', 'A linked line #1');
  await box.inProcess(alpha.web, 'shout', 'all', 'A plain line here');
  await box.inProcess(alpha.web, 'shout', 'all', 'X #1');
  await box.inProcess(alpha.web, 'shout', 'all', 'X');
  await box.inProcess(alpha.web, 'shout', 'all', wrappedLinkedText);
  await box.inProcess(alpha.web, 'shout', 'all', 'OK');
  await box.inProcess(alpha.web, 'shout', 'all', '<script>alert(2)</script> outside code');
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
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 4');
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.click("document.querySelector('#chain [data-item=\"1\"]')");
    await assertFirstStateDelay(chrome, t);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280 && document.querySelector("#detail .item-panel-brief code.inline")?.getBoundingClientRect().width > 0');
    const desktopBrief = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const code=document.querySelector('#detail .item-panel-brief code.inline'), line=code?.parentElement;
      const rect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return {display:code&&getComputedStyle(code).display,width:rect?.width,lineWidth:lineRect?.width};
    })())`));
    assert.equal(desktopBrief.display, 'inline', `1280px brief code computes inline: ${JSON.stringify(desktopBrief)}`);
    assert.ok(desktopBrief.width > 0 && desktopBrief.width < desktopBrief.lineWidth / 2, `1280px brief code is a compact chip: ${JSON.stringify(desktopBrief)}`);
    await chrome.click("document.querySelector('[data-page-ctl=new]')");
    await chrome.waitFor("!document.querySelector('#add-form').hidden && getComputedStyle(document.querySelector('#add-form')).display === 'grid'");
    const desktopForm = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const form=document.querySelector('#add-form'), box=form.getBoundingClientRect();
      const fields=[...form.querySelectorAll('label')].map(field=>{const r=field.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      return {display:getComputedStyle(form).display,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},fields,actions:getComputedStyle(form.querySelector('.actions')).display};
    })())`));
    assert.equal(desktopForm.display, 'grid', `1280px add-item form keeps its grid: ${JSON.stringify(desktopForm)}`);
    assert.equal(desktopForm.actions, 'flex', `1280px add-item actions keep their row: ${JSON.stringify(desktopForm)}`);
    assert.equal(desktopForm.fields.length, 5, '1280px add-item form keeps all five fields');
    assert.ok(desktopForm.fields.every((field, index, fields) => field.width > 0 && field.left >= desktopForm.box.left && field.right <= desktopForm.box.right && field.top >= desktopForm.box.top && field.bottom <= desktopForm.box.bottom && (index === 0 || field.top >= fields[index - 1].bottom)), `1280px add-item fields remain a non-overlapping grid: ${JSON.stringify(desktopForm)}`);
    await chrome.click("document.querySelector('#add-cancel')");
    await chrome.waitFor("document.querySelector('#add-form').hidden");
    await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
    await openConversation(chrome);
    await chrome.waitFor('document.querySelectorAll("#feed .sx-msg").length >= 4');

    /** Measure only messages in the actually opened native conversation and the unchanged Items/Needs surfaces. */
    const readRendered = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const shout = [...document.querySelectorAll('#feed .sx-msg')].find((row) => row.textContent.includes('Inline'));
      const shoutCode=[...(shout?.querySelectorAll('code.inline')||[])].find(code=>code.textContent==='--flag'), shoutLine=shout?.querySelector('.sx-tx');
      const shoutRect=shoutCode?.getBoundingClientRect(), shoutLineRect=shoutLine?.getBoundingClientRect();
      const ask = document.querySelector('#needs [data-needs-key=\"decision:1\"] .needs-detail');
      const titleNode = document.querySelector('#chain .row .t');
      const outside = [...document.querySelectorAll('#feed .sx-msg')].find((row) => row.textContent.includes('alert(2)'));
      const itemDetail = document.querySelector('#detail');
      const agentItem = document.querySelector('#agents .sx-ag');
      /** Measure the complete rendered content line box, including its item link. */
      const lineMetrics = (message) => {
        const row = [...document.querySelectorAll('#feed .sx-msg')].find((entry) => {
          const content = entry.querySelector('.sx-tx');
          return content && content.textContent.trim() === message;
        });
        if (!row) return null;
        const content = row.querySelector('.sx-tx');
        const height = content.getBoundingClientRect().height;
        const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
        return { height, lineHeight, lines: Math.round(height / lineHeight) };
      };
      return {
        shoutHtml: shout?.innerHTML, shoutScripts: shout?.querySelectorAll('script').length,
        shoutCodeMetrics: {display:shoutCode&&getComputedStyle(shoutCode).display,width:shoutRect?.width,lineWidth:shoutLineRect?.width},
        askHtml: ask?.innerHTML, titleHtml: titleNode.innerHTML,
        linkedMetrics: lineMetrics('X #1'), plainMetrics: lineMetrics('X'),
        wrapLinked: lineMetrics(${JSON.stringify(wrappedLinkedText)}), wrapPlain: lineMetrics('OK'),
        linkedButtons: [...document.querySelectorAll('#feed .sx-msg')].find((entry) => entry.textContent.includes('A linked line'))?.querySelectorAll('a.ref[data-go]').length,
        previewLinks: shout?.querySelectorAll('button[data-code^="SPEC.md:1-2@"]').length,
        outsideHtml: outside?.innerHTML, askNestedButtons: [...(ask?.querySelectorAll('button') || [])].filter(link => link.parentElement.closest('button')).length,
        criterionHtml: itemDetail.querySelector('.item-panel-expand-text')?.innerHTML, briefHtml: itemDetail.querySelector('.item-panel-brief')?.innerHTML,
        needsNestedButtons: [...document.querySelectorAll('#needs button.ref')].filter(link => link.parentElement.closest('button')).length,
        agentNestedButtons: [...document.querySelectorAll('#agents button.ref')].filter(link => link.parentElement.closest('button')).length,
        agentItemHeight: agentItem?.getBoundingClientRect().height,
      };
    })())`));
    const noItemRendered = await readRendered();
    await press(chrome, "document.querySelector('#feed [data-shout-thread=\"\"]')");
    await openConversation(chrome, 'item:1');
    const itemRendered = await readRendered();
    const rendered = { ...noItemRendered, linkedMetrics: itemRendered.linkedMetrics, wrapLinked: itemRendered.wrapLinked, linkedButtons: itemRendered.linkedButtons };
    assert.equal(rendered.shoutCodeMetrics.display, 'inline', `1280px shout code computes inline: ${JSON.stringify(rendered.shoutCodeMetrics)}`);
    assert.ok(rendered.shoutCodeMetrics.width > 0 && rendered.shoutCodeMetrics.width < rendered.shoutCodeMetrics.lineWidth / 2,
      `1280px shout code is a compact chip: ${JSON.stringify(rendered.shoutCodeMetrics)}`);
    assert.match(rendered.shoutHtml, /<code class="inline">code &lt;b&gt;safe&lt;\/b&gt;<\/code>/, 'backticks create escaped inline code');
    assert.match(rendered.shoutHtml, /<code class="inline cmd(?: long" title="pullboard shout --decision)?">pullboard shout --decision<\/code>/, 'a pullboard command is inline code, with the flags that follow it');
    assert.match(rendered.shoutHtml, /<code class="inline cmd">--flag<\/code>/, 'a flag on its own is a command chip');
    assert.match(rendered.shoutHtml, /<code class="inline path">src\/cockpit\.js<\/code>/, 'slash paths are path chips');
    assert.match(rendered.shoutHtml, /<code class="inline sha" title="0123456789abcdef0123456789abcdef01234567">0123456789ab<\/code>/, 'a hex SHA is a twelve-character chip with the whole SHA on hover');
    assert.ok((rendered.shoutHtml.match(/<code class="code block">/g) ?? []).length >= 2, 'fences and dollar-prefixed lines are code blocks');
    assert.match(rendered.shoutHtml, /<code class="code block">\$ pullboard claim 1<\/code>/, 'the shell prompt stays visible in command blocks');
    assert.match(rendered.shoutHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'script text is escaped inside code');
    assert.equal(rendered.shoutScripts, 0, 'a shout cannot create a script element');
    assert.match(rendered.outsideHtml, /&lt;script&gt;alert\(2\)&lt;\/script&gt; outside code/, 'script text outside code is escaped too');
    assert.equal(rendered.previewLinks, 1, 'only a path:lines@SHA reference with the original whole-word boundaries becomes an actionable preview');
    assert.match(rendered.shoutHtml, /Invalid prefix:<code class="inline long" title="SPEC\.md:1-2@[0-9a-f]+">SPEC\.md:1-2@/, 'a path:lines@SHA suffix after a colon stays plain inline code');
    await press(chrome, "document.querySelector('#feed [data-shout-thread=\"\"]')");
    await openConversation(chrome);
    await chrome.click(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"]')`);
    await chrome.waitFor(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"]').getAttribute('aria-expanded') === 'true'`);
    await chrome.waitFor(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"] + .code-ref .code-wrap > .code')?.textContent.includes('Demo spec')`);
    assert.match(await chrome.stable(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"] + .code-ref .code-wrap > .code')?.textContent || ''`), /Demo spec/, 'the original code preview still opens its referenced lines');
    assert.match(rendered.askHtml, /<code class="inline cmd(?: long" title="pullboard shout --decision)?">pullboard shout --decision<\/code>/, 'needs-you uses the same code renderer');
    assert.equal(rendered.askNestedButtons, 0, 'formatted text in an ask cannot nest interactive controls');
    assert.equal(rendered.needsNestedButtons, 0, 'needs-you keeps its button markup valid');
    assert.equal(rendered.agentNestedButtons, 0, 'agent item buttons never nest reference controls');
    assert.ok(rendered.agentItemHeight >= 27, 'agent rows keep the approved 27px line');
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
    await chrome.waitFor('innerWidth === 375 && document.querySelector("#feed .sx-msg")?.getBoundingClientRect().width > 0');
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('document.querySelector("[data-pane=items]:not([hidden])") && document.querySelector("#detail .item-panel-brief code.inline")?.getBoundingClientRect().width > 0');
    const phoneBrief = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const code=document.querySelector('#detail .item-panel-brief code.inline'), line=code?.parentElement;
      const rect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return {display:code&&getComputedStyle(code).display,width:rect?.width,lineWidth:lineRect?.width};
    })())`));
    assert.equal(phoneBrief.display, 'inline', `375px brief code computes inline: ${JSON.stringify(phoneBrief)}`);
    assert.ok(phoneBrief.width > 0 && phoneBrief.width < phoneBrief.lineWidth / 2, `375px brief code is a compact chip: ${JSON.stringify(phoneBrief)}`);
    await chrome.click("document.querySelector('[data-page-ctl=new]')");
    await chrome.waitFor("!document.querySelector('#add-form').hidden && getComputedStyle(document.querySelector('#add-form')).display === 'grid'");
    const phoneForm = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const form=document.querySelector('#add-form'), box=form.getBoundingClientRect();
      const fields=[...form.querySelectorAll('label')].map(field=>{const r=field.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      return {display:getComputedStyle(form).display,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},fields,actions:getComputedStyle(form.querySelector('.actions')).display};
    })())`));
    assert.equal(phoneForm.display, 'grid', `375px add-item form keeps its grid: ${JSON.stringify(phoneForm)}`);
    assert.equal(phoneForm.actions, 'flex', `375px add-item actions keep their row: ${JSON.stringify(phoneForm)}`);
    assert.equal(phoneForm.fields.length, 5, '375px add-item form keeps all five fields');
    assert.ok(phoneForm.fields.every((field, index, fields) => field.width > 0 && field.left >= phoneForm.box.left && field.right <= phoneForm.box.right && field.top >= phoneForm.box.top && field.bottom <= phoneForm.box.bottom && (index === 0 || field.top >= fields[index - 1].bottom)), `375px add-item fields remain a non-overlapping grid: ${JSON.stringify(phoneForm)}`);
    await chrome.click("document.querySelector('#add-cancel')");
    await chrome.waitFor("document.querySelector('#add-form').hidden");
    await chrome.click("document.querySelector('[data-tab=shouts]')");
    await openConversation(chrome);
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden])") && document.querySelector("#feed code.inline")?.getBoundingClientRect().width > 0');
    /** Compare native linked and plain line boxes after visiting their respective conversations at the same viewport. */
    const readPhone = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      /** Measure the complete rendered content line box, including its item link. */
      const lineMetrics = (message) => {
        const row = [...document.querySelectorAll('#feed .sx-msg')].find((entry) => {
          const content = entry.querySelector('.sx-tx');
          return content && content.textContent.trim() === message;
        });
        if (!row) return null;
        const content = row.querySelector('.sx-tx');
        const height = content.getBoundingClientRect().height;
        const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
        return { height, lineHeight, lines: Math.round(height / lineHeight) };
      };
      const row=[...document.querySelectorAll('#feed .sx-msg')].find(entry=>entry.textContent.includes('Inline'));
      const code=[...(row?.querySelectorAll('code.inline')||[])].find(entry=>entry.textContent==='--flag'), line=row?.querySelector('.sx-tx'), codeRect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return { linked: lineMetrics('X #1'), plain: lineMetrics('X'), wrapLinked: lineMetrics(${JSON.stringify(wrappedLinkedText)}), wrapPlain: lineMetrics('OK'), shoutCode:{display:code&&getComputedStyle(code).display,width:codeRect?.width,lineWidth:lineRect?.width} };
    })())`));
    const noItemPhone = await readPhone();
    await press(chrome, "document.querySelector('#feed [data-shout-thread=\"\"]')");
    await openConversation(chrome, 'item:1');
    const itemPhone = await readPhone();
    const phoneMetrics = { ...noItemPhone, linked: itemPhone.linked, wrapLinked: itemPhone.wrapLinked };
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
