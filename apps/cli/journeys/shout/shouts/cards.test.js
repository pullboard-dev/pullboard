// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit shouts: code chips, styling and cards [N26], using the shared real-board fixtures. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
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
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  assertFirstStateDelay,
} from '../../../tests/fixtures/cockpit/stable.js';
import {
  MACHINE_MODEL,
} from '../../../tests/fixtures/cockpit/machine.js';

async function openConversation(chrome, key = 'none') {
  const selector = '#feed [data-shout-thread="' + key + '"]';
  await chrome.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  await chrome.waitFor("!!document.querySelector('#feed .conversation-heading')");
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
    await chrome.click("document.querySelector('#new-item')");
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
    await chrome.waitFor('document.querySelectorAll("#feed > .shout").length >= 4');

    /** Measure only messages in the actually opened native conversation and the unchanged Items/Needs surfaces. */
    const readRendered = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const shout = [...document.querySelectorAll('#feed > .shout')].find((row) => row.textContent.includes('Inline'));
      const shoutCode=[...(shout?.querySelectorAll('code.inline')||[])].find(code=>code.textContent==='--flag'), shoutLine=shout?.querySelector('.text');
      const shoutRect=shoutCode?.getBoundingClientRect(), shoutLineRect=shoutLine?.getBoundingClientRect();
      const ask = document.querySelector('#needs [data-needs-key=\"decision:1\"] .needs-detail');
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
        if (!row) return null;
        const content = row.querySelector('.text');
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
        linkedButtons: [...document.querySelectorAll('#feed > .shout')].find((entry) => entry.textContent.includes('A linked line'))?.querySelectorAll('a.ref[data-go]').length,
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
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('document.querySelector("[data-pane=items]:not([hidden])") && document.querySelector("#detail .item-panel-brief code.inline")?.getBoundingClientRect().width > 0');
    const phoneBrief = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const code=document.querySelector('#detail .item-panel-brief code.inline'), line=code?.parentElement;
      const rect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return {display:code&&getComputedStyle(code).display,width:rect?.width,lineWidth:lineRect?.width};
    })())`));
    assert.equal(phoneBrief.display, 'inline', `375px brief code computes inline: ${JSON.stringify(phoneBrief)}`);
    assert.ok(phoneBrief.width > 0 && phoneBrief.width < phoneBrief.lineWidth / 2, `375px brief code is a compact chip: ${JSON.stringify(phoneBrief)}`);
    await chrome.click("document.querySelector('#new-item')");
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
        const row = [...document.querySelectorAll('#feed > .shout')].find((entry) => {
          const content = entry.querySelector('.text');
          return content && content.textContent.trim() === message;
        });
        if (!row) return null;
        const content = row.querySelector('.text');
        const height = content.getBoundingClientRect().height;
        const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
        return { height, lineHeight, lines: Math.round(height / lineHeight) };
      };
      const row=[...document.querySelectorAll('#feed > .shout')].find(entry=>entry.textContent.includes('Inline'));
      const code=[...(row?.querySelectorAll('code.inline')||[])].find(entry=>entry.textContent==='--flag'), line=row?.querySelector('.text'), codeRect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
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

test('shouts read as cards [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'cards');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G1', '--criterion', 'says goodbye');
  await box.inProcess(alpha.web, 'claim', '1');
  const second = join(box.dir, 'cards-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/cards2');
  await box.inProcess(second, 'join', 'web');
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
  const bodyOnly = 'Body-only #2 goes to Farewell.';
  const longCommand = 'node packages/gate/src/io/run/tests.js apps/cli/journeys/relay/person/requests.test.js', longPath = 'apps/cli/journeys/relay/person/requests.test.js';
  const longerPath = 'docs/a/very/long/path/that/keeps/going/well/past/any/phone/screen/width.md';
  const longChips = `Ran \`${longCommand}\` on ${longPath} and ${longerPath} today.`;
  const sourceRefs = [`SPEC.md:1-2@${head}`, `${deep}:1@${head}`];
  const refsShout = `Check ${sourceRefs[0]} and ${sourceRefs[1]} before you merge.`;
  const blockShout = `Evidence for the page:\n${sourceRefs[0]}`;
  const twoDays = new Date(); twoDays.setDate(twoDays.getDate() - 2); twoDays.setHours(12, 0, 0, 0);
  earlier(alpha.repo, twoDays, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: older, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 65 * 60e3, (board) => shoutOnBoard(board, { from: 'web-2', to: 'coordinator', text: colour, decision: true, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 125e3, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: ship, decision: true, lanes: ['web'] }));
  const asked = JSON.parse(await box.inProcess(alpha.repo, 'decisions', '--json')).decisions.find((d) => d.shout_text === ship);
  await box.inProcess(alpha.repo, 'answer', String(asked.shout_id), 'Yes, ship it.');
  await box.inProcess(alpha.web, 'shout', 'all', 'the page loads in 80ms', '--evidence', 'receipt', '--outcome', 'measured 80ms', '--item', '1', '--commit', head);
  await box.inProcess(alpha.web, 'shout', 'all', chips);
  await box.inProcess(alpha.web, 'shout', 'all', mixed, '--evidence', 'receipt', '--outcome', 'moved', '--item', '1', '--commit', head);
  await box.inProcess(alpha.web, 'shout', 'all', bodyOnly);
  await box.inProcess(alpha.web, 'shout', 'all', longChips);
  await box.inProcess(alpha.web, 'shout', 'all', refsShout);
  await box.inProcess(alpha.web, 'shout', 'all', blockShout);
  await box.inProcess(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  await box.inProcess(alpha.web, 'shout', 'all', long);

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-cards-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 12');
    await chrome.click("document.querySelector('[data-tab=shouts]')");
    await openConversation(chrome, 'item:1');
    const ids = JSON.parse(await chrome.stable('JSON.stringify(Object.fromEntries(data.project.shouts.map((s) => [s.shout_text, s.shout_id])))'));
    const answerId = await chrome.stable(`data.project.shouts.find((s) => s.shout_answers === ${asked.shout_id}).shout_id`);
    const stamps = JSON.parse(await chrome.stable('JSON.stringify(data.project.shouts.map((s) => [s.shout_id, s.shout_at]))'));

    /** Everything a card shows, measured where it stands. */
    const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const style = (e) => getComputedStyle(e);
      const card = (place, id) => {
        const e = document.querySelector(place + ' #shout-' + id) ?? [...document.querySelectorAll(place + ' .shout')].find((c) => c.dataset.shoutId === String(id));
        if (!e) return null;
        const who = e.querySelector('.who'), time = e.querySelector('header time'), text = e.querySelector('.text');
        const edges = [e, ...e.querySelectorAll('.receipt, .band')].map((part) => { const s = style(part); return { left: [s.borderLeftWidth, s.borderLeftColor], right: [s.borderRightWidth, s.borderRightColor] }; });
        return {
          classes: e.className, avatars: e.querySelectorAll('.avatar').length,
          who: { text: who.textContent, color: style(who).color, model: who.title }, to: e.querySelector('.to')?.textContent, item: document.querySelector('#feed .conversation-heading b')?.textContent ?? null,
          item_color: e.querySelector('header .item') && style(e.querySelector('header .item')).color, ink: style(text).color,
          time: { text: time.textContent, title: time.title, box: box(time) }, header: box(e.querySelector('header')), text: { content: text.textContent, box: box(text), lines: Math.round(text.clientHeight / parseFloat(style(text).lineHeight)), clamped: text.scrollHeight > text.clientHeight + 1 },
          more: (() => { const m = e.querySelector('.more'); return m && style(m).display !== 'none' ? m.textContent : null; })(),
          band: e.querySelector('.band') ? { text: e.querySelector('.band').textContent, done: e.querySelector('.band').classList.contains('done'), href: e.querySelector('.band a')?.getAttribute('href') ?? null } : null,
          receipt: e.querySelector('.receipt') ? { badge: e.querySelector('.receipt .badge').textContent, outcome: e.querySelector('.receipt .outcome').textContent, foot: e.querySelector('.receipt-foot').textContent,
            sha: e.querySelector('.receipt-foot code.sha')?.textContent, shaTitle: e.querySelector('.receipt-foot code.sha')?.title } : null,
          answer: e.querySelector('.answer')?.textContent ?? null, bodyLinks: [...e.querySelectorAll('.text a.ref[data-go]')].map(link => [link.textContent, link.dataset.go]), edges,
        };
      };
      const chip = (selector) => { const e = document.querySelector('#feed #shout-${ids[chips]} .text ' + selector); return e && { text: e.textContent, title: e.title, display: style(e).display, rects: e.getClientRects().length, color: style(e).color, background: style(e).backgroundColor }; };
      const feed = document.querySelector('#feed'), rule = feed.querySelector('.day-rule'), label = rule?.querySelector('span');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        messageIds: [...feed.querySelectorAll('.shout')].map(e => Number(e.dataset.shoutId)),
        feedKinds: [...feed.children].filter(e => e.matches('.day-rule,.shout')).map((e) => e.classList.contains('day-rule') ? 'rule:' + e.textContent : e.classList.contains('shout') ? 'shout:' + e.dataset.shoutId : e.className),
        rule: rule && { box: box(rule), label: box(label) },
        heads: [...document.querySelectorAll('#decisions .head')].map((h) => h.textContent),
        decisions: [...document.querySelectorAll('#decisions .shout')].map((e) => e.dataset.shoutId),
        feed: { older: card('#feed', ${ids[older]}), colour: card('#feed', ${ids[colour]}), ship: card('#feed', ${ids[ship]}), chips: card('#feed', ${ids[chips]}), long: card('#feed', ${ids[long]}),
          receipt: card('#feed', ${ids['the page loads in 80ms']}), answer: card('#feed', ${answerId}), friday: card('#feed', ${ids['Launch on Friday?']}), mixed: card('#feed', ${ids[mixed]}), bodyOnly: card('#feed', ${ids[bodyOnly]}) },
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
        chips: { ref: chip('a.ref[data-go]'), path: chip('code.path'), sha: chip('code.sha'), cmd: chip('code.cmd'), code: chip('code.inline:not(.path):not(.sha):not(.cmd)') },
      };
    })())`));

    /** Visit every real thread before combining measured observations; no message is supplied by a different fixture. */
    const readConversations = async () => {
      const threads = {};
      for (const key of ['item:1', 'none', 'item:2']) {
        if (await chrome.stable("!!document.querySelector('#feed .conversation-heading')")) await press(chrome, "document.querySelector('#feed [data-shout-thread=\"\"]')");
        await openConversation(chrome, key);
        threads[key] = await read();
      }
      const one = threads['item:1'], none = threads.none;
      return { ...none, threads, chips: one.chips, answerTarget: one.answerTarget, rule: one.rule,
        repeated: Object.values(threads).flatMap(thread => thread.repeated),
        feed: Object.fromEntries(Object.values(threads).flatMap(thread => Object.entries(thread.feed).filter(([, card]) => card))) };
    };

    const seen = {};
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const r = await readConversations();
        for (const [key, thread] of Object.entries(r.threads)) assert.ok(thread.page.scroll <= thread.page.width && thread.page.body <= thread.page.width,
          `${at} ${key}: no sideways scroll: ${JSON.stringify(thread.page)}`);
        const expectedThreads = {
          'item:1': [ids[older], ids[ship], answerId, ids['the page loads in 80ms'], ids[chips], ids[mixed]],
          'item:2': [ids[bodyOnly]],
          none: [ids[colour], ids[longChips], ids[refsShout], ids[blockShout], ids['Launch on Friday?'], ids[long]],
        };
        for (const [key, expected] of Object.entries(expectedThreads)) assert.deepEqual(r.threads[key].messageIds, expected.sort((a,b)=>a-b),
          `${at}: exact native ${key} membership, including answer inheritance and explicit native item recipient precedence`);
        assert.deepEqual(Object.values(r.threads).flatMap(thread => thread.messageIds).sort((a,b)=>a-b), stamps.map(([id]) => id).sort((a,b)=>a-b),
          `${at}: every original native message is measured exactly once`);
        const { older: old, colour: asking, ship: shipped, chips: chipCard, long: folded, receipt, answer, friday, mixed: both } = r.feed;

        // Native identity and geometry remain; the approved design has no avatar and moves the model to a tooltip.
        for (const [name, c] of Object.entries(r.feed)) {
          assert.ok(c, `${at}: the ${name} native message renders`);
          assert.equal(c.avatars, 0, `${at}: ${name} has no avatar`);
          assert.ok(Math.abs(c.time.box.right - c.header.right) <= 1 && c.time.box.top < c.text.box.top, `${at}: ${name}: the clock sits at the top right`);
          assert.ok(c.text.box.top >= c.header.bottom - 1, `${at}: ${name}: the text sits below its header`);
          for (const edge of c.edges) assert.deepEqual(edge.left, edge.right, `${at}: ${name}: no colored border edge`);
        }
        assert.deepEqual([old.who.text, old.who.model, old.to], ['web-1', MACHINE_MODEL, '→ coordinator'], `${at}: the exact sender, model hover and recipient`);
        assert.equal(asking.who.color, old.who.color, `${at}: agent names use the same approved violet`);
        assert.notEqual(answer.who.color, old.who.color, `${at}: the coordinator uses the accent color`);
        assert.ok(answer.classes.includes('lead') && answer.who.text === 'coordinator', `${at}: a native coordinator answer keeps its identity`);
        assert.deepEqual([old.item, chipCard.item, receipt.item, asking.item, both.item], ['#1 Greeting', '#1 Greeting', '#1 Greeting', 'No item', '#1 Greeting'],
          `${at}: native item recipients decide the conversation while unknown #99 stays No item`);
        assert.equal(r.feed.bodyOnly.item, '#2 Farewell', `${at}: absent an item recipient, the first real body item decides`);
        assert.deepEqual(both.bodyLinks, [['#2', 'item:2']], `${at}: the original mixed receipt still navigates its exact body reference`);
        assert.equal(both.text.content, mixed, `${at}: the native words are never rewritten to match the recipient`);
        const clockOf = id => {
          const date = new Date(stamps.find(([key]) => key === id)[1]), hour = date.getHours();
          return (hour % 12 || 12) + ':' + String(date.getMinutes()).padStart(2, '0') + ' ' + (hour < 12 ? 'AM' : 'PM');
        };
        assert.deepEqual([folded.time.text, shipped.time.text, asking.time.text].map(value => value.replace(/\s/gu,' ')),
          [ids[long], ids[ship], ids[colour]].map(clockOf), `${at}: every clock comes from its exact native timestamp`);
        assert.ok(shipped.time.title.endsWith(clockOf(ids[ship])) && old.time.title.includes(clockOf(ids[older])), `${at}: native clock details remain on hover`);

        // Chips: inline, whole, ref, path and hash each in a colour of their own; a sha shows ten characters.
        for (const [kind, c] of Object.entries(r.chips)) {
          assert.ok(c, `${at}: the ${kind} chip renders`);
          assert.match(c.display, /^inline/, `${at}: the ${kind} chip stays inline`);
          assert.equal(c.rects, 1, `${at}: the ${kind} chip never breaks across lines`);
        }
        assert.equal(new Set([r.chips.ref.color, r.chips.path.color, r.chips.sha.color]).size, 3, `${at}: item refs, paths and hashes each have a colour: ${JSON.stringify(r.chips)}`);
        assert.deepEqual([r.chips.sha.text, r.chips.sha.title], [sha.slice(0, 12), sha], `${at}: a full sha shows its first twelve characters, the whole on hover`);
        assert.deepEqual([r.chips.ref.text, r.chips.path.text, r.chips.cmd.text, r.chips.code.text], ['#1', 'src/cockpit.js', 'pullboard check --json', 'npm test']);
        // Long chips too: each one piece inside the text, the whole of it on hover; one longer than the line is cut short.
        assert.deepEqual(r.longs.map((c) => [c.text, c.title, c.rects, c.inside]), [longCommand, longPath, longerPath].map((text) => [text, text, 1, true]),
          `${at}: a long command, path and code stay one chip each: ${JSON.stringify(r.longs)}`);
        if (width === 375) assert.ok(r.longs[2].cut && r.longs[2].ends === 'ellipsis', `${at}: a chip longer than its line is cut short with an ellipsis: ${JSON.stringify(r.longs)}`);
        // A code reference reads path:lines@ten characters as one piece, the whole reference on hover and in its action.
        assert.deepEqual(r.refs.map((c) => [c.text, c.title, c.code, c.rects, c.inside, c.tail]), sourceRefs.map((ref) => [ref.replace(head, head.slice(0, 12)), ref, ref, 1, true, true]),
          `${at}: each code reference is one piece with its lines and short commit in view: ${JSON.stringify(r.refs)}`);
        if (width === 375) assert.ok(r.refs[1].cut && r.refs[1].ends === 'ellipsis', `${at}: a path too long for the line is cut short first: ${JSON.stringify(r.refs)}`);
        // A reference on a line of its own is a block, collapsed: a caret header the width of the text, no coloured edge.
        assert.deepEqual(r.block && [r.block.label, r.block.height >= tapTarget(width), r.block.full, r.block.caret, r.block.edges], [sourceRefs[0].replace(head, head.slice(0, 12)), true, true, 'drawn', true],
          `${at}: a whole-line reference is a collapsed block: ${JSON.stringify(r.block)}`);

        // Decisions: a band until answered, then who answered and a link to the answer.
        assert.deepEqual(asking.band, { text: 'Decision needed', done: false, href: null }, `${at}: an open ask carries a Decision needed band`);
        assert.deepEqual(shipped.band, { text: 'Answered by coordinator: see the answer', done: true, href: `#shout-${answerId}` }, `${at}: an answered one says who answered, linking the answer`);
        assert.ok(r.answerTarget, `${at}: the link lands on the answer`);
        assert.deepEqual(r.repeated, [], `${at}: an ask shown in the feed and above the composer never repeats an id`);

        // Evidence: a receipt with kind, outcome and a footer of item, agent and short sha.
        assert.deepEqual([receipt.receipt.badge, receipt.receipt.outcome], ['receipt', 'measured 80ms']);
        assert.ok(receipt.receipt.foot.startsWith(`#1 · web-1 (${MACHINE_MODEL}) · `) && receipt.receipt.sha === head.slice(0, 12) && receipt.receipt.shaTitle === head, `${at}: the receipt's footer: ${JSON.stringify(receipt.receipt)}`);

        // The approved three-line disclosure applies to messages, while native person-only Answer controls remain.
        assert.deepEqual([folded.text.lines, folded.text.clamped, folded.more], [3, true, 'Show all'], `${at}: a long native message folds at three lines`);
        assert.equal(old.more, null, `${at}: a short message has no disclosure`);
        assert.deepEqual(r.heads, [], `${at}: the superseded decisions wall is absent`);
        assert.deepEqual([friday.answer, asking.answer], ['Answer', null], `${at}: only the person's native question has an Answer control`);
        assert.deepEqual([asking.text.lines, asking.text.clamped, asking.more], [3, true, 'Show all'], `${at}: the pending question retains all its words behind disclosure`);
        assert.equal(friday.who.text, 'coordinator', `${at}: the person's question keeps its recorded author`);

        // Every actual conversation retains chronological native messages and every crossed day, including Today on return.
        for (const [key, thread] of Object.entries(r.threads)) {
          let day = new Date().toDateString();
          const expected = thread.messageIds.flatMap(id => {
            const before = day; day = new Date(stamps.find(([native]) => native === id)[1]).toDateString();
            return day === before ? ['shout:' + id] : ['rule', 'shout:' + id];
          });
          assert.deepEqual(thread.feedKinds.map(kind => kind.startsWith('rule:') ? 'rule' : kind), expected,
            `${at} ${key}: day rules occur only at native day transitions`);
        }
        const olderThread = r.threads['item:1'].feedKinds;
        const olderDay = twoDays.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        assert.equal(olderThread[olderThread.indexOf('shout:' + ids[older]) - 1], 'rule:' + olderDay, `${at}: the older native day is named exactly`);
        assert.ok(olderThread.includes('rule:Today'), `${at}: the ascending conversation names its return to today`);
        assert.ok(Math.abs((r.rule.label.left + r.rule.label.right) / 2 - (r.rule.box.left + r.rule.box.right) / 2) < 2, `${at}: the day stays centered`);
        seen[at] = { ink: old.ink, who: old.who.color };
      }
    }
    assert.notDeepEqual(seen['1280px light'], seen['1280px dark'], 'dark mode changes the cards');

    // Folding: more opens the whole shout, less closes it, and an open shout stays open across a refresh.
    await press(chrome, "document.querySelector('#feed [data-shout-thread=\"\"]')");
    await openConversation(chrome);
    await shoutsAt(chrome, 1280, 'light');
    const foldOf = () => chrome.stable(`JSON.stringify((() => { const c = document.querySelector('#feed #shout-${ids[long]}'), t = c.querySelector('.text'); return [c.querySelector('.more').textContent, Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight))]; })())`).then(JSON.parse);
    await chrome.click(`document.querySelector('#feed #shout-${ids[long]} .more')`);
    assert.deepEqual(await foldOf(), ['Show less', 12], 'more shows every line');
    await box.inProcess(alpha.web, 'shout', 'all', 'A later shout.');
    await chrome.waitFor(`data.project.shouts.some((s) => s.shout_text === 'A later shout.') && [...document.querySelectorAll('#feed .shout .text')].some(node => node.textContent === 'A later shout.')`, 15_000); // budget: hang ceiling for the new shout to replace the feed card; no throughput claim.
    assert.deepEqual(await foldOf(), ['Show less', 12], 'an open shout stays open across a refresh');
    await chrome.click(`document.querySelector('#feed #shout-${ids[long]} .more')`);
    assert.deepEqual(await foldOf(), ['Show all', 3], 'less folds it again');

    // The block opens on its header to the lines it names, in its own frame.
    const blockRef = `document.querySelector('#feed #shout-${ids[blockShout]} .code-ref > button.ref.block')`;
    await chrome.click(`${blockRef}`);
    await chrome.waitFor(`${blockRef}.parentElement.classList.contains('open') && ${blockRef}.getAttribute('aria-expanded') === 'true' && ${blockRef}.parentElement.querySelector('.code-wrap .code')?.textContent.includes('Demo spec')`, 15_000); // budget: hang ceiling for the referenced block to open; no throughput claim.

    // The short label still opens the code it names, at that commit.
    const deepRef = `[...document.querySelectorAll('#feed #shout-${ids[refsShout]} button[data-code]')][1]`;
    await chrome.click(`${deepRef}`);
    await chrome.waitFor(`${deepRef}.getAttribute('aria-expanded') === 'true' && ${deepRef}.nextElementSibling?.textContent.includes('Deep line one')`, 15_000); // budget: hang ceiling for the deep code reference to open; no throughput claim.
    // An inline reference keeps its label in the sentence and opens the same block a reference on its own line is.
    const opened = JSON.parse(await chrome.stable(`JSON.stringify((() => {
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

