// pullboard: browser
/** @pullboard-test-gui */
/** Paused size and quota limits do not re-seal history or repeat notices across commands [H15,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { PROOF_RUN_ENGINE } from '../../../../../packages/state/light.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import {
  findChromeExecutable,
  startChrome,
} from '../../../tests/fixtures/relay/browser.js';
import { stableChrome } from '../../../tests/fixtures/cockpit/stable.js';

/** Read private pending metadata without including ciphertext or credentials in an assertion diagnostic. */
function state(box) { return JSON.parse(readFileSync(box.linkFile, 'utf8')); }

/** A real cryptographic counter distinguishes no re-seal from merely discarding a freshly generated snapshot. */
async function pausedCrypto(box) {
  return box.script(`
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    let encryptions = 0;
    crypto.subtle.encrypt = (...args) => { encryptions++; return original(...args); };
    const { syncRelay } = await import(${JSON.stringify(new URL('../../../../../packages/link/index.js', import.meta.url).href)});
    const { nativeBoardPorts, openBoard } = await import(${JSON.stringify(new URL('../../../../lib/src/logic/native.js', import.meta.url).href)});
    const lines = [], outbox = await import(${JSON.stringify(new URL('../../../../../packages/outbox/index.js', import.meta.url).href)});
    const { replay: replayConflictRecord, ACKNOWLEDGED_OPERATIONS, outboxQueueable, ...outboxDoors } = outbox;
    const io = { ...outboxDoors, replayConflictRecord, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }), openBoard, nativeBoardPorts, err(line) { lines.push(line); } };
    await syncRelay(process.cwd(), io);
    await syncRelay(process.cwd(), io);
    console.log(JSON.stringify({ encryptions, notices: lines.filter(line => /relay (?:checkpoint )?paused/u.test(line)).length }));
  `);
}

test('a size-paused baseline keeps its cipher, warns once per session and resumes with all local moves after API2 [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi('bad-route');
  box.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'the body exceeds 14000000 bytes; send a smaller snapshot' });
  const linked = await box.link();
  assert.equal((linked.document.diagnostics ?? []).filter(line => /relay paused/u.test(line)).length, 1);
  const saved = state(box).snapshot.sealed;
  const puts = () => box.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length;
  const before = puts();
  const probe = await pausedCrypto(box);
  assert.equal(probe.code, 0); assert.equal(probe.document.encryptions, 0); assert.equal(probe.document.notices, 0);
  assert.equal((await box.cli('shout', 'all', 'local work while size is paused')).code, 0);
  assert.equal((await box.cli('status')).code, 0);
  assert.equal(state(box).snapshot.sealed === saved, true, 'blocked commands retain exact durable pending ciphertext');
  assert.equal(puts(), before, 'small capabilities probes replace failed whole-board uploads');
  const originalSession = box.env.TERM_SESSION_ID;
  box.env.TERM_SESSION_ID = 'another-private-terminal-session';
  const newSession = await box.cli('status');
  assert.equal((newSession.document.diagnostics ?? []).filter(line => /relay paused/u.test(line)).length, 1);
  box.env.TERM_SESSION_ID = originalSession;
  box.legacySnapshotApi(false); box.rejectSnapshots(null);
  assert.equal((await box.cli('status')).code, 0);
  const resumed = state(box);
  assert.equal(resumed.baselinePause, undefined); assert.equal(resumed.snapshot, undefined); assert.equal(resumed.snapshotApiVersion, 2);
  const exported = await box.cli('export');
  assert.equal(exported.code, 0);
  assert.ok(exported.document.tables.shout.some(row => row.shout_text === 'local work while size is paused'));
  assert.equal(box.moveAcks.length, 0, 'all paused local work belongs to the fresh accepted baseline');
  assert.equal((await box.cli('shout', 'all', 'first ordered move after upgrade')).code, 0);
  assert.deepEqual(box.moveAcks.map(row => row.event_id), [1]);
});

test('quota-paused checkpoints keep exact pending bytes, permit ordered moves and resume after an operator quota change [H15,H17]', async t => {
  const box = await relayClientFixture(t, { accountStorageBytes: 256_000 });
  await box.link();
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  // A large shout from before the 400-character limit (#1109), as an upgraded board holds it.
  board.executionEngineVersion = PROOF_RUN_ENGINE - 1;
  try { store.shout(board, { from: 'coordinator', to: 'all', lanes: [box.lane], text: randomBytes(300_000).toString('base64') }); }
  finally { store.closeBoard(board); }
  const refused = await box.cli('status');
  assert.equal(refused.code, 0);
  const saved = state(box);
  assert.equal(saved.checkpointRefusal.code, 'ACCOUNT_STORAGE_LIMIT');
  assert.equal(refused.document.relay.storage.limitBytes, 256_000);
  await t.test('the actual phone names the exhausted account quota before any newer checkpoint [H15,H17]', {
    skip: !findChromeExecutable() && 'Chrome is not installed',
  }, async phoneTest => {
    const chrome = await stableChrome(await startChrome()); phoneTest.after(() => chrome.close());
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax' });
    await chrome.navigate(box.origin + '/#board=' + saved.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
    await chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('relay storage limit')", 3000, 'the account quota is visible on the phone'); // budget: hang ceiling for the account-notice render handshake, not a throughput claim.
    const notice = await chrome.stable("document.querySelector('#relay-notice').textContent");
    assert.ok(notice.includes(saved.storage.account.login));
    assert.match(notice, /0\.3 MB relay storage limit/u);
    if (process.env.PULLBOARD_RELAY_PAGE_PROOF) {
      mkdirSync(process.env.PULLBOARD_RELAY_PAGE_PROOF, { recursive: true, mode: 0o700 });
      const screenshot = await chrome.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.PULLBOARD_RELAY_PAGE_PROOF, 'quota-phone.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
    }
  });
  const probe = await pausedCrypto(box);
  assert.equal(probe.code, 0); assert.equal(probe.document.encryptions, 0); assert.equal(probe.document.notices, 0);
  assert.equal((await box.cli('shout', 'all', 'ordered move while checkpoint quota is paused')).code, 0);
  assert.deepEqual(box.moveAcks.map(row => row.event_id), [1]);
  assert.equal(state(box).checkpoint.sealed === saved.checkpoint.sealed, true);
  assert.equal(saved.snapshotApiVersion, 2, 'the native quota refusal occurred during a real bounded-page upload');
  const staged = await box.script(`
    const { createRelayPageCache, snapshotSourceId } = await import(${JSON.stringify(new URL('../../../../../packages/pages/index.js', import.meta.url).href)});
    const { readFileSync } = await import('node:fs');
    const link = JSON.parse(readFileSync(${JSON.stringify(box.linkFile)}, 'utf8'));
    const cache = createRelayPageCache(link);
    try { console.log(JSON.stringify({ root: cache.job(snapshotSourceId(link.checkpoint.sealed)).reference.id })); }
    finally { cache.close(); }
  `);
  assert.equal(staged.code, 0);
  const priorWrites = box.transit.length;
  box.setStorageQuota(3_000_000);
  assert.equal((await box.cli('status')).code, 0);
  const attempts = box.transit.slice(priorWrites).filter(row => row.method === 'POST' && row.path.endsWith('/publish'));
  assert.ok(attempts.length >= 1);
  assert.equal(JSON.parse(attempts[0].request).root.id, staged.document.root, 'recovery publishes the retained checkpoint graph before sealing newer state');
  assert.equal((await box.cli('status')).code, 0);
  assert.equal(state(box).checkpointRefusal, undefined); assert.equal(state(box).checkpoint, undefined);
  assert.equal(state(box).storage.limitBytes, 3_000_000);
  const exported = await box.cli('export');
  assert.equal(exported.code, 0);
  assert.equal(exported.document.tables.shout.filter(row => row.shout_text === 'ordered move while checkpoint quota is paused').length, 1);
});
