// pullboard: browser
/** @pullboard-test-gui */
/** One real component keeps every segmented control's geometry and state consistent [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  tapTouch,
  proofShot,
} from '../../tests/fixtures/cockpit/harness.js';

/** Read the real browser cascade and bounds, independently of the renderer's markup strings. */
async function measureControl(chrome, selector) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const track = document.querySelector(${JSON.stringify(selector)} + ' [data-segmented-control]');
    const style = getComputedStyle(track), rect = track.getBoundingClientRect(), root = getComputedStyle(document.documentElement);
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;background:var(--surface-2);color:var(--ink-muted);border-color:var(--line);border-radius:var(--radius-md)';
    document.body.append(probe);
    const tokens = getComputedStyle(probe);
    const expected = { background: tokens.backgroundColor, color: tokens.color, radius: tokens.borderRadius };
    probe.style.background = 'var(--surface)'; probe.style.color = 'var(--ink)';
    expected.pressedBackground = getComputedStyle(probe).backgroundColor; expected.pressedColor = getComputedStyle(probe).color;
    probe.style.color = 'var(--ink-faint)'; expected.countColor = getComputedStyle(probe).color;
    probe.style.borderRadius = 'var(--radius-sm)'; expected.optionRadius = getComputedStyle(probe).borderRadius;
    probe.remove();
    return { label:track.getAttribute('aria-label'), component:track.dataset.segmentedControl, pageWidth:document.documentElement.scrollWidth, viewport:innerWidth,
      height:rect.height, padding:[style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft], gap:style.gap,
      radius:style.borderRadius, background:style.backgroundColor, tap:Number.parseFloat(root.getPropertyValue('--tap')), expected,
      options:[...track.querySelectorAll('button')].map(button => {
        const css = getComputedStyle(button), box = button.getBoundingClientRect(), count = button.querySelector('b'), n = count && getComputedStyle(count);
        const edges = [...button.querySelectorAll('.seg-hit')].map(edge => edge.getBoundingClientRect());
        const hitHeight = Math.max(box.bottom, ...edges.map(edge => edge.bottom)) - Math.min(box.top, ...edges.map(edge => edge.top));
        return { text:button.childNodes[0]?.textContent, count:count?.textContent, pressed:button.getAttribute('aria-pressed'),
          height:box.height, hitHeight, edgeWidths:edges.map(edge => edge.width), width:box.width, font:css.fontFamily, size:css.fontSize, weight:css.fontWeight, radius:css.borderRadius,
          padding:[css.paddingTop,css.paddingRight,css.paddingBottom,css.paddingLeft], color:css.color, background:css.backgroundColor,
          shadow:css.boxShadow, border:css.borderTopWidth, countSize:n?.fontSize, countFont:n?.fontFamily,
          countColor:n?.color, countWeight:n?.fontWeight, countGap:n?.marginLeft };
      }) };
  })())`));
}

test('Items, Spec, Doctrine and Activity use one measured toggle with real choices and counts in Chrome [N26]', {
  timeout: 120_000, // budget: hang ceiling for a real board and eight pane/viewport interaction journeys.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required to measure all four segmented controls');
  const box = machine();
  const demo = project(box, 'seg-toggle', SPEC + '\n- G3 [draft, must] A proposed page requirement. | gate: web test\n', { practice: 'DOCTRINE.md' });
  writeFileSync(join(demo.repo, 'DOCTRINE.md'), '# Team doctrine\n\n## Local rules\n- R1 [approved, must] Keep the board accurate. | gate: web test\n- R2 [draft, must] A proposed team rule. | gate: web test\n');
  box.run(demo.repo, 'add', 'web', 'An item for the controls', '--specs', 'G1', '--criterion', 'The page greets the visitor.');
  box.run(demo.repo, 'shout', 'web', 'A real shout in Activity.');
  const view = await startView(box);
  const native = await boardOf(view, demo.repo);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-seg-toggle-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project && !!document.querySelector("[data-tab=items]")');
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      for (const [pane, selector, attribute, selected, alternative] of [
        ['items', '#items-view-switch', 'data-items-view', 'list', 'pipeline'],
        ['spec', '#spec-chips', 'data-rows', 'spec:all', 'spec:approved'],
        ['doctrine', '#doctrine-chips', 'data-rows', 'doctrine:all', 'doctrine:approved'],
        ['activity', '#activity-filters .activity-bar', 'data-activity-filter', 'all', 'shouts'],
      ]) {
        await press(chrome, 'document.querySelector("[data-tab=' + pane + ']")');
        await chrome.waitFor('!document.querySelector("[data-pane=' + pane + ']").hidden && !!document.querySelector(' + JSON.stringify(selector + ' [' + attribute + ']') + ')');
        await press(chrome, 'document.querySelector(' + JSON.stringify(selector + ' [' + attribute + '="' + selected + '"]') + ')');
        await press(chrome, "document.querySelector('#q')");
        await chrome.stable('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
        const actual = await measureControl(chrome, selector);
        console.log('PULLBOARD_SEG_MEASURE ' + JSON.stringify({ width, pane, actual }));
        assert.equal(actual.pageWidth, actual.viewport, 'the shared track scrolls within its pane without widening the page');
        assert.equal(actual.component, attribute, width + '/' + pane + ': the shared renderer owns the control');
        assert.equal(actual.height, actual.tap, width + '/' + pane + ': track height uses the target token');
        assert.equal(actual.tap, width === 1440 ? 32 : 44, 'existing desktop and phone target tokens remain in force');
        assert.deepEqual(actual.padding, ['2px', '2px', '2px', '2px']);
        assert.equal(actual.gap, '2px');
        assert.equal(actual.radius, actual.expected.radius);
        assert.equal(actual.background, actual.expected.background);
        assert.equal(actual.options.filter(option => option.pressed === 'true').length, 1, 'one choice is pressed');
        for (const option of actual.options) {
          assert.equal(option.height, actual.tap - 4, 'options fit inside the quiet track');
          assert.equal(option.hitHeight, actual.tap, 'transparent edges retain the full target height');
          assert.deepEqual(option.edgeWidths, [option.width, option.width], 'both edges cover the full option width');
          assert.equal(option.size, '13px');
          assert.match(option.font, /system-ui/u);
          assert.equal(option.radius, actual.expected.optionRadius);
          assert.deepEqual(option.padding, ['0px', '12px', '0px', '12px']);
          assert.equal(option.border, '0px');
          assert.equal(option.color, option.pressed === 'true' ? actual.expected.pressedColor : actual.expected.color, width + '/' + pane + '/' + option.text + ': resting option color');
          if (option.pressed === 'true') {
            assert.equal(option.weight, '600');
            assert.equal(option.background, actual.expected.pressedBackground);
            assert.match(option.shadow, /0px 1px 2px 0px/u, 'the pressed option has a soft lift');
            assert.match(option.shadow, /0px 0px 0px 1px/u, 'the pressed option has a hairline ring');
          } else assert.equal(option.shadow, 'none');
          if (option.count !== undefined) {
            assert.equal(option.countSize, '11px'); assert.match(option.countFont, /monospace/u);
            assert.equal(option.countWeight, '400'); assert.equal(option.countGap, '6px'); assert.equal(option.countColor, actual.expected.countColor);
          }
        }
        if (pane === 'items') {
          assert.deepEqual(actual.options.map(option => option.text), ['List', 'Pipeline']);
          assert.equal(await chrome.stable('document.querySelector("#filter-toggle").getBoundingClientRect().height'), actual.height, 'Items Filter and toggle match');
        } else if (pane === 'spec' || pane === 'doctrine') {
          const rows = pane === 'spec' ? native.spec : native.practice;
          assert.equal(actual.options.find(option => option.text === 'All rows').count, String(rows.length));
          assert.equal(actual.options.find(option => option.text === 'Approved').count, String(rows.filter(row => row.status === 'approved').length));
        } else assert.ok(Number(actual.options.find(option => option.text === 'Shouts').count) > 0, 'a real native shout is counted');
        await press(chrome, 'document.querySelector(' + JSON.stringify(selector + ' [' + attribute + '="' + alternative + '"]') + ')');
        await chrome.waitFor('document.querySelector(' + JSON.stringify(selector + ' [' + attribute + '="' + alternative + '"]') + ').getAttribute("aria-pressed") === "true"');
        await tapTouch(chrome, 'document.querySelector(' + JSON.stringify(selector + ' [' + attribute + '="' + selected + '"] .seg-hit-top') + ')');
        await chrome.waitFor('document.querySelector(' + JSON.stringify(selector + ' [' + attribute + '="' + selected + '"]') + ').getAttribute("aria-pressed") === "true"');
        await tapTouch(chrome, 'document.querySelector(' + JSON.stringify(selector + ' [' + attribute + '="' + alternative + '"] .seg-hit-bottom') + ')');
        await chrome.waitFor('document.querySelector(' + JSON.stringify(selector + ' [' + attribute + '="' + alternative + '"]') + ').getAttribute("aria-pressed") === "true"');
        const selectedVisible = await chrome.stable(`(() => {
          const track = document.querySelector(${JSON.stringify(selector)} + ' [data-segmented-control]'), choice = track.querySelector('[aria-pressed="true"]');
          const outer = track.getBoundingClientRect(), inner = choice.getBoundingClientRect();
          return inner.left >= outer.left && inner.right <= outer.right;
        })()`);
        assert.equal(selectedVisible, true, width + '/' + pane + ': rerender keeps the chosen option visibly in the track');
        await chrome.stable('document.querySelector(' + JSON.stringify(selector + ' button') + ').focus()');
        await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const focus = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const button = document.activeElement, track = button.closest('[data-segmented-control]'), css = getComputedStyle(button);
          const box = button.getBoundingClientRect(), outer = track?.getBoundingClientRect(), extension = Number.parseFloat(css.outlineWidth) + Number.parseFloat(css.outlineOffset);
          return { visible:button.matches('.seg button:focus-visible'), width:css.outlineWidth, offset:css.outlineOffset,
            contained:!!outer && box.top-extension >= outer.top && box.bottom+extension <= outer.bottom };
        })())`));
        assert.equal(focus.visible, true, 'native Tab gives the next option a visible keyboard focus');
        assert.equal(focus.width, '2px'); assert.equal(focus.offset, '-2px'); assert.equal(focus.contained, true, 'the whole focus ring remains inside the scrolling track');
        if (pane === 'items') assert.equal(await chrome.stable('document.querySelector("#pipeline").hidden'), false, 'Pipeline still opens');
        if (pane === 'activity') assert.equal(await chrome.stable('[...document.querySelectorAll("#activity [data-activity-kind]")].every(row => row.dataset.activityKind === "shout")'), true, 'Shouts still filters the real feed');
        await press(chrome, 'document.querySelector(' + JSON.stringify(selector + ' [' + attribute + '="' + alternative + '"]') + ')');
        await proofShot(chrome, 'seg-toggle-' + pane, width);
        const screenshot = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const chunks = screenshot.data.match(/.{1,16000}/gu);
        for (const [index, image] of chunks.entries()) console.log('PULLBOARD_SEG_SCREENSHOT ' + JSON.stringify({ pane, width, index, total: chunks.length, image }));
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'all four controls work without page exceptions');
  } finally {
    await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
