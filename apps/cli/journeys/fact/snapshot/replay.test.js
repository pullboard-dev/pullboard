// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit snapshot replay controls, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  build,
  sendBack,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  settled,
  serveFolder,
} from '../../../tests/fixtures/cockpit/harness.js';

test("the static export's Pause keeps its box through a press [A10,N26,C7]", { timeout: 60_000 }, // budget: hang-only ceiling for two viewport press journeys in isolated Chrome.
  async () => {
    const executable = chromeExecutable();
    assert.ok(executable, 'Chrome is required for the static Pause press proof');
    const box = machine();
    const alpha = project(box, 'snapshot replay');
    box.run(alpha.repo, 'add', 'web', 'Replay greeting', '--specs', 'G1', '--criterion', 'renders');
    build(box, alpha, 1, 'greeting.html');
    sendBack(box, alpha, 1, 'the first greeting needs a correction');
    build(box, alpha, 1, 'greeting-fix.html');
    box.git(alpha.repo, 'switch', '-q', '--detach', alpha.branch);
    try { box.run(alpha.repo, 'verify', '1', 'accept', '--note', 'the corrected greeting renders', '--as', 'coordinator'); }
    finally { box.git(alpha.repo, 'switch', '-q', 'main'); }
    box.run(alpha.repo, 'shout', 'person', 'Should the replay stay read-only?', '--decision');
    box.run(alpha.repo, 'hold', 'web', '--reason', 'Snapshot stays read-only');
    box.run(alpha.repo, 'shout', 'all', '<script>window.__snapshotShoutRan = true</script>');
    const folder = join(box.dir, 'pause-export');
    box.run(alpha.repo, 'view', '--export', folder);
    const host = await serveFolder(folder, '/demo/');
    let chrome;
    try {
      chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, join(box.dir, 'pause-chrome'));
      await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length");
      for (const width of [null, 375]) {
        if (width !== null) await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.stable(`replayPosition(snapshotReplay.events.length)`);
        await press(chrome, "document.querySelector('#replay-play')");
        const before = await chrome.stable(`(() => {
          // Hold only the next callback until the real pointer move, then deliver real replay steps.
          clearTimeout(snapshotReplay.timer);
          const pause = document.querySelector('#replay-pause');
          window.__pauseEndWitness = { before: { index: snapshotReplay.index, playing: snapshotReplay.playing,
            disabled: pause.disabled, label: pause.getAttribute('aria-label') }, moves: 0 };
          /** Finish the actual replay between the original shared press's aim and assertion. */
          pause.addEventListener('mousemove', () => {
            window.__pauseEndWitness.moves++;
            while (snapshotReplay.playing) { clearTimeout(snapshotReplay.timer); advanceReplay(); }
            clearTimeout(snapshotReplay.timer);
            window.__pauseEndWitness.after = { index: snapshotReplay.index, playing: snapshotReplay.playing,
              disabled: pause.disabled, label: pause.getAttribute('aria-label') };
          }, { once: true });
          return window.__pauseEndWitness.before;
        })()`);
        assert.equal(before.playing, true, `${width}: Pause is aimed while replay is running`);
        assert.equal(before.disabled, false, `${width}: Pause starts enabled`);
        assert.equal(before.label, 'Pause replay', `${width}: the icon-only control keeps its accessible label`);
        await press(chrome, "document.querySelector('#replay-pause')");
        const seen = await chrome.stable('({ witness: window.__pauseEndWitness, total: snapshotReplay.events.length })');
        assert.equal(seen.witness.moves, 1, `${width}: native pointer movement delivers the controlled interleaving`);
        assert.deepEqual(seen.witness.after, { index: seen.total, playing: false, disabled: true, label: 'Pause replay' },
          `${width}: actual replay end disables the same Pause label during the press`);
        console.log('PULLBOARD_499_END_PRESS ' + JSON.stringify({ width, ...seen }));
      }
      assert.deepEqual(chrome.exceptions, [], 'the end-during-press snapshot has no browser exceptions');
    } finally {
      if (chrome) await closeSnapshotChrome(chrome);
      await host.close();
    }
  });

test('replay speed is judged by its scheduled delay [A10,C7]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the throttled replay timing proof');
  const box = machine();
  const alpha = project(box, 'throttled-snapshot');
  for (let id = 1; id <= 6; id++) {
    box.run(alpha.repo, 'add', 'web', `Throttled replay item ${id}`, '--specs', 'G1', '--criterion', 'replays');
  }
  const folder = join(box.dir, 'throttled-export');
  box.run(alpha.repo, 'view', '--export', folder);
  const host = await serveFolder(folder, '/demo/');
  const profile = join(box.dir, 'throttled-chrome');
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const total = await chrome.stable('snapshotReplay.events.length');
    assert.ok(total >= 6, 'the exported history contains at least six native item moves');
    await chrome.stable(`(() => {
      window.__replayScheduledDelays = [];
      const nativeSetTimeout = window.setTimeout.bind(window);
      /** Observe replay pacing while preserving each native browser timeout unchanged. */
      window.setTimeout = (callback, delay, ...args) => {
        if (callback === window.advanceReplay) window.__replayScheduledDelays.push(delay);
        return nativeSetTimeout(callback, delay, ...args);
      };
    })()`);
    /** Confirm the pacing value for every scheduled step in a complete CPU-throttled replay. */
    const assertThrottledDelay = async (speed, delay) => {
      await chrome.stable(`(() => {
        window.__replayScheduledDelays.length = 0;
        replayPosition(snapshotReplay.events.length);
        const select = document.querySelector('#replay-speed');
        select.value = '${speed}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await press(chrome, "document.querySelector('#replay-play')");
      await chrome.waitFor('!snapshotReplay.playing', 30_000); // budget: hang-only ceiling for one complete replay.
      assert.equal(await chrome.stable('snapshotReplay.playing'), false, `${speed}× replay reaches its end`);
      assert.equal(await chrome.stable('snapshotReplay.index'), total, `${speed}× replay renders the final exported event`);
      const scheduled = await chrome.stable('window.__replayScheduledDelays');
      assert.equal(scheduled.length, total - 1, `${speed}× schedules one delay between every replay step`);
      assert.ok(scheduled.every((actual) => actual === delay), `${speed}× schedules ${delay} ms per step`);
    };
    await assertThrottledDelay('1', 1000);
    await assertThrottledDelay('4', 250);
    await assertThrottledDelay('16', 62.5);
    await chrome.stable(`(() => {
      window.__replayScheduledDelays.length = 0;
      replayPosition(snapshotReplay.events.length);
      const select = document.querySelector('#replay-speed');
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await press(chrome, "document.querySelector('#replay-play')");
    const atFour = await chrome.stable('({ playing: snapshotReplay.playing, delay: window.__replayScheduledDelays.at(-1) })');
    const atSixteen = await chrome.stable(`(() => {
      const select = document.querySelector('#replay-speed');
      select.value = '16';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { playing: snapshotReplay.playing, delay: window.__replayScheduledDelays.at(-1) };
    })()`);
    await press(chrome, "document.querySelector('#replay-pause')");
    const changedSpeed = { wasPlaying: atFour.playing, atFour: atFour.delay, remainsPlaying: atSixteen.playing,
      atSixteen: atSixteen.delay, paused: !(await chrome.stable('snapshotReplay.playing')) };
    assert.deepEqual(changedSpeed, { wasPlaying: true, atFour: 250, remainsPlaying: true, atSixteen: 62.5, paused: true },
      'changing speed while playing replaces the scheduled delay under CPU throttle');
    assert.deepEqual(chrome.exceptions, [], 'the throttled snapshot reports no uncaught browser errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
  }
});

/** Measure every interactive replay control through its real start, pause, and end states. */
const replayControlsStayPut = (wideFonts = false, classicScrollbar = false) => async function replayControlsStayPutCase(t) {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for replay control geometry coverage');
  const box = machine();
  const alpha = project(box, 'stable-replay-controls');
  for (let id = 1; id <= 6; id++) {
    box.run(alpha.repo, 'add', 'web', `Replay geometry item ${id}`, '--specs', 'G1', '--criterion', 'replay controls stay put');
  }
  const folder = join(box.dir, 'stable-replay-controls-export');
  box.run(alpha.repo, 'view', '--export', folder);
  if (classicScrollbar) {
    const stylesheet = join(folder, 'view.css');
    writeFileSync(stylesheet, readFileSync(stylesheet, 'utf8') + '\n::-webkit-scrollbar { width: 15px; }\n');
  }
  const host = await serveFolder(folder, '/demo/');
  const profile = join(box.dir, 'stable-replay-controls-chrome');
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const total = await chrome.stable('snapshotReplay.events.length');
    assert.ok(total >= 6, 'the exported replay has enough events to exercise all control states');
    /** Sample original comparison boxes and runner layout evidence in the same browser evaluation. */
    const readControlBoxes = async (width, state) => {
      const capture = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const selectors = ['#replay-play', '#replay-pause', '#replay-speed'];
        const boxes = Object.fromEntries(selectors.map(selector => {
          const node = document.querySelector(selector);
          const rect = node.getBoundingClientRect();
          return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
        }));
        const controls = selectors.map(selector => {
          const node = document.querySelector(selector);
          const style = getComputedStyle(node);
          const parent = node.parentElement;
          const track = getComputedStyle(parent);
          return { id: node.id, box: boxes[selector], label: node.textContent,
            selectedLabel: node.selectedOptions?.[0]?.textContent ?? null,
            fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
            lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
            width: style.width, minWidth: style.minWidth, maxWidth: style.maxWidth,
            track: { parent: parent.id || parent.className, display: track.display,
              columns: track.gridTemplateColumns, rows: track.gridTemplateRows,
              flexDirection: track.flexDirection, flexWrap: track.flexWrap,
              gap: track.gap, parentWidth: track.width, flexBasis: style.flexBasis,
              flexGrow: style.flexGrow, flexShrink: style.flexShrink,
              columnStart: style.gridColumnStart, columnEnd: style.gridColumnEnd } };
        });
        const root = document.documentElement;
        const scroller = document.scrollingElement;
        const rootStyle = getComputedStyle(root);
        return { boxes, controls, observedAt: Date.now(),
          viewport: { innerWidth, innerHeight, clientWidth: root.clientWidth,
            bodyClientWidth: document.body.clientWidth, scrollWidth: scroller.scrollWidth,
            scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
            scrollbarWidth: innerWidth - root.clientWidth,
            scrollbarGutter: rootStyle.scrollbarGutter, overflowY: rootStyle.overflowY },
          browser: { userAgent: navigator.userAgent, platform: navigator.platform, devicePixelRatio },
          replay: { index: snapshotReplay.index, total: snapshotReplay.events.length,
            playing: snapshotReplay.playing } };
      })())`));
      t.diagnostic('replay control boxes ' + JSON.stringify({ width, state,
        runner: { node: process.version, platform: process.platform, arch: process.arch }, ...capture }));
      if (classicScrollbar && state === 'end') {
        assert.equal(capture.viewport.scrollbarWidth, 15, `${width}: the fixture uses the measured native 15px classic scrollbar`);
        if (width === 375) assert.ok(capture.viewport.scrollHeight > capture.viewport.clientHeight, `${width}: the final event list needs vertical scrolling`);
      }
      return capture.boxes;
    };
    /** Exercise real browser input and compare control geometry within one viewport. */
    const verifyWidth = async (width) => {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      if (wideFonts) {
        await chrome.stable(`(() => {
          const sheet = document.styleSheets[0];
          sheet.insertRule('.snapshot-controls, .snapshot-controls * { letter-spacing: .12em !important; }', sheet.cssRules.length);
        })()`);
        const spacing = JSON.parse(await chrome.stable(`JSON.stringify(
          ['#snapshot-controls', '#replay-play', '#replay-pause', '#replay-speed', '#replay-progress']
            .map(selector => getComputedStyle(document.querySelector(selector)).letterSpacing)
        )`));
        assert.ok(spacing.every(value => Number.parseFloat(value) > 0),
          `${width}: every replay control receives the wide-font fixture`);
      }
      await chrome.stable(`(() => {
        replayPosition(0);
        const speed = document.querySelector('#replay-speed');
        speed.value = '1';
        speed.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const atStart = await readControlBoxes(width, 'start');
      assert.equal(await chrome.stable("document.querySelector('#replay-play').getAttribute('aria-label')"), 'Play',
        `${width}: the start-state label is the short Play label`);
      await press(chrome, "document.querySelector('#replay-play')");
      assert.equal(await chrome.stable('snapshotReplay.playing'), true, `${width}: native Play starts replay`);
      const whilePlaying = await readControlBoxes(width, 'after Play');
      await press(chrome, "document.querySelector('#replay-pause')");
      assert.equal(await chrome.stable('snapshotReplay.playing'), false, `${width}: native Pause pauses replay`);
      const whilePaused = await readControlBoxes(width, 'after Pause');
      await chrome.stable(`(() => {
        replayPosition(snapshotReplay.events.length - 1);
        document.querySelector('#replay-speed').value = '16';
        document.querySelector('#replay-speed').dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await press(chrome, "document.querySelector('#replay-play')");
      assert.equal(await chrome.stable('snapshotReplay.index'), total, `${width}: final Play renders the end state`);
      assert.equal(await chrome.stable('snapshotReplay.playing'), false, `${width}: replay stops at its final event`);
      const atEnd = await readControlBoxes(width, 'end');
      assert.equal(await chrome.stable("document.querySelector('#replay-play').getAttribute('aria-label')"), 'Play from first event',
        `${width}: the end-state label exercises the longer Play text`);
      for (const [state, boxes] of Object.entries({ whilePlaying, whilePaused, atEnd })) {
        assert.deepEqual(boxes, atStart, `${width}: every interactive replay control keeps its box unchanged ${state}`);
      }
    };
    for (const width of (wideFonts ? [375] : [375, 1280])) {
      await verifyWidth(width);
    }
    /** Verify that a larger replay counter cannot move the fixed Play, Pause, and speed tracks. */
    const countLayout = async (index) => {
      await chrome.stable(`(() => {
        snapshotReplay.events = new Array(123456);
        snapshotReplay.index = ${index};
        replayControls();
        return true;
      })()`);
      return JSON.parse(await chrome.stable(`JSON.stringify({
        count: document.querySelector('#replay-progress').textContent,
        boxes: Object.fromEntries(['#replay-play', '#replay-pause', '#replay-speed'].map(selector => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
        }))
      })`));
    };
    const shortCount = await countLayout(0);
    const longCount = await countLayout(1234);
    assert.equal(shortCount.count, 'event 0 of 123,456', 'the initial counter has a short current index and full denominator');
    assert.equal(longCount.count, 'event 1,234 of 123,456', 'the running counter grows to four current-index digits');
    assert.deepEqual(longCount.boxes, shortCount.boxes, 'a growing counter leaves Play, Pause, and speed in their original boxes');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
    rmSync(profile, { recursive: true, force: true });
  }
};

test('the replay controls don\'t move when the replay starts [A10,C7]', { timeout: 60_000 }, // budget: hang-only ceiling for two viewport geometry passes.
  replayControlsStayPut());

test('the replay controls hold their place at 375 with wide fonts [A10,C7]', { timeout: 60_000 }, // budget: hang-only ceiling for one viewport geometry pass.
  replayControlsStayPut(true));

test('the replay controls hold their place with a classic scrollbar [A10,C7]', { timeout: 60_000 }, // budget: hang-only ceiling for two viewport geometry passes.
  replayControlsStayPut(false, true));
