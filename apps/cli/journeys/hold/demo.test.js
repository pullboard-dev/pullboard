// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit demo checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  openShoutConversation,
  tapTarget,
  SPEC,
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  allowLiveHold,
  holdLive,
} from '../../tests/fixtures/cockpit/harness.js';
import {
  armDecisionPressCapture,
  finishDecisionPressCapture,
  armPhoneAnswerLifecycleCapture,
  finishPhoneAnswerLifecycleCapture,
} from '../../tests/fixtures/cockpit/demo-capture.js';
import {
  armLaneReleaseCapture,
  finishLaneReleaseCapture,
  includeLaneReleaseCapture,
} from '../../tests/fixtures/cockpit/lane.js';
import {
  assertFirstStateDelay,
  stageNaturalSpecChips,
  measureNaturalSpecChips,
} from '../../tests/fixtures/cockpit/stable.js';

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
  box.run(demo.web, 'shout', 'coordinator', 'Should this waiting ask span the full row?', '--decision', '--kind', 'question');
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
    /** Click the actual control through Chrome input coordinates, optionally arming a diagnostic before press. */
    const click = async (selector, beforePress = null) => {
      await waitRendered([selector]);
      if (beforePress) await beforePress();
      await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
    };
    /** Fill a form field and deliver its input and change events. */
    const fill = (selector, value) => chrome.stable(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('missing '+${JSON.stringify(selector)});
      e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    /** Submit a rendered form through native validation. */
    const submit = (selector) => chrome.stable(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
    /** Resize Chrome and wait for the board layout. */
    const setViewport = async (width) => {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.readyState === 'complete'`);
      await waitRendered(['[data-pane]:not([hidden])']);
    };
    /** Read actual visible target sizes and document geometry. */
    const snapshot = async () => {
      await waitRendered(['[data-pane]:not([hidden])']);
      return JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return !e.disabled&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&!e.closest('[hidden]')};
      const selector='button,a[href],input:not([type=hidden]),select,textarea,[role=button],[data-root],[data-tab],[data-go],[data-item],[data-state],[data-rows],[data-row],[data-release],[data-shout],[data-new],[data-code]';
      const controls=[...new Set(document.querySelectorAll(selector))].filter(visible).map(e=>{const b=e.getBoundingClientRect(),edges=e.matches('.seg button')?[...e.querySelectorAll('.seg-hit')].map(x=>x.getBoundingClientRect()):[],r={x:b.x,y:Math.min(b.top,...edges.map(x=>x.top)),right:b.right,bottom:Math.max(b.bottom,...edges.map(x=>x.bottom)),width:b.width};r.height=r.bottom-r.y;return {tag:e.tagName,id:e.id||'',text:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,60),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,inlineReference:e.matches('.feed button.ref, .feed a.ref[data-go], .shout button.ref, .shout a.ref[data-go], .shout .band a, .detail button.ref, .detail a.ref[data-go]')||!!e.closest('#chain .meta .gate, #detail .kv dd.waits-on'),statusBar:(!!e.closest('.status')||(!!e.closest('.composer')&&innerWidth>=900))&&!matchMedia('(pointer: coarse)').matches,oneLine:!e.closest('.status')||getComputedStyle(e).whiteSpace==='nowrap'}});
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
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('[data-tab=items]')");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('#chain .row')");
    await assertFirstStateDelay(chrome, t);
    await chrome.stable(`(() => {
      const probe=document.createElement('div'); probe.dataset.frameProbe='shared-wait';
      probe.style.cssText='position:fixed;left:0;top:0;width:1px;height:8px;background:transparent;pointer-events:none'; document.body.append(probe);
      let frame=0; const advance=()=>{ frame++; probe.dataset.frames=String(frame); probe.style.width=(frame+1)+'px'; if(frame<40)requestAnimationFrame(advance); };
      requestAnimationFrame(advance);
    })()`);
    const sampledFrames = Number(await chrome.stable("document.querySelector('[data-frame-probe]').dataset.frames", "document.querySelector('[data-frame-probe]')"));
    assert.equal(sampledFrames, 40, 'the shared real-Chrome wait does not measure a moving target before its box stops changing');
    await chrome.stable("document.querySelector('[data-frame-probe]').remove()");
    for (const width of [375, 1280]) {
      if (width === 1280) {
        box.run(demo.repo, 'shout', 'person', 'Should the desktop demo ship?', '--decision');
        await chrome.waitFor("document.querySelector('#feed').textContent.includes('Should the desktop demo ship?')", 15_000); // budget: hang ceiling for the demo decision shout to appear in the shout feed; no throughput claim.
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
        await chrome.waitFor("document.querySelector('#proj-name').textContent === 'phone-demo'");
        await click('[data-tab=items]');
        await chrome.waitFor("!!document.querySelector('#chain .row')");
      }
      assert.ok(await chrome.stable("[...document.querySelectorAll('#proj-list .pname')].some(e=>e.textContent==='phone-demo')"), `${width}: demo appears in the project list`);
      assert.ok(await chrome.stable("!!document.querySelector('#needs:not([hidden])')"), `${width}: Needs you is visible`);
      await click('#chain .row');
      await chrome.waitFor("!!document.querySelector('#detail h2')");
      assert.ok(await chrome.stable("!!document.querySelector('#detail h2')"), `${width}: selected item detail is visible`);
      await checkLayout(width, 'items, Needs you and detail');
      for (const tab of ['shouts', 'spec', 'doctrine', 'activity']) {
        await click(`.tab[data-tab="${tab}"]`);
        await checkLayout(width, `${tab} tab`);
        if (tab === 'spec') {
          await waitRendered(['#spec-chips button']);
          const { buttonCount, cloneCount, chips } = await measureNaturalSpecChips(chrome);
          assert.ok(buttonCount > 0, `${width}: Spec chip measurement found ${buttonCount} buttons and ${cloneCount} clones`);
          assert.equal(cloneCount, buttonCount, `${width}: spec chip measurements use one clone per current button`);
          assert.ok(chips.length >= 2, `${width}: spec filters render as chips`);
          for (const chip of chips) assert.ok(Math.abs(chip.actualWidth - chip.naturalWidth) < 2, `${width}: ${chip.text} keeps its natural width: ${JSON.stringify(chip)}`);
        }
        if (tab === 'activity') {
          const findTitle = `(() => [...document.querySelectorAll('#activity .activity-item')].find(node => node.title === ${JSON.stringify(wrapTitle)}))()`;
          await chrome.waitFor(`(() => { const element = ${findTitle}; return element?.getBoundingClientRect().width > 0; })()`);
          const fit = JSON.parse(await chrome.stable(`JSON.stringify((() => {
            const element = ${findTitle};
            if (!element) return null;
            const row = element.closest('.activity-event').getBoundingClientRect(), box = element.getBoundingClientRect(), style = getComputedStyle(element);
            return {rowRight: row.right, boxRight: box.right, boxWidth: box.width, boxHeight: box.height, lineHeight: parseFloat(style.fontSize) * 2, overflow: style.textOverflow, whiteSpace: style.whiteSpace, clipped: element.scrollWidth > element.clientWidth, title: element.title};
          })())`));
          assert.ok(fit, `${width}: the activity feed shows the long item title`);
          assert.ok(fit.boxWidth > 0 && fit.boxRight <= fit.rowRight + 1, `${width}: the ellipsized title stays inside its row: ${JSON.stringify(fit)}`);
          assert.ok(fit.whiteSpace === 'nowrap' && fit.overflow === 'ellipsis' && fit.clipped && fit.boxHeight < fit.lineHeight, `${width}: the long title is one ellipsized line: ${JSON.stringify(fit)}`);
          assert.equal(fit.title, wrapTitle, `${width}: the full title stays available in the title attribute`);
        }
        if (tab === 'shouts') {
          await click('[data-shout-thread="none"]');
          await waitRendered(['#feed .shout:not(:has(.answer)) header', '#feed .shout:not(:has(.answer)) .text', '#feed .shout .answer']);
          const asks = JSON.parse(await chrome.stable(`JSON.stringify((() => {
            const waiting = document.querySelector('#feed .shout:not(:has(.answer))');
            const waitingMeta = waiting?.querySelector('header');
            const waitingText = waiting?.querySelector('.text');
            const button = document.querySelector('#feed .shout .answer');
            const answerText = button?.closest('.shout-main').querySelector('.text');
            const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
            return {
              waitingHasNoAnswer: !!waiting && !waiting.querySelector('.answer'),
              waitingMeta: waitingMeta && rect(waitingMeta),
              waitingMetaLine: waitingMeta && Math.max(...[...waitingMeta.children].map(e => e.getBoundingClientRect().height)),
              waitingMetaRows: waitingMeta && new Set([...waitingMeta.children].flatMap(e => { const range = document.createRange(); range.selectNodeContents(e); return [...range.getClientRects()].map(r => Math.round(r.top + r.height / 2)); }).map(y => Math.round(y / 6))).size,
              waitingMain: waiting && rect(waiting.querySelector('.shout-main')), waitingText: waitingText && rect(waitingText),
              answerText: answerText && rect(answerText), button: button && rect(button),
            };
          })())`));
          assert.ok(asks.waitingHasNoAnswer, `${width}: the waiting ask is a conversation card without an Answer button`);
          assert.ok(asks.waitingMeta.width > 0 && asks.waitingMeta.height <= asks.waitingMetaLine + 1 && asks.waitingMetaRows === 1,
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
      const answerText = `Phone answer ${width}`;
      let answerLifecycleCaptureArmed = false;
      let answerLifecycleCapture = null;
      let answerLifecycleCaptureError = null;
      const lifecycleArm = await armPhoneAnswerLifecycleCapture(chrome, answerText);
      answerLifecycleCaptureArmed = lifecycleArm.armed === true;
      assert.ok(answerLifecycleCaptureArmed, `${width}: answer lifecycle capture arms: ${JSON.stringify(lifecycleArm)}`);
      await fill('#shout-to', 'web');
      await fill('#shout-text', `Phone shout ${width}`);
      await submit('#shout-form');
      await chrome.waitFor(`document.querySelector('#feed').innerText.includes('Phone shout ${width}')`);

      await click('[data-shout-thread="none"]');
      await chrome.waitFor("!!document.querySelector('#feed [data-go]')");
      const decision = await chrome.stable("document.querySelector('#feed [data-go]')?.getAttribute('data-go')");
      assert.ok(decision, `${width}: a decision is offered for answer`);
      const decisionSelector = `#feed [data-go="${decision}"]`;
      let decisionCaptureArmed = false;
      let decisionPressError = null;
      let decisionCapture = null;
      let decisionCaptureError = null;
      /** Arm the bounded capture after rendered readiness and immediately before the shared native press. */
      const beforeDecisionPress = async () => {
        const armed = await armDecisionPressCapture(chrome, decisionSelector);
        decisionCaptureArmed = armed.armed === true;
        if (!decisionCaptureArmed) throw new Error(`decision press capture did not arm: ${JSON.stringify(armed)}`);
      };
      try {
        await click(decisionSelector, beforeDecisionPress);
      } catch (error) { decisionPressError = error; }
      finally {
        if (decisionCaptureArmed) {
          try { decisionCapture = await finishDecisionPressCapture(chrome); }
          catch (error) { decisionCaptureError = `${error.name}: ${error.message}`; }
        }
      }
      if (decisionPressError) {
        const captureText = `decision press capture: ${JSON.stringify({ width, decision, capture: decisionCapture, captureError: decisionCaptureError, rootCauseStatus: 'NOT PROVEN' })}`;
        t.diagnostic(captureText);
        decisionPressError.message = `${decisionPressError.message}; ROOT-CAUSE STATUS: NOT PROVEN; ${captureText}`;
        throw decisionPressError;
      }
      assert.equal(decisionCaptureError, null, `${width}: decision press capture finishes without error`);
      assert.ok(decisionCapture?.armed, `${width}: decision press capture returns its observation`);
      await checkLayout(width, 'answer form');
      const answerRequests = new Map();
      const answerNetwork = [];
      let deadlineSnapshotTimer = null;
      let deadlineSnapshotStarted = false;
      let deadlineBoardSnapshot = null;
      /** Record only the single move request made by this isolated answer action, without its sealed body. */
      const observeAnswerNetwork = ({ data }) => {
        const message = JSON.parse(String(data));
        const event = message.params;
        if (message.method === 'Network.requestWillBeSent' && event.request.method === 'POST' && new URL(event.request.url).pathname.endsWith('/moves')) {
          // This listener is installed only around the one answer form submission; the body may be sealed.
          answerRequests.set(event.requestId, true);
          answerNetwork.push({ type: 'sent', at: Date.now(), method: event.request.method, path: '/api/v1/boards/:id/moves' });
        } else if (answerRequests.has(event?.requestId) && message.method === 'Network.responseReceived') {
          answerNetwork.push({ type: 'response', at: Date.now(), status: event.response.status });
        } else if (answerRequests.has(event?.requestId) && message.method === 'Network.loadingFinished') {
          answerNetwork.push({ type: 'finished', at: Date.now() });
        } else if (answerRequests.has(event?.requestId) && message.method === 'Network.loadingFailed') {
          answerNetwork.push({ type: 'failed', at: Date.now(), error: event.errorText });
        }
      };
      chrome.socket.addEventListener('message', observeAnswerNetwork);
      try {
        await chrome.stable(`(() => {
          const feed = document.querySelector('#feed');
          const probe = { feed, armedAt: Date.now(), lastMutationAt: null, answerVisibleAt: null, answerText: ${JSON.stringify(answerText)} };
          probe.observer = new MutationObserver(records => {
            const currentFeed = document.querySelector('#feed');
            const feedChanged = records.some(record => feed?.contains(record.target) || record.target === feed
              || [...record.addedNodes, ...record.removedNodes].some(node => node === feed || node === currentFeed || node.contains?.(feed) || node.contains?.(currentFeed)));
            if (!feedChanged) return;
            probe.lastMutationAt = Date.now();
            if (currentFeed?.innerText.includes(probe.answerText) && probe.answerVisibleAt === null) probe.answerVisibleAt = probe.lastMutationAt;
          });
          if (feed) probe.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          window.__phoneAnswerProbe = probe;
        })()`);
        await fill('#shout-text', answerText);
        const answerActionAt = Date.now();
        await submit('#shout-form');
        const waitStartedAt = Date.now();
        const waitDeadlineMs = 10_000;
        let resolveDeadlineSnapshot;
        deadlineBoardSnapshot = new Promise((resolve) => { resolveDeadlineSnapshot = resolve; });
        // Observe the same existing browser wait deadline without extending or changing that wait.
        deadlineSnapshotTimer = setTimeout(async () => {
          deadlineSnapshotStarted = true;
          const requestStartedAt = Date.now();
          try {
            const state = await boardOf(view, demo.repo);
            resolveDeadlineSnapshot({ requestStartedAt, responseAt: Date.now(), state });
          } catch (error) {
            resolveDeadlineSnapshot({ requestStartedAt, responseAt: Date.now(), error: String(error.message || error) });
          }
        }, waitDeadlineMs);
        try {
          await chrome.waitFor(`document.querySelector('#feed').innerText.includes('Phone answer ${width}')`);
          const waitSatisfiedAt = Date.now();
          let feed = null;
          let diagnosticError = null;
          try {
            feed = JSON.parse(await chrome.stable(`JSON.stringify((() => {
              const value = window.__phoneAnswerProbe;
              const node = document.querySelector('#feed');
              return { now: Date.now(), armedAt: value?.armedAt ?? null, textHasAnswer: !!node?.innerText.includes(value?.answerText || ''), feedRootSame: node === value?.feed, lastMutationAt: value?.lastMutationAt ?? null, answerVisibleAt: value?.answerVisibleAt ?? null };
            })())`));
          } catch (error) { diagnosticError = String(error.message || error); }
          t.diagnostic(JSON.stringify({ width, answerText, answerActionAt, waitStartedAt, waitSatisfiedAt,
            waitDeadlineMs, request: answerNetwork, feed, diagnosticError }));
        } catch (waitError) {
          const waitFailedAt = Date.now();
          let feed = null;
          let diagnosticError = null;
          try {
            feed = JSON.parse(await chrome.stable(`JSON.stringify((() => {
              const value = window.__phoneAnswerProbe;
              const node = document.querySelector('#feed');
              return { browserSampledAt: Date.now(), armedAt: value?.armedAt ?? null, textHasAnswer: !!node?.innerText.includes(value?.answerText || ''), feedRootSame: node === value?.feed, lastMutationAt: value?.lastMutationAt ?? null, answerVisibleAt: value?.answerVisibleAt ?? null };
            })())`));
          } catch (error) { diagnosticError = String(error.message || error); }
          const deadlineBoard = await deadlineBoardSnapshot;
          const board = deadlineBoard.state;
          const matchingShouts = (board?.shouts || []).filter((shout) => shout.shout_from === 'person' && shout.shout_text === answerText);
          const answerShout = matchingShouts.reduce((latest, shout) => !latest || shout.shout_id > latest.shout_id ? shout : latest, null);
          const newestShout = (board?.shouts || []).reduce((latest, shout) => !latest || shout.shout_id > latest.shout_id ? shout : latest, null);
          const sent = answerNetwork.find((event) => event.type === 'sent');
          const response = answerNetwork.find((event) => event.type === 'response');
          const deadlineAt = waitStartedAt + waitDeadlineMs;
          const newest = newestShout ? { id: newestShout.shout_id, at: newestShout.shout_at,
            from: newestShout.shout_from, text: String(newestShout.shout_text || '').slice(0, 120) } : null;
          const answer = answerShout ? { id: answerShout.shout_id, at: answerShout.shout_at } : null;
          const accepted = response?.status === 200 && matchingShouts.length > 0;
          const answerAt = answer?.at ? Date.parse(answer.at) : null;
          const arrivedLate = (sent?.at ?? 0) > deadlineAt || (response?.at ?? 0) > deadlineAt
            || (Number.isFinite(answerAt) && answerAt > deadlineAt);
          const acceptedByDeadline = accepted && Number.isFinite(answerAt) && answerAt <= deadlineAt;
          const feedProbeValid = Boolean(feed) && diagnosticError === null && Number.isFinite(feed.armedAt)
            && Number.isFinite(feed.browserSampledAt) && Object.hasOwn(feed, 'answerVisibleAt')
            && (feed.answerVisibleAt === null || Number.isFinite(feed.answerVisibleAt))
            && Object.hasOwn(feed, 'lastMutationAt') && (feed.lastMutationAt === null || Number.isFinite(feed.lastMutationAt));
          const feedHadNoAnswerByDeadline = feedProbeValid && (feed.answerVisibleAt === null || feed.answerVisibleAt > deadlineAt);
          const cause = !sent ? 'not sent'
            : arrivedLate ? 'answer request or board arrival occurred after the wait deadline'
              : acceptedByDeadline && feedHadNoAnswerByDeadline ? 'board records the answer before the deadline, but the feed has no answer render by the deadline'
                : 'not distinguished by the captured request, board, and feed state';
          try {
            answerLifecycleCapture = await finishPhoneAnswerLifecycleCapture(chrome);
            answerLifecycleCaptureArmed = false;
          } catch (error) { answerLifecycleCaptureError = `${error.name}: ${error.message}`; }
          const capture = { width, cause, waitDeadlineAt: deadlineAt, answerActionAt, waitStartedAt, waitFailedAt,
            requestSentAt: sent?.at ?? null, response: response ? { status: response.status, at: response.at } : null,
            answerShout: answer, newestBoardShout: newest, boardAnswerCount: matchingShouts.length,
            boardReadStartedAt: deadlineBoard.requestStartedAt, boardReadCompletedAt: deadlineBoard.responseAt,
            boardReadError: deadlineBoard.error ?? null, feedLastDomMutationAt: feed?.lastMutationAt ?? null,
            answerVisibleAt: feed?.answerVisibleAt ?? null, feedBrowserSampledAt: feed?.browserSampledAt ?? null,
            feedProbeValid, diagnosticError, answerLifecycleCapture, answerLifecycleCaptureError,
            rootCauseStatus: 'NOT PROVEN' };
          const captureText = `phone-answer capture: ${JSON.stringify(capture)}`;
          t.diagnostic(captureText);
          assert.fail(`${waitError.message}; ${captureText}`);
        }
        } finally {
          if (deadlineSnapshotTimer !== null) clearTimeout(deadlineSnapshotTimer);
          if (deadlineSnapshotStarted && deadlineBoardSnapshot) await deadlineBoardSnapshot;
          chrome.socket.removeEventListener('message', observeAnswerNetwork);
          await chrome.stable(`window.__phoneAnswerProbe?.observer.disconnect(); delete window.__phoneAnswerProbe`).catch(() => undefined);
          if (answerLifecycleCaptureArmed) {
            try {
              answerLifecycleCapture = await finishPhoneAnswerLifecycleCapture(chrome);
              answerLifecycleCaptureArmed = false;
            } catch (error) { answerLifecycleCaptureError = `${error.name}: ${error.message}`; }
          }
          t.diagnostic(JSON.stringify({ width, answerLifecycleCapture, answerLifecycleCaptureError }));
      }

      await fill('#hold-lane', 'web');
      await fill('#hold-reason', `Phone hold ${width}`);
      await submit('#hold-form');
      await chrome.waitFor("!!document.querySelector('#lanes [data-release=web]')");
      const releaseSelector = '#lanes [data-release="web"]';
      let laneCapture = null, laneCaptureError = null, lanePressError = null, laneCaptureSetup = null;
      try {
        await click(releaseSelector, async () => {
          laneCaptureSetup = await armLaneReleaseCapture(chrome, releaseSelector);
          if (!laneCaptureSetup.armed) throw new Error('lane-release capture target was absent');
        });
      } catch (error) { lanePressError = error; }
      finally {
        try { laneCapture = await finishLaneReleaseCapture(chrome, laneCaptureSetup); }
        catch (error) { laneCaptureError = String(error.message || error); }
      }
      if (lanePressError) {
        const laneDiagnostic = includeLaneReleaseCapture(lanePressError, { width, capture: laneCapture, captureError: laneCaptureError });
        t.diagnostic(laneDiagnostic);
        throw lanePressError;
      }
      await chrome.waitFor("!document.querySelector('#lanes [data-release=web]')");
    }

    const originalPointer = JSON.parse(await chrome.stable(`JSON.stringify({ fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches, none:matchMedia('(pointer: none)').matches })`));
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

    await chrome.stable(`(() => {
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
    await chrome.stable("document.querySelector('[data-scrollbar-proof]').remove()");
    await checkLayout(1280, 'after removing the deliberate overflow probe');

    const posts = chrome.requests.filter((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/moves'));
    assert.equal(posts.length, 10, 'each viewport sends add, shout, answer, hold and release through the public move endpoint');
    // The local view also asks its own server whether it can link boards (/api/v1/view-link, #633); every board read
    // and move still goes through the public boards API.
    const apiRequests = chrome.requests.filter((request) => {
      const path = new URL(request.url).pathname;
      return path.includes('/api/') && path !== '/api/v1/view-link';
    });
    const offPublic = [...new Set(apiRequests.map((request) => new URL(request.url).pathname)
      .filter((path) => !path.startsWith('/api/v1/boards')))];
    assert.ok(apiRequests.length > 0 && offPublic.length === 0,
      'every observed API request uses public v1' + (offPublic.length ? ': ' + offPublic.join(', ') : ''));
    const state = await boardOf(view, demo.repo);
    t.diagnostic(JSON.stringify({ width: 'final-board-state', personAnswers: state.shouts
      .filter((shout) => String(shout.shout_text || '').startsWith('Phone answer '))
      .map((shout) => ({ id: shout.shout_id, from: shout.shout_from, textLength: String(shout.shout_text || '').length,
        phone375: shout.shout_text === 'Phone answer 375', phone1280: shout.shout_text === 'Phone answer 1280' })) }));
    for (const width of [375, 1280]) {
      assert.ok(state.items.some((item) => item.title === `Phone item ${width}`));
      assert.ok(state.shouts.some((shout) => shout.shout_text === `Phone shout ${width}`));
      assert.ok(state.shouts.some((shout) => shout.shout_from === 'person' && shout.shout_text.includes(`Phone answer ${width}`)));
    }
    assert.deepEqual(state.holds, [], 'both widths released the held lane');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
    assert.deepEqual(consoleErrors, [], 'Chrome reports no console errors');
  } finally {
    if (chrome) {
      await finishPhoneAnswerLifecycleCapture(chrome).catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** Release a completed real hold refresh at the next pointer aim, reproducing the captured late console scroll. */
test('a finished lane hold does not scroll after the next press is aimed [N26,C7]', {
  timeout: 60_000, // budget: bound a hung real browser journey, not the duration of a successful request.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the late action scroll control');
  const box = machine();
  const demo = project(box, 'late-hold-demo');
  project(box, 'other-late-hold-demo');
  box.run(demo.repo, 'add', 'web', 'Hold control', '--specs', 'G1', '--criterion', 'the next press remains where it was aimed');
  box.run(demo.repo, 'shout', 'person', 'Should the hold control ship?', '--decision');
  // The captured desktop journey follows phone and desktop shouts; keep that real feed tall enough to scroll.
  for (const text of ['Phone shout 375', 'Phone answer 375', 'Phone shout 1280', 'Phone answer 1280']) {
    box.run(demo.repo, 'shout', 'web', text);
  }
  for (let index = 0; index < 8; index++) box.run(demo.web, 'shout', 'all', 'Earlier board discussion ' + index);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-late-hold-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    // Keep this one real refresh under test control; every HTTP response and render remains real (#622).
    await allowLiveHold(chrome);
    await chrome.send('Page.navigate', { url: view.link.href });
    await holdLive(chrome, 'data?.project?.items.some(item => item.title === "Hold control")');
    await press(chrome, 'document.querySelector("[data-tab=shouts]")');
    await openShoutConversation(chrome);
    await chrome.stable(`(() => {
      const originalRefresh = refresh;
      window.__lateHold = { ready: false, aimed: false, completed: false };
      /** Pause only the continuation after the real hold state has rendered. */
      refresh = async function() {
        await originalRefresh();
        refresh = originalRefresh;
        window.__lateHold.ready = true;
        await new Promise(resolve => { window.__lateHold.finish = resolve; });
        window.__lateHold.completed = true;
      };
      document.querySelector('#hold-lane').value = 'web';
      document.querySelector('#hold-reason').value = 'Keep the next press steady';
      document.querySelector('#hold-form').requestSubmit();
    })()`);
    await chrome.waitFor('window.__lateHold.ready && !!document.querySelector("#lanes [data-release=web]")');
    const geometry = JSON.parse(await chrome.stable(`JSON.stringify({ height: innerHeight,
      pageHeight: document.documentElement.scrollHeight, scrollY,
      console: document.querySelector('#console').getBoundingClientRect().toJSON(),
      success: document.querySelector('#console').classList.contains('ok') })`));
    t.diagnostic('late hold geometry: ' + JSON.stringify(geometry));
    assert.ok(geometry.pageHeight > geometry.height, 'the real feed can scroll, so a redundant scroll cannot pass vacuously');
    assert.ok(geometry.success && geometry.console.height > 0 && geometry.console.top >= 0 && geometry.console.bottom <= geometry.height,
      'the hold result is already visible before its refresh continuation resumes');
    await chrome.stable(`(() => {
      /** Finish the previous action exactly after Chrome aims at the next real button. */
      function finishAtAim(event) {
        if (!event.target.closest('#lanes [data-release=web]')) return;
        document.removeEventListener('pointermove', finishAtAim, true);
        window.__lateHold.aimed = true;
        window.__lateHold.before = scrollY;
        window.__lateHold.finish();
      }
      document.addEventListener('pointermove', finishAtAim, true);
    })()`);
    const captureSetup = await armLaneReleaseCapture(chrome, '#lanes [data-release=web]');
    try {
      await press(chrome, 'document.querySelector("#lanes [data-release=web]")');
    } finally {
      const capture = await finishLaneReleaseCapture(chrome, captureSetup);
      t.diagnostic('late hold continuation: ' + JSON.stringify(capture));
    }
    assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify({ aimed: window.__lateHold.aimed, completed: window.__lateHold.completed })')),
      { aimed: true, completed: true }, 'the real completed refresh resumed after pointer aim');
    await chrome.waitFor('!document.querySelector("#lanes [data-release=web]")');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the spec chip measurement survives a redraw [N26,C7]', {
  timeout: 30_000, // budget: stop a hung local Chrome flow; not a rendering-speed assertion.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is installed or PULLBOARD_CHROME points to it');

  const box = machine();
  const demo = project(box, 'spec-chip-redraw-demo');
  box.run(demo.repo, 'add', 'web', 'Spec chip measurement item', '--specs', 'G1', '--criterion', 'visible in the Spec chip redraw test');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-chip-redraw-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('[data-tab=items]')");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('#chain .row')");
    await press(chrome, "document.querySelector('[data-tab=spec]')");
    await chrome.waitFor("document.querySelectorAll('#spec-chips button:not([data-natural-chip])').length >= 2");

    let redraw;
    /** Reproduce the prior split-operation boundary with a real chip click and record why its samples differ. */
    const forceRedrawAtMeasurementBoundary = async () => {
      const staged = await stageNaturalSpecChips(chrome);
      assert.ok(staged.buttonCount >= 2, `Spec filters render as chips: ${JSON.stringify(staged)}`);
      assert.equal(staged.cloneCount, staged.buttonCount, `staging begins with matching buttons and clones: ${JSON.stringify(staged)}`);
      await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
      await chrome.waitFor("document.querySelectorAll('#spec-chips button:not([data-natural-chip])').length >= 2");
      redraw = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const stage = window.__specChipStage;
        const root = document.querySelector('#spec-chips');
        return {
          stagedButtonsConnected: stage.buttons.every(button => button.isConnected),
          stagedClonesConnected: stage.clones.every(clone => clone.isConnected),
          buttonCount: root.querySelectorAll('button:not([data-natural-chip])').length,
          cloneCount: root.querySelectorAll('[data-natural-chip]').length,
        };
      })())`));
      assert.equal(redraw.stagedButtonsConnected, false, `the actual filter click redrew the chip buttons: ${JSON.stringify(redraw)}`);
      assert.equal(redraw.stagedClonesConnected, false, `that redraw dropped the staged clones: ${JSON.stringify(redraw)}`);
      assert.equal(redraw.buttonCount, staged.buttonCount, `the current chip count stayed stable: ${JSON.stringify(redraw)}`);
      assert.equal(redraw.cloneCount, 0, `the redraw removed the staged clones rather than changing the chip count: ${JSON.stringify(redraw)}`);
    };

    const measured = await measureNaturalSpecChips(chrome, forceRedrawAtMeasurementBoundary);
    assert.ok(measured.buttonCount > 0, `Spec chip measurement found ${measured.buttonCount} buttons and ${measured.cloneCount} clones`);
    assert.equal(measured.cloneCount, measured.buttonCount, `the current buttons are cloned and measured together: ${JSON.stringify(measured)}`);
    assert.equal(measured.chips.length, measured.buttonCount, `every current Spec chip has a measurement: ${JSON.stringify(measured)}`);
    for (const chip of measured.chips) assert.ok(Math.abs(chip.actualWidth - chip.naturalWidth) < 2,
      `${chip.text} keeps its natural width after redraw: ${JSON.stringify(chip)}`);
    assert.equal(await chrome.stable("document.querySelectorAll('#spec-chips [data-natural-chip]').length"), 0,
      'natural-size clones are removed after measurement');
    assert.deepEqual(chrome.exceptions, [], 'the browser reports no page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the lanes panel fits its card at every width [N26]', {
  timeout: 120_000, // budget: hang ceiling for real Chrome startup and eight viewport and scheme layouts of one side card.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is installed or PULLBOARD_CHROME points to it');
  const box = machine();
  const demo = project(box, 'lanes-panel-fit', SPEC, { lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: ['review/'], specs: [] } } });
  // A holder whose name is longer than the README demo's "coordinator (Demo coordinator)", which already overflowed.
  const model = 'Demo coordinator with a long model name';
  box.run(demo.repo, 'join', 'coordinator', '--model', model);
  box.run(demo.repo, 'hold', 'review', '--reason', 'Waiting for the next demo item.');
  const held = `held by coordinator (${model})`;
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-lanes-panel-'));
  let chrome;
  /** The card's content box, its sideways scroll and the page's, the holder chip, and every lane and form box that leaves the content box. */
  const measure = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const card = document.querySelector('#shouts-pane aside[aria-label="Agents and lanes"]'), s = getComputedStyle(card), r = card.getBoundingClientRect();
    const left = r.left + card.clientLeft + parseFloat(s.paddingLeft), right = r.left + card.clientLeft + card.clientWidth - parseFloat(s.paddingRight);
    const name = (e) => e.id ? '#' + e.id : (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : e.tagName.toLowerCase()) + (e.textContent.trim() ? ' "' + e.textContent.trim().slice(0, 24) + '"' : '');
    const boxes = [...card.querySelectorAll('#lanes .lane, #lanes .lane *, #hold-form, #hold-form *')].filter((e) => e.getClientRects().length).map((e) => [name(e), e.getBoundingClientRect()]);
    const past = boxes.filter(([, b]) => b.left < left - 0.5 || b.right > right + 0.5).map(([n, b]) => [n, Math.round(b.left), Math.round(b.right)]);
    const chip = card.querySelector('#lanes [data-release="review"]')?.closest('.lane')?.querySelector('.chip'), cs = chip && getComputedStyle(chip);
    const form = card.querySelector('#hold-form'), widths = ['#hold-form', '#hold-lane', '#hold-reason', '#hold-form button[type=submit]'].map((q) => Math.round(card.querySelector(q).getBoundingClientRect().width * 10) / 10);
    return { content: [Math.round(left), Math.round(right)], column: s.gridTemplateColumns, card: [card.scrollWidth, card.clientWidth], page: [Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), document.documentElement.clientWidth],
      chip: chip && { text: chip.textContent.trim(), title: chip.title, wraps: cs.whiteSpace === 'normal', ellipsis: cs.textOverflow === 'ellipsis' && cs.overflow === 'hidden', clipped: chip.scrollWidth > chip.clientWidth },
      widths, past };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1440');
    await press(chrome, "document.querySelector('[data-tab=shouts]')");
    await chrome.waitFor("!!document.querySelector('#shouts-pane:not([hidden]) #lanes [data-release=review]')");
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
      for (const width of [375, 900, 1280, 1440]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.waitFor(`innerWidth === ${width}`);
        const at = `${width}/${scheme}`, m = await measure();
        assert.deepEqual(m.past, [], `${at}: every lane and form control stays inside the card's content box ${m.content}: ${JSON.stringify(m)}`);
        assert.ok(m.card[0] <= m.card[1] && m.page[0] <= m.page[1], `${at}: neither the card nor the page scrolls sideways: ${JSON.stringify(m)}`);
        assert.equal(m.chip.text, held, `${at}: the chip names the whole holder`);
        assert.ok(m.chip.wraps || (m.chip.ellipsis && m.chip.title === held), `${at}: a long holder wraps, or ends in an ellipsis with the full name on hover: ${JSON.stringify(m.chip)}`);
        assert.ok(m.widths.every((w) => Math.abs(w - (m.content[1] - m.content[0])) <= 1), `${at}: the hold form, its lane, its reason and its button take the card's width ${m.content[1] - m.content[0]}: ${m.widths}`);
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a moved press target names the element that moved it [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:18px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      document.body.prepend(spacer, standIn, target);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); standIn.remove(); target.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const fixture = JSON.parse(await chrome.stable('JSON.stringify({ grew: window.__pressMoveFixture?.grew() ?? false })'));
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.ok(fixture.grew, 'the stand-in box grows during the shared press pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after)
      && capture.page.scrollY.before !== capture.page.scrollY.after,
      `the failure capture records the native scroll-anchor adjustment before and after the press: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a removed lane-release target still cleans up its capture [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one target-removal cleanup check.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the removed-target cleanup check.');

  const box = machine();
  project(box, 'removed-press-target');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-removed-press-'));
  let chrome, captureSetup = null, captureFinishAttempted = false;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("document.readyState === 'complete' && !!document.body");
    await chrome.stable(`(() => {
      const target = document.createElement('button');
      target.id = 'removed-press-target';
      target.type = 'button';
      target.textContent = 'Temporary target';
      document.body.append(target);
      window.__removedPressOriginalScrollIntoView = Element.prototype.scrollIntoView;
    })()`);
    captureSetup = await armLaneReleaseCapture(chrome, '#removed-press-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the capture arms before its target is removed: ${JSON.stringify(captureSetup)}`);

    await chrome.stable("document.querySelector('#removed-press-target').remove()");
    captureFinishAttempted = true;
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    assert.equal(capture.pageError, null, `finishing after target removal does not throw: ${JSON.stringify(capture)}`);
    const removed = capture.page?.changedNodes.find((entry) => entry.node.id === 'removed-press-target');
    assert.equal(removed?.last.connected, false, `the bounded sample records that its target disappeared: ${JSON.stringify(capture.page?.changedNodes)}`);
    const cleanup = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const state = { captureInstalled: Boolean(window.__laneReleaseCapture), scrollIntoViewRestored:
        Element.prototype.scrollIntoView === window.__removedPressOriginalScrollIntoView };
      delete window.__removedPressOriginalScrollIntoView;
      return state;
    })())`));
    assert.deepEqual(cleanup, { captureInstalled: false, scrollIntoViewRestored: true },
      `the finish path removes its global and restores the native method: ${JSON.stringify(cleanup)}`);
  } finally {
    if (chrome) {
      if (captureSetup && !captureFinishAttempted) await finishLaneReleaseCapture(chrome, captureSetup).catch(() => undefined);
      await chrome.stable('delete window.__removedPressOriginalScrollIntoView').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a moved press target names a rendered-above box later in DOM order [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:18px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;overflow-anchor:auto';
      standIn.style.order = '-1';
      target.style.order = '0';
      group.append(target, standIn);
      document.body.prepend(spacer, group);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); group.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const order = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const above = document.querySelector('#press-move-stand-in');
      const target = document.querySelector('#press-move-target');
      return { above: above.getBoundingClientRect().bottom <= target.getBoundingClientRect().top,
        later: Boolean(target.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })())`));
    assert.deepEqual(order, { above: true, later: true }, 'the box renders above the target despite following it in DOM order');
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const fixture = JSON.parse(await chrome.stable('JSON.stringify({ grew: window.__pressMoveFixture?.grew() ?? false })'));
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.ok(fixture.grew, 'the stand-in box grows during the shared press pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after),
      `the failure capture records scroll positions even when flex layout moves the target without scrolling: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a zero-height box above a moved target keeps its old geometry [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:0px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;overflow-anchor:auto';
      standIn.style.order = '-1';
      target.style.order = '0';
      const below = Array.from({ length: 12 }, (_, index) => {
        const node = document.createElement('div');
        node.id = 'press-below-' + index;
        node.style.cssText = 'height:0px;order:1;overflow-anchor:none';
        return node;
      });
      group.append(target, standIn, ...below);
      document.body.prepend(spacer, group);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
          below.forEach(node => { node.style.height = '12px'; });
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); group.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const order = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const above = document.querySelector('#press-move-stand-in');
      const target = document.querySelector('#press-move-target');
      const before = above.getBoundingClientRect();
      return { above: before.bottom <= target.getBoundingClientRect().top,
        later: Boolean(target.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING),
        before: { top: before.top, documentTop: before.top + scrollY, height: before.height } };
    })())`));
    assert.deepEqual({ above: order.above, later: order.later, height: order.before.height }, { above: true, later: true, height: 0 },
      'the initially zero-height box is physically above the target but later in DOM order');
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const fixture = JSON.parse(await chrome.stable(`JSON.stringify({ grew: window.__pressMoveFixture?.grew() ?? false,
      targetTop: document.querySelector('#press-move-target').getBoundingClientRect().top,
      below: [...document.querySelectorAll('[id^="press-below-"]')].map(node => ({
        top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })) })`));
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.ok(fixture.grew, 'the stand-in box grows during the shared press pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.ok(moved.first, 'a box growing from zero above target retains old top/height: ' + failureText);
    assert.deepEqual({ top: moved.first.top, documentTop: moved.first.documentTop, height: moved.first.height }, order.before,
      'old top and height are the actual measurements before aim');
    assert.equal(moved.last.height, 98, 'the new height is the actual grown box');
    assert.equal(fixture.below.length, 12);
    assert.ok(fixture.below.every(box => box.height === 12 && box.top > fixture.targetTop),
      'twelve other zero-height boxes really grew below the target');
    assert.ok(changed.every(entry => !entry.node.id.startsWith('press-below-')),
      'below-target changes cannot crowd the rendered-above diagnostic');
    assert.equal(capture.page.truncated.remainingChangedNodes, 0, 'below-target growth does not consume the ten-detail allowance');
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after),
      `the failure capture records scroll positions even when flex layout moves the target without scrolling: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('below-target boxes cannot crowd the above-target aim cache [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:0px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;overflow-anchor:auto';
      standIn.style.order = '-1';
      target.style.order = '0';
      const below = Array.from({ length: 2001 }, (_, index) => {
        const node = document.createElement('div');
        node.id = 'press-below-' + index;
        node.style.cssText = 'height:0px;order:1;overflow-anchor:none';
        return node;
      });
      group.append(...below, target, standIn);
      for (const existing of document.body.children) existing.hidden = true;
      const tail = document.createElement('div');
      tail.style.cssText = 'height:1100px;overflow-anchor:none';
      document.body.prepend(spacer, group, tail);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
          below.forEach(node => { node.style.height = '12px'; });
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); group.remove(); tail.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const order = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const above = document.querySelector('#press-move-stand-in');
      const target = document.querySelector('#press-move-target');
      const before = above.getBoundingClientRect();
      return { above: before.bottom <= target.getBoundingClientRect().top,
        later: Boolean(target.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING),
        before: { top: before.top, documentTop: before.top + scrollY, height: before.height } };
    })())`));
    assert.deepEqual({ above: order.above, later: order.later, height: order.before.height }, { above: true, later: true, height: 0 },
      'the initially zero-height box is physically above the target but later in DOM order');
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const fixture = JSON.parse(await chrome.stable(`JSON.stringify({ grew: window.__pressMoveFixture?.grew() ?? false,
      targetTop: document.querySelector('#press-move-target').getBoundingClientRect().top,
      below: [...document.querySelectorAll('[id^="press-below-"]')].map(node => ({
        top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })) })`));
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.ok(fixture.grew, 'the stand-in box grows during the shared press pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.ok(moved.first, 'a box growing from zero above target retains old top/height: ' + failureText);
    assert.deepEqual({ top: moved.first.top, documentTop: moved.first.documentTop, height: moved.first.height }, order.before,
      'old top and height are the actual measurements before aim');
    assert.equal(moved.last.height, 98, 'the new height is the actual grown box');
    assert.equal(fixture.below.length, 2001);
    assert.ok(fixture.below.every(box => box.height === 12 && box.top > fixture.targetTop),
      '2001 DOM-earlier zero-height boxes really grew below the target');
    assert.ok(changed.every(entry => !entry.node.id.startsWith('press-below-')),
      'below-target changes cannot crowd the rendered-above diagnostic');
    assert.equal(capture.page.truncated.droppedByReason.nodeLimit, 0, 'unrelated below-target boxes never consume the aim cache');
    assert.equal(capture.page.truncated.remainingChangedNodes, 0, 'below-target growth does not consume the ten-detail allowance');
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after),
      `the failure capture records scroll positions even when flex layout moves the target without scrolling: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the above-target aim cache counts boxes beyond its limit [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:0px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;overflow-anchor:auto';
      standIn.style.order = '-1';
      target.style.order = '0';
      const extraAbove = Array.from({ length: 2001 }, (_, index) => {
        const node = document.createElement('div');
        node.id = 'press-extra-above-' + index;
        node.style.cssText = 'height:0px;order:-2;overflow-anchor:none';
        return node;
      });
      group.append(target, standIn, ...extraAbove);
      for (const existing of document.body.children) existing.hidden = true;
      const tail = document.createElement('div');
      tail.style.cssText = 'height:1100px;overflow-anchor:none';
      document.body.prepend(spacer, group, tail);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); group.remove(); tail.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const order = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const above = document.querySelector('#press-move-stand-in');
      const target = document.querySelector('#press-move-target');
      const before = above.getBoundingClientRect();
      return { above: before.bottom <= target.getBoundingClientRect().top,
        later: Boolean(target.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING),
        before: { top: before.top, documentTop: before.top + scrollY, height: before.height } };
    })())`));
    assert.deepEqual({ above: order.above, later: order.later, height: order.before.height }, { above: true, later: true, height: 0 },
      'the initially zero-height box is physically above the target but later in DOM order');
    const overflowGeometry = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const targetTop = document.querySelector('#press-move-target').getBoundingClientRect().top;
      const extras = [...document.querySelectorAll('[id^="press-extra-above-"]')];
      return { count: extras.length, allAbove: extras.every(node => {
        const rect = node.getBoundingClientRect();
        return rect.height === 0 && rect.top <= targetTop;
      }) };
    })())`));
    assert.deepEqual(overflowGeometry, { count: 2001, allAbove: true }, 'all overflow boxes really render above the target');
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.equal(await chrome.stable('window.__pressMoveFixture.grew()'), true, 'the stand-in really grows during pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.ok(moved.first, 'a box growing from zero above target retains old top/height: ' + failureText);
    assert.deepEqual({ top: moved.first.top, documentTop: moved.first.documentTop, height: moved.first.height }, order.before,
      'old top and height are the actual measurements before aim');
    assert.equal(moved.last.height, 98, 'the new height is the actual grown box');
    assert.equal(capture.page.observedNodes, 2000, 'the aim cache retains at most 2000 above-target boxes');
    assert.equal(capture.page.truncated.droppedByReason.nodeLimit, 3, '2001 extra above boxes plus the spacer and stand-in drop exactly three');
    assert.equal(capture.page.truncated.remainingChangedNodes, 0, 'unchanged overflow boxes do not create changed-box remainder');
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after),
      `the failure capture records scroll positions even when flex layout moves the target without scrolling: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
