// pullboard: browser
/** @pullboard-test-gui */
/** Real Chrome regression cases for the shared wait [N26,C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from './fixture.js';
import { project } from './fixture.js';
import { startView } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { press } from './stable.js';
import { waitForStableBoxes } from './stable.js';

test('real Chrome retains reduced motion and jumps both detail panes without animation [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for motion checks.');
  const box = machine(), demo = project(box, 'motion-demo');
  box.run(demo.repo, 'add', 'web', 'Jump to this detail', '--specs', 'G1', '--criterion', 'visible');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'motion-chrome'));
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      assert.equal(await chrome.stable("matchMedia('(prefers-reduced-motion: reduce)').matches"), true, `${scheme}: a later media override keeps reduced motion`);
      assert.equal(await chrome.stable(`matchMedia('(prefers-color-scheme: ${scheme})').matches`), true);
    }
    await chrome.stable(`(() => {
      const probe = document.createElement('div'); probe.id = 'motion-proof';
      probe.style.cssText = 'position:fixed;width:10px;height:10px;transition:width 2s;animation:proof-motion 2s infinite;scroll-behavior:smooth';
      document.body.append(probe);
      window.__detailScrolls = [];
      const original = Element.prototype.scrollIntoView;
      /** Record the actual navigation scroll while retaining Chrome behavior. */
      Element.prototype.scrollIntoView = function(options) { window.__detailScrolls.push({id:this.id,behavior:options?.behavior}); return original.call(this, options); };
    })()`);
    assert.deepEqual(await chrome.stable(`(() => {const style=getComputedStyle(document.querySelector('#motion-proof'));return [style.transitionDuration,style.animationName,style.scrollBehavior];})()`), ['0s', 'none', 'auto'], 'reduced motion disables transitions, animations and CSS smooth scrolling');
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await press(chrome, "document.querySelector('#chain .row')");
    await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Jump to this detail')");
    await press(chrome, "document.querySelector('[data-tab=spec]')");
    await press(chrome, `document.querySelector('#spec-chips [data-rows="spec:all"]')`);
    await press(chrome, `document.querySelector('#spec-list [data-row="spec:G2"]')`);
    const scrolls = await chrome.stable('window.__detailScrolls');
    for (const id of ['detail', 'spec-detail']) assert.ok(scrolls.some(entry => entry.id === id && entry.behavior === 'instant'), `${id} jumps immediately: ${JSON.stringify(scrolls)}`);
    await chrome.stable(`(() => {
      const probe=document.createElement('div'); probe.id='zero-box-proof'; probe.style.cssText='position:fixed;width:0;height:0'; document.body.append(probe);
      let frame=0; const grow=()=>{frame++;probe.dataset.frames=String(frame);if(frame===20){probe.style.width='10px';probe.style.height='10px';}else requestAnimationFrame(grow);};requestAnimationFrame(grow);
    })()`);
    await waitForStableBoxes(chrome, "document.querySelector('#zero-box-proof')");
    assert.equal(Number(await chrome.stable("document.querySelector('#zero-box-proof').dataset.frames")), 20, 'the shared wait does not accept an existing zero-size target');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});


test('the shared wait survives a redrawn element [N26,C7]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for redraw checks.');
  const box = machine();
  project(box, 'redrawn-target');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'redrawn-chrome'));
    await chrome.waitFor('!!data?.project');
    await chrome.stable(`(() => {
      const button = document.createElement('button'); button.id = 'redrawn-proof'; button.textContent = 'Redrawn target';
      button.style.cssText = 'position:fixed;top:180px;left:20px;width:160px;height:44px'; document.body.append(button);
      window.__redrawSamples = 0; window.__redrawGap = false;
    })()`);
    // Resolve the real target each frame. The first sample detaches it; the second sees the same
    // null.closest gap as macOS CI, before the replacement is inserted on the following frame.
    const find = `(() => {
      const node = document.querySelector('#redrawn-proof'); window.__redrawSamples++;
      if (window.__redrawSamples === 1) {
        node.remove();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const replacement = node.cloneNode(true); replacement.dataset.replaced = 'yes'; document.body.append(replacement);
        }));
      }
      if (!node) window.__redrawGap = true;
      return node.closest('button');
    })()`;
    await assert.doesNotReject(() => waitForStableBoxes(chrome, find), 'a disappearing selector is sampled again until its replacement settles');
    assert.deepEqual(await chrome.stable(`[window.__redrawGap, document.querySelector('#redrawn-proof').dataset.replaced, window.__redrawSamples >= 4]`), [true, 'yes', true]);
    const missing = `document.querySelector('#never-redrawn-proof').closest('button')`;
    // budget: this deliberately missing target's short deadline bounds the diagnostic control.
    await assert.rejects(() => waitForStableBoxes(chrome, missing, 100), error => { // budget: declared 100 ms negative diagnostic deadline for this deliberately absent selector.
      assert.match(error.message, /never-redrawn-proof/, 'the timeout names the selector');
      assert.match(error.message, /last saw.*(?:TypeError|closest|null)/i, 'the timeout retains the last failed sample');
      return true;
    });
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});

test('a timeout always reports the last sample [N26,C7]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the throttled timeout diagnostic');
  const box = machine();
  project(box, 'timeout-last-sample');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'timeout-last-sample-chrome'));
    await chrome.waitFor('!!data?.project');
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const missing = "document.querySelector('#never-sampled-proof').closest('button')";
    await assert.rejects(() => waitForStableBoxes(chrome, missing, 1), error => { // budget: declared 1 ms first-sample negative diagnostic deadline for this absent selector.
      assert.match(error.message, /never-sampled-proof/, 'the timeout names the missing target');
      assert.match(error.message, /last saw.*TypeError/i, 'the 1 ms timeout includes the first sampled failure');
      return true;
    });
    assert.deepEqual(chrome.exceptions, [], 'the missing target is reported without an uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
