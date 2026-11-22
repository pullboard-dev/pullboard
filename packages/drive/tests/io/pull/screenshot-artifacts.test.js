/** Actual pull checkouts deliver bounded screenshot bytes through authenticated receipts [C7]. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { signRunnerReceipt } from '../../../../runners/light.js';
import { screenshotPlan, SCREENSHOT_DIRECTORY, SCREENSHOT_MAX_BYTES } from '../../../../runners/light.js';
import { verifyRunnerReceipt } from '../../../../runners/index.js';
import { privateFixtureFiles, runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { testGit as pullGit } from '../../fixtures/git.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=';

/** Run the real pull lifecycle against a local Git trunk and retain only queue calls. */
async function produce(t, { size = 0, status = 0, mode = 'png' } = {}) {
  const { root: trunk } = privateFixtureFiles('pull-screenshot-trunk-');
  const { root: cache } = privateFixtureFiles('pull-screenshot-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'file.txt'), 'one\n'); sh('add', '.'); sh('commit', '-qm', 'one');
  const commit = sh('rev-parse', 'HEAD'), calls = [];
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const script = `const fs=require('node:fs'),path=require('node:path');
    const folder=path.join(process.cwd(),'screenshots');
    if (${JSON.stringify(mode)} !== 'missing') {
      fs.mkdirSync(folder); const png=Buffer.from(${JSON.stringify(PNG)},'base64');
      if (${JSON.stringify(mode)} === 'symlink') { fs.writeFileSync(path.join(process.cwd(),'outside.png'),png); fs.symlinkSync('../outside.png',path.join(folder,'link.png')); }
      else { for(const name of ['a.png','b.png']) { const bytes=Buffer.alloc(${size} || png.length); png.copy(bytes); fs.writeFileSync(path.join(folder,name),bytes); } }
    }
    console.log('PULLBOARD_GATE_RECEIPT '+JSON.stringify({version:1,green:${status === 0},phases:[{status:${status},tail:'test output'}]})); process.exitCode=${status};`;
  let claimed = false, cleaned = false;
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body); calls.push({ ...call, bodyBytes: Buffer.byteLength(body) });
    let reply = { recorded: true, renewed: true };
    if (call.action === 'claim') { reply = { trunk, claim: claimed ? null : { job: 'test:screenshots', kind: 'test', needs: [], candidate: commit, base: commit, attempt: 1, token: 'held' } }; claimed = true; }
    if (call.action === 'request') reply = { request: { run: [process.execPath, '-e', script], input: { main: commit, data: { completionNonce: 'a'.repeat(48) } } } };
    return { status: 200, json: async () => reply };
  };
  await serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b?k=x', runner: 'screenshot-runner', capabilities: [], cache, once: true, fetchImpl, trunkPack: async () => {}, say: () => {}, screenshotPolicy: { screenshotPlan, directory: SCREENSHOT_DIRECTORY, maxBytes: SCREENSHOT_MAX_BYTES },
    signCompletion: fields => { const receipt = { ...fields, host: 'screenshot-runner' }; return { ...receipt, signature: signRunnerReceipt(receipt, privateKey) }; },
    removeFolder: folder => { // Remove the screenshots at cleanup: the posted bytes must already be captured.
      for (const name of readdirSync(join(cache, 'work'))) rmSync(join(cache, 'work', name, 'screenshots'), { recursive: true, force: true });
      cleaned = true; rmSync(folder, { recursive: true, force: true });
    } });
  const receipt = calls.find(call => call.action === 'receipt').receipt;
  const parts = calls.filter(call => call.action === 'receiptPart');
  const text = parts.sort((a, b) => a.part.index - b.part.index).map(call => call.part.text).join('');
  const gate = parts.length ? JSON.parse(text) : receipt.gate;
  return { receipt, gate, parts, calls, cleaned, key, text };
}

test('drive.screenshot-artifacts.full-set-authenticated: clause 1: actual checkout PNGs at the full existing 4 MiB cap survive cleanup, use receipt parts under API cap and bind decoded hashes to signed completion on green and red [C7]', { timeout: 120_000 }, async t => {
  for (const status of [0, 1]) {
    const { receipt, gate, parts, calls, cleaned, key, text } = await produce(t, { size: 2 * 1024 ** 2, status });
    assert.equal(cleaned, true);
    assert.equal(receipt.status, status); assert.equal(gate.green, status === 0);
    assert.ok(parts.length > 1); assert.ok(calls.every(call => call.bodyBytes < 100_000));
    assert.equal(receipt.gateParts.sha256, hash(text)); assert.equal(receipt.gateParts.bytes, Buffer.byteLength(text));
    assert.deepEqual(gate.screenshots.map(row => row.path).sort(), ['screenshots/a.png', 'screenshots/b.png']);
    assert.equal(gate.screenshots.reduce((sum, row) => sum + row.bytes, 0), 4 * 1024 ** 2);
    for (const row of gate.screenshots) { const bytes = Buffer.from(row.base64, 'base64'); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256); }
    assert.equal(gate.screenshotsSha256, hash(JSON.stringify(gate.screenshots)));
    assert.equal(receipt.signedCompletion.screenshotsSha256, gate.screenshotsSha256);
    assert.equal(verifyRunnerReceipt(receipt.signedCompletion, key), true);
    assert.equal(verifyRunnerReceipt({ ...receipt.signedCompletion, screenshotsSha256: '0'.repeat(64) }, key), false);
    assert.equal(Object.hasOwn(receipt.signedCompletion, 'screenshots'), false, 'completion carries metadata only');
  }
});

test('drive.screenshot-artifacts.absent-link-and-over-cap: clause 1: missing screenshots, symlinks and sets above the unchanged cap yield no screenshot artifact and preserve the job result [C7]', { timeout: 120_000 }, async t => {
  for (const options of [{ mode: 'missing' }, { mode: 'symlink' }, { size: 2 * 1024 ** 2 + 1 }]) {
    const { gate, receipt } = await produce(t, options);
    assert.equal(gate.green, true); assert.equal(receipt.status, 0);
    assert.equal(Object.hasOwn(gate, 'screenshots'), false);
    assert.equal(Object.hasOwn(gate, 'screenshotsSha256'), false);
    assert.equal(Object.hasOwn(receipt.signedCompletion, 'screenshotsSha256'), false);
  }
});
