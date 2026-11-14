// pullboard: browser
/** @pullboard-test-gui */
/** The reply box inside an open Shouts thread: it names who it reaches, keeps a draft across a live refresh and sends [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';

test('a thread reply box says who it reaches, keeps its draft across a refresh and sends to the item [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the reply box check.');
  const box = machine();
  const demo = project(box, 'reply-box');
  await box.inProcess(demo.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(demo.web, 'claim', '1');
  await box.inProcess(demo.web, 'shout', '--item', '1', 'Started on the greeting.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-reply-box-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 1');
    await press(chrome, 'document.querySelector("[data-tab=shouts]")');
    await chrome.waitFor('!!document.querySelector("#feed [data-shout-thread=\\"item:1\\"]")');
    assert.equal(await chrome.stable('document.querySelector("#feed [data-reply]")'), null, 'no reply box until a thread is open');
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      if (!(await chrome.stable('!!document.querySelector("#feed .sx-tp")'))) await press(chrome, 'document.querySelector("#feed [data-shout-thread=\\"item:1\\"]")');
      await chrome.waitFor('!!document.querySelector("#feed [data-reply] input")');
      const reply = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const form = document.querySelector('#feed [data-reply]'), input = form.querySelector('input'), r = form.getBoundingClientRect();
        return { placeholder: input.placeholder, reach: form.querySelector('.sx-reach')?.textContent ?? null, send: form.querySelector('.sx-send').textContent, height: r.height,
          page: document.documentElement.scrollWidth, viewport: innerWidth, inside: r.right <= document.querySelector('#feed .sx-tp').getBoundingClientRect().right + 1 };
      })())`));
      assert.equal(reply.placeholder, 'Reply on #1');
      assert.equal(reply.send, 'Reply');
      assert.ok(reply.page <= reply.viewport && reply.inside, `${width}: the reply box stays inside its thread: ${JSON.stringify(reply)}`);
      assert.ok(reply.height >= (width < 900 ? 44 : 32), `${width}: the reply box is a target: ${reply.height}`);
      if (width >= 900) assert.equal(reply.reach, 'reaches its builder, reviewer and coordinator');
    }
    // A half-typed reply survives a live refresh and keeps its focus.
    await press(chrome, 'document.querySelector("#feed [data-reply] input")');
    await chrome.send('Input.insertText', { text: 'Half a thought' });
    await box.inProcess(demo.web, 'shout', '--item', '1', 'A second note arrives.');
    await chrome.waitFor('[...document.querySelectorAll("#feed .sx-msg .sx-tx")].some((node) => node.textContent === "A second note arrives.")', 15_000); // budget: hang ceiling for the live refresh to bring the new shout; no throughput claim.
    assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify([document.querySelector("#feed [data-reply] input").value, document.activeElement === document.querySelector("#feed [data-reply] input")])')), ['Half a thought', true],
      'the draft and its focus survive a refresh');
    // Sending reaches the item's audience and clears the box.
    await press(chrome, 'document.querySelector("#feed [data-reply] .sx-send")');
    await chrome.waitFor('data.project.shouts.some((shout) => shout.shout_from === "person" && shout.shout_to === "item:1" && shout.shout_text === "Half a thought")', 15_000); // budget: hang ceiling for the sent shout to be recorded; no throughput claim.
    await chrome.waitFor('document.querySelector("#feed [data-reply] input").value === ""');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
