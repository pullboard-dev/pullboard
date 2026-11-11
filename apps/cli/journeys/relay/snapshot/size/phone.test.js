// pullboard: browser
/** @pullboard-test-gui */
/** The phone opens a thirty-thousand-event board inside its first-paint budget and streams all sealed history [H5,H15,H17]. */
import { nativeBoardPorts as relayPresentationNativePorts } from '../../../../../lib/index.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { test } from 'node:test';
import { relaySnapshot } from '../../../../../../packages/pages/index.js';
import { findChromeExecutable } from '../../../../tests/fixtures/relay/browser.js';
import {
  assertFirstPaint,
  openOnPhone,
  plainTables,
  thirtyThousandBoard,
} from '../../../../tests/fixtures/relay/sealed-client.js';

/** Bind the real canonical presentation providers once for this test module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

test('thirty thousand events open on the phone within three seconds and stream all sealed history beside live moves [H5,H15,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const { box, pairing, second, currentMarker, oldestMarker, liveMarker, oldest, before, uploadedStatus, link, writes, uploaded, cipherBytes, headers, headResponse, head, key, context, root, heldPage } = await thirtyThousandBoard(t);
  const { chrome, first } = await openOnPhone(t, { box, link, heldPage, currentMarker });
  assert.equal(first.phone, 'phone'); assertFirstPaint(t, first, 'the 30k open');
  assert.equal(first.loopbackReads, 0); assert.equal(first.progress.complete, false);
  // Budget: this fixture streams thirty thousand historical records before reaching its deliberately held oldest event leaf.
  const historyStarted = Date.now();
  await chrome.waitFor('window.__phoneTiming.historyHeld', 120_000, 'old history is streaming after the first readable board'); // budget: generous hang ceiling for the held oldest-event-page handshake under suite load; the time is logged, never a throughput claim (#953).
  t.diagnostic(`old history reached its held page ${Date.now() - historyStarted} ms after the first paint at load ${loadavg()[0].toFixed(1)}`);
  try {
    assert.equal((await box.cli('add', box.lane, liveMarker)).code, 0, 'ordinary native moves continue while old history is pinned');
    await chrome.waitFor(`document.querySelector('#chain')?.textContent.includes('${liveMarker}')`, 15_000, 'new current state arrives while an older history page is held'); // budget: hang ceiling for the live-move handshake while old history is held, not a throughput claim.
  } finally {
    await chrome.stable('window.__olderHistoryAllowed = true; window.__releaseOlderHistory?.(); true');
  }
  const expected = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  const finalSequence = Number(expected.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value);
  // Budget: a complete loopback replay includes both the pinned predecessor and its live successor, never the three-second boot bar.
  await chrome.waitFor(`transport.historyProgress('${link.board}').complete && transport.historyProgress('${link.board}').sequence === ${finalSequence}`, 45_000, 'all sealed history is held at the live checkpoint'); // budget: hang ceiling for two complete pinned background streams; the 3s boot bar is measured separately.
  const oldestHash = createHash('sha256').update(oldestMarker).digest('hex');
  const read = await chrome.stable(`(async () => {
    const before = __phoneTiming.objectRequests;
    const reply = await transport.request('/api/v1/boards/${link.board}/shouts/${oldest}');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reply.shout.shout_text)));
    return { hash: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), extraObjectReads: __phoneTiming.objectRequests - before,
      progress: transport.historyProgress('${link.board}'), loopbackReads: __phoneTiming.loopbackReads };
  })()`);
  assert.equal(read.hash, oldestHash); assert.equal(read.extraObjectReads, 0, 'the oldest shout is already held after the background stream');
  assert.equal(read.progress.loaded, read.progress.total); assert.equal(read.loopbackReads, 0);
  await chrome.stable(`location.hash = '#shout-${oldest}'; true`);
  await chrome.waitFor(`document.body.innerText.includes('${oldestMarker}')`, 3000, 'the actual phone view opens the streamed oldest shout'); // budget: hang ceiling for the addressed-shout render handshake after history completion.
  assert.equal((await second.cli('status')).code, 0, 'an independent paired CLI restores the same paged checkpoint');
  const restored = await second.cli('export');
  assert.equal(restored.code, 0);
  const nativeDigest = value => createHash('sha256').update(JSON.stringify(plainTables(value))).digest('hex');
  assert.equal(nativeDigest(restored.document.tables), nativeDigest(expected.tables), 'every native row, counter and receipt is retained');
  const metrics = { firstPaintMs: first.firstBoardPaint, events: expected.tables.event.length, uniqueCipherBytes: cipherBytes,
    largestUploadBody: Math.max(...writes.map(row => row.request.byteLength)), currentSnapshotBytes: root.links[0].bytes,
    progress: read.progress, oldestHash, nativeTablesHash: nativeDigest(expected.tables) };
  t.diagnostic(JSON.stringify(metrics));
  if (process.env.PULLBOARD_RELAY_PAGE_PROOF) {
    const output = process.env.PULLBOARD_RELAY_PAGE_PROOF;
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n', { mode: 0o600 });
    const screenshot = await chrome.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, 'oldest-shout-phone.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  }
});
