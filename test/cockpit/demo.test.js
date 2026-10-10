/** Cockpit demo checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tapTarget, machine, project, startView, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';


test('real Chrome keeps the demo board usable at phone and desktop widths [H5,N26,N27]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for viewport checks.');

  const box = machine();
  const demo = project(box, 'phone-demo');
  const other = project(box, 'other-demo');
  box.run(demo.repo, 'add', 'web', 'Starter item', '--specs', 'G1', '--criterion', 'visible in the detail pane');
  const wrapTitle = 'word boundary test ' + 'abcdef0123456789'.repeat(12);
  box.run(demo.repo, 'add', 'web', wrapTitle, '--specs', 'G1', '--criterion', 'the activity title wraps without splitting words');
  box.run(demo.repo, 'shout', 'person', 'Should the phone demo ship?', '--decision');
  box.run(demo.web, 'shout', 'coordinator', 'Should this waiting ask span the full row?', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-phone-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    const consoleErrors = [];
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    });
    await chrome.send('Log.enable');

    /** Wait for every matching element to render before using its geometry [N26]. */
    const waitRendered = (selectors) => chrome.waitFor(`(() => {
      const groups = ${JSON.stringify(selectors)}.map(selector => [...document.querySelectorAll(selector)]);
      return groups.every(elements => elements.length > 0 && elements.every(element => {
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return !element.closest('[hidden]') && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }));
    })()`);
    /** Click the actual control through Chrome input coordinates. */
    const click = async (selector) => {
      await waitRendered([selector]);
      const point = JSON.parse(await chrome.evaluate(`(async () => {
        const find=()=>document.querySelector(${JSON.stringify(selector)});
        if(!find()) throw Error('missing '+${JSON.stringify(selector)});
        find().scrollIntoView({block:'center'});
        // Centering the sticky tab bar scrolls the page on for a few frames, so measure only once the
        // target has held still for two frames; a point read mid-scroll lands on whatever slid under it.
        // Find it afresh each frame: a refresh can redraw it, and a detached element measures as 0,0.
        const frame=()=>new Promise((done)=>requestAnimationFrame(()=>done()));
        let last='', still=0;
        for (let n=0; n<120 && still<2; n++) { await frame(); const e=find(); const b=e?e.getBoundingClientRect():null, now=b?[b.x,b.y,b.width,b.height,scrollX,scrollY].join():''; still=now&&now===last?still+1:0; last=now; }
        const e=find(); if(!e) throw Error('gone before the click: '+${JSON.stringify(selector)});
        const r=e.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
      })()`));
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    /** Fill a form field and deliver its input and change events. */
    const fill = (selector, value) => chrome.evaluate(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('missing '+${JSON.stringify(selector)});
      e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    /** Submit a rendered form through native validation. */
    const submit = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
    /** Resize Chrome and wait for the board layout. */
    const setViewport = async (width) => {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.readyState === 'complete'`);
      await waitRendered(['[data-pane]:not([hidden])']);
    };
    /** Read actual visible target sizes and document geometry. */
    const snapshot = async () => {
      await waitRendered(['[data-pane]:not([hidden])']);
      return JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return !e.disabled&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&!e.closest('[hidden]')};
      const selector='button,a[href],input:not([type=hidden]),select,textarea,[role=button],[data-root],[data-tab],[data-go],[data-item],[data-state],[data-rows],[data-row],[data-release],[data-shout],[data-new],[data-code]';
      const controls=[...new Set(document.querySelectorAll(selector))].filter(visible).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id||'',text:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,60),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,inlineReference:e.matches('.feed button.ref, .shout button.ref, .shout .band a, .detail button.ref')||!!e.closest('#chain .meta .gate, #detail .kv dd.waits-on'),statusBar:(!!e.closest('.status')||(!!e.closest('.composer')&&innerWidth>=900))&&!matchMedia('(pointer: coarse)').matches,oneLine:!e.closest('.status')||getComputedStyle(e).whiteSpace==='nowrap'}});
      const notice=document.querySelector('#console');
      const noticeBox=visible(notice)?notice.getBoundingClientRect():null;
      const toast=noticeBox?{x:noticeBox.x,y:noticeBox.y,right:noticeBox.right,bottom:noticeBox.bottom,visible:noticeBox.y>=0&&noticeBox.bottom<=innerHeight,
        overlaps:controls.filter(c=>c.x<noticeBox.right&&c.right>noticeBox.x&&c.y<noticeBox.bottom&&c.bottom>noticeBox.y).map(c=>c.id||c.text)}:null;
      return {width:innerWidth,clientWidth:document.documentElement.clientWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,
        pointer:{fine:matchMedia('(pointer: fine)').matches,coarse:matchMedia('(pointer: coarse)').matches,none:matchMedia('(pointer: none)').matches},
        touch:matchMedia('(pointer: coarse)').matches||innerWidth<900,
        statusParts:[...document.querySelectorAll('.status [data-status]')].filter(visible).map(part=>({label:part.textContent.replace(/\\s+/g,' ').trim(),height:part.getBoundingClientRect().height})),
        projectList:visible(document.querySelector('#proj-list')),needs:visible(document.querySelector('#needs')),
        detail:visible(document.querySelector('#detail')),controls,toast};
    })())`));
    };
    /** Check document and body overflow against the actual layout viewport, excluding its scrollbar. */
    const fitsViewport = (layout) => layout.documentWidth <= layout.clientWidth && layout.bodyWidth <= layout.clientWidth;
    /** Assert the current pane fits and all its controls remain touchable. */
    const checkLayout = async (width, place) => {
      const layout = await snapshot();
      assert.ok(fitsViewport(layout),
        `${width} ${place}: no horizontal overflow: ${JSON.stringify(layout)}`);
      // Where a finger taps (a coarse pointer, or a window under 900px) every action is a 44px target, inline references
      // in running text excepted; under a mouse, or no pointer at all, there is no minimum. Status labels stay on one line.
      const short = layout.touch ? layout.controls.filter((control) => control.height < 44 && !control.inlineReference) : [];
      assert.deepEqual(layout.controls.filter((control) => !control.oneLine), [], `${width} ${place}: status labels stay on one line`);
      assert.deepEqual(short, [], `${width} ${place}: visible enabled actions are at least 44px high: ${JSON.stringify(short)}`);
      if (layout.toast) assert.deepEqual(layout.toast.overlaps, [], `${width} ${place}: the result toast clears every visible control: ${JSON.stringify(layout.toast)}`);
      if (place === 'successful add toast') assert.equal(layout.toast?.visible, true, `${width}: the successful action toast remains in the viewport: ${JSON.stringify(layout.toast)}`);
    };

    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('#chain .row')");
    for (const width of [375, 1280]) {
      if (width === 1280) {
        box.run(demo.repo, 'shout', 'person', 'Should the desktop demo ship?', '--decision');
        await chrome.waitFor("document.querySelector('#needs').innerText.includes('Should the desktop demo ship?')", 15_000);
      }
      await setViewport(width);
      await click('[data-tab="items"]');
      if (width <= 900) {
        await click('#proj-switch');
        await chrome.waitFor("getComputedStyle(document.querySelector('#proj-list')).display !== 'none'");
        await checkLayout(width, 'open project list');
        await click(`[data-root="${other.repo}"]`);
        await chrome.waitFor("document.querySelector('#proj-name').textContent === 'other-demo'");
        await click('#proj-switch');
        await click(`[data-root="${demo.repo}"]`);
        await chrome.waitFor("document.querySelector('#proj-name').textContent === 'phone-demo' && !!document.querySelector('#chain .row')");
      }
      assert.ok(await chrome.evaluate("[...document.querySelectorAll('#proj-list .pname')].some(e=>e.textContent==='phone-demo')"), `${width}: demo appears in the project list`);
      assert.ok(await chrome.evaluate("!!document.querySelector('#needs:not([hidden])')"), `${width}: Needs you is visible`);
      await click('#chain .row');
      assert.ok(await chrome.evaluate("!!document.querySelector('#detail h2')"), `${width}: selected item detail is visible`);
      await checkLayout(width, 'items, Needs you and detail');
      for (const tab of ['shouts', 'spec', 'doctrine', 'activity']) {
        await click(`[data-tab="${tab}"]`);
        await checkLayout(width, `${tab} tab`);
        if (tab === 'spec') {
          await waitRendered(['#spec-chips button']);
          const chips = JSON.parse(await chrome.evaluate(`JSON.stringify([...document.querySelectorAll('#spec-chips button')].map(button => {
            const clone=button.cloneNode(true); clone.style.cssText += ';position:fixed;visibility:hidden;width:max-content;flex:none'; button.parentElement.append(clone);
            const naturalWidth=clone.getBoundingClientRect().width, actualWidth=button.getBoundingClientRect().width; clone.remove();
            return {text:button.textContent.trim(),actualWidth,naturalWidth};
          }))`));
          assert.ok(chips.length >= 2, `${width}: spec filters render as chips`);
          for (const chip of chips) assert.ok(Math.abs(chip.actualWidth - chip.naturalWidth) < 2, `${width}: ${chip.text} keeps its natural width: ${JSON.stringify(chip)}`);
        }
        if (tab === 'activity') {
          await chrome.waitFor(`(() => {
            const element = [...document.querySelectorAll('#activity .what')].find(node => node.textContent === ${JSON.stringify(wrapTitle)});
            return element?.getBoundingClientRect().width > 0 && element.firstChild?.nodeType === Node.TEXT_NODE;
          })()`);
          const wrap = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
            const element=[...document.querySelectorAll('#activity .what')].find(node=>node.textContent===${JSON.stringify(wrapTitle)});
            if(!element) return null;
            const text=element.firstChild, ranges=(word)=>{const start=text.textContent.indexOf(word),range=document.createRange();range.setStart(text,start);range.setEnd(text,start+word.length);return [...range.getClientRects()].map(rect=>({x:rect.x,y:rect.y,width:rect.width}));};
            const lines=(rects)=>new Set(rects.map(rect=>Math.round(rect.y))).size;
            return {width:element.clientWidth,height:element.getBoundingClientRect().height,wordLines:lines(ranges('boundary')),tokenLines:lines(ranges('abcdef0123456789'.repeat(12)))};
          })())`));
          assert.ok(wrap, `${width}: the activity feed shows the long item title`);
          assert.equal(wrap.wordLines, 1, `${width}: a normal word stays together at a line boundary: ${JSON.stringify(wrap)}`);
          assert.ok(wrap.tokenLines > 1, `${width}: only the overflowing unbroken token splits: ${JSON.stringify(wrap)}`);
        }
        if (tab === 'shouts') {
          await chrome.evaluate("(() => { const fold = document.querySelector('.asks-toggle[data-fold=\"waiting\"]'); if (fold && fold.getAttribute('aria-expanded') !== 'true') fold.click(); })()");
          await waitRendered(['#decisions .shout:not(:has(.answer)) header', '#decisions .shout:not(:has(.answer)) .text', '#decisions .shout .answer']);
          const asks = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
            const waiting = document.querySelector('#decisions .shout:not(:has(.answer))');
            const waitingMeta = waiting?.querySelector('header');
            const waitingText = waiting?.querySelector('.text');
            const button = document.querySelector('#decisions .shout .answer');
            const answerText = button?.closest('.shout-main').querySelector('.text');
            const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
            return {
              waitingIsNeedsYou: document.querySelector('#decisions').classList.contains('needs-you'),
              waitingHasNoAnswer: !!waiting && !waiting.querySelector('.answer'),
              waitingMeta: waitingMeta && rect(waitingMeta),
              waitingMetaLine: waitingMeta && parseFloat(getComputedStyle(waitingMeta.querySelector('.who')).lineHeight),
              waitingMain: waiting && rect(waiting.querySelector('.shout-main')), waitingText: waitingText && rect(waitingText),
              answerText: answerText && rect(answerText), button: button && rect(button),
            };
          })())`));
          assert.ok(asks.waitingIsNeedsYou && asks.waitingHasNoAnswer, `${width}: the waiting ask is a card in the Needs-you panel without an Answer button`);
          assert.ok(asks.waitingMeta.width > 0 && asks.waitingMeta.height <= asks.waitingMetaLine + 1,
            `${width}: waiting ask who/when stays on one line: ${JSON.stringify(asks)}`);
          assert.ok(asks.waitingText.width >= asks.waitingMain.width - 1,
            `${width}: waiting ask text spans the card: ${JSON.stringify(asks)}`);
          assert.ok(asks.button.top >= asks.answerText.bottom && asks.button.left >= asks.answerText.left - 1 && asks.button.height >= tapTarget(width),
            `${width}: the Answer button sits under the ask it answers: ${JSON.stringify(asks)}`);
        }
      }
      await click('[data-tab="items"]');

      await click('#new-item');
      await checkLayout(width, 'add form');
      await fill('#add-lane', 'web');
      await fill('#add-title', `Phone item ${width}`);
      await fill('#add-specs', 'G1');
      await click('#add-form button[type="submit"]');
      await chrome.waitFor(`document.querySelector('#chain').innerText.includes('Phone item ${width}')`);
      await chrome.waitFor("document.querySelector('#console.ok') && document.querySelector('#console').textContent.includes('added #')");
      await checkLayout(width, 'successful add toast');

      await click('[data-tab="shouts"]');
      await checkLayout(width, 'shout and hold forms');
      await fill('#shout-to', 'web');
      await fill('#shout-text', `Phone shout ${width}`);
      await submit('#shout-form');
      await chrome.waitFor(`document.querySelector('#feed').innerText.includes('Phone shout ${width}')`);

      await chrome.waitFor("!!document.querySelector('#decisions [data-go]')");
      const decision = await chrome.evaluate("document.querySelector('#decisions [data-go]')?.getAttribute('data-go')");
      assert.ok(decision, `${width}: a decision is offered for answer`);
      await click(`#decisions [data-go="${decision}"]`);
      await checkLayout(width, 'answer form');
      await fill('#shout-text', `Phone answer ${width}`);
      await submit('#shout-form');
      await chrome.waitFor(`document.querySelector('#feed').innerText.includes('Phone answer ${width}')`);

      await fill('#hold-lane', 'web');
      await fill('#hold-reason', `Phone hold ${width}`);
      await submit('#hold-form');
      await chrome.waitFor("!!document.querySelector('#lanes [data-release=web]')");
      await click('#lanes [data-release="web"]');
      await chrome.waitFor("!document.querySelector('#lanes [data-release=web]')");
    }

    const originalPointer = JSON.parse(await chrome.evaluate(`JSON.stringify({ fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches, none:matchMedia('(pointer: none)').matches })`));
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
    await setViewport(1280);
    await checkLayout(1280, 'coarse touch status and controls');
    const touchLayout = await snapshot();
    assert.deepEqual(touchLayout.pointer, { fine: false, coarse: true, none: false }, `1280 touch emulation selects the coarse primary pointer: ${JSON.stringify(touchLayout.pointer)}`);
    assert.ok(touchLayout.statusParts.length > 0, 'the real status bar exposes its visible controls');
    assert.ok(touchLayout.statusParts.every((part) => part.height >= 44), `1280 touch status controls keep a 44px target: ${JSON.stringify(touchLayout.statusParts)}`);
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await chrome.waitFor(`matchMedia('(pointer: fine)').matches === ${originalPointer.fine} && matchMedia('(pointer: coarse)').matches === ${originalPointer.coarse} && matchMedia('(pointer: none)').matches === ${originalPointer.none}`);

    await chrome.evaluate(`(() => {
      const probe = document.createElement('div');
      probe.dataset.scrollbarProof = '';
      probe.style.cssText = 'position:absolute;left:0;top:0;width:2000px;height:1px;';
      document.body.append(probe);
    })()`);
    const overflowingLayout = await snapshot();
    assert.ok(overflowingLayout.documentWidth > overflowingLayout.clientWidth,
      'the deliberate probe extends past the content viewport');
    assert.equal(fitsViewport(overflowingLayout), false,
      'the no-horizontal-overflow predicate detects deliberate content overflow');
    await chrome.evaluate("document.querySelector('[data-scrollbar-proof]').remove()");
    await checkLayout(1280, 'after removing the deliberate overflow probe');

    const posts = chrome.requests.filter((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/moves'));
    assert.equal(posts.length, 10, 'each viewport sends add, shout, answer, hold and release through the public move endpoint');
    const apiRequests = chrome.requests.filter((request) => new URL(request.url).pathname.includes('/api/'));
    assert.ok(apiRequests.length > 0 && apiRequests.every((request) => new URL(request.url).pathname.startsWith('/api/v1/boards')),
      'every observed API request uses public v1');
    const state = await boardOf(view, demo.repo);
    for (const width of [375, 1280]) {
      assert.ok(state.items.some((item) => item.title === `Phone item ${width}`));
      assert.ok(state.shouts.some((shout) => shout.shout_text === `Phone shout ${width}`));
      assert.ok(state.shouts.some((shout) => shout.shout_from === 'person' && shout.shout_text.includes(`Phone answer ${width}`)));
    }
    assert.deepEqual(state.holds, [], 'both widths released the held lane');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
    assert.deepEqual(consoleErrors, [], 'Chrome reports no console errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
