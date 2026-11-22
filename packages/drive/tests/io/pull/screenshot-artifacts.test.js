/** Actual pull checkouts deliver bounded screenshot bytes through authenticated receipts [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { verify } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { testGit as pullGit } from '../../fixtures/git.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=';
// A policy port fixture; the CLI composition test binds this port to the runners cell's actual policy.
const screenshotPolicy = { directory: 'screenshots', maxBytes: 4 * 1024 ** 2, screenshotPlan(files, maxBytes) {
  const plan = files.filter(row => row.path.endsWith('.png'));
  if (plan.reduce((sum, row) => sum + row.bytes, 0) > maxBytes) throw new Error('over cap');
  return plan;
} };
const payload = receipt => Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'signature'))));
const verified = (receipt, key) => verify(null, payload(receipt), key, Buffer.from(receipt.signature, 'base64url'));

/** Run the real pull lifecycle against a local Git trunk and retain only queue calls. */
async function produce(t, { size = 0, status = 0, mode = 'png', reuse = false } = {}) {
  const { root: trunk } = privateFixtureFiles('pull-screenshot-trunk-');
  const { root: cache } = privateFixtureFiles('pull-screenshot-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'file.txt'), 'one\n'); sh('add', '.'); sh('commit', '-qm', 'one');
  const commit = sh('rev-parse', 'HEAD'), calls = [];
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey;
  const script = `const fs=require('node:fs'),path=require('node:path');
    const folder=path.join(process.cwd(),'screenshots');
    if (${JSON.stringify(mode)} !== 'missing') {
      fs.mkdirSync(folder); const png=Buffer.from(${JSON.stringify(PNG)},'base64');
      if (${JSON.stringify(mode)} === 'symlink') { fs.writeFileSync(path.join(process.cwd(),'outside.png'),png); fs.symlinkSync('../outside.png',path.join(folder,'link.png')); }
      else if (['root-link','parent-link'].includes(${JSON.stringify(mode)})) { const outside=path.join(process.cwd(),'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside,'not-a-screenshot.png'),png); if (${JSON.stringify(mode)} === 'root-link') { fs.rmdirSync(folder); fs.symlinkSync('outside',folder); } else fs.symlinkSync('../outside',path.join(folder,'linked')); }
      else { for(const name of ['a.png','b.png']) { const bytes=Buffer.alloc(${size} || png.length); png.copy(bytes); fs.writeFileSync(path.join(folder,name),bytes); } }
    }
    console.log('PULLBOARD_GATE_RECEIPT '+JSON.stringify({version:1,green:${status === 0},phases:[{status:${status},tail:'test output'}]})); process.exitCode=${status};`;
  let claimed = 0, cleaned = false;
  const stop = new AbortController();
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body); calls.push({ ...call, bodyBytes: Buffer.byteLength(body) });
    let reply = { recorded: true, renewed: true };
    if (call.action === 'claim') { claimed++; reply = { trunk, claim: claimed > (reuse ? 2 : 1) ? null : { job: `test:screenshots-${claimed}`, kind: 'test', needs: [], candidate: commit, base: commit, attempt: 1, token: 'held' } }; }
    if (call.action === 'request') reply = { request: { run: [process.execPath, '-e', reuse && claimed === 2 ? script.replaceAll(JSON.stringify(mode), JSON.stringify('missing')) : script], input: { main: commit, data: { completionNonce: 'a'.repeat(48) } } } };
    if (call.action === 'receipt' && reuse && claimed === 2) stop.abort();
    return { status: 200, json: async () => reply };
  };
  await serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b?k=x', runner: 'screenshot-runner', capabilities: [], cache, once: !reuse, jobs: 1, signal: stop.signal, fetchImpl, trunkPack: async () => {}, say: () => {}, screenshotPolicy,
    signCompletion: fields => { const receipt = { ...fields, host: 'screenshot-runner' }; return { ...receipt, signature: sign(null, payload(receipt), privateKey).toString('base64url') }; },
    removeFolder: folder => { // Remove the screenshots at cleanup: the posted bytes must already be captured.
      if (!reuse) for (const name of readdirSync(join(cache, 'work'))) rmSync(join(cache, 'work', name, 'screenshots'), { recursive: true, force: true });
      cleaned = true; rmSync(folder, { recursive: true, force: true });
    } });
  const receipts = calls.filter(call => call.action === 'receipt').map(call => call.receipt), receipt = receipts.at(-1);
  const parts = calls.filter(call => call.action === 'receiptPart');
  const text = parts.sort((a, b) => a.part.index - b.part.index).map(call => call.part.text).join('');
  const gate = parts.length ? JSON.parse(text) : receipt.gate;
  return { receipt, gate, parts, calls, cleaned, key, text, receipts };
}

test('drive.screenshot-artifacts.full-set-authenticated: clause 1: actual checkout PNGs at the full existing 4 MiB cap survive cleanup, use receipt parts under API cap and bind decoded hashes to signed completion on green and red [C7]', { timeout: 120_000 }, async t => {
  for (const status of [0, 1]) {
    const { receipt, gate, parts, calls, cleaned, key, text } = await produce(t, { size: 2 * 1024 ** 2, status });
    const expected = Buffer.alloc(2 * 1024 ** 2); Buffer.from(PNG, 'base64').copy(expected);
    assert.equal(cleaned, true);
    assert.equal(receipt.status, status); assert.equal(gate.green, status === 0);
    assert.ok(parts.length > 1); assert.ok(calls.every(call => call.bodyBytes < 100_000));
    assert.equal(receipt.gateParts.sha256, hash(text)); assert.equal(receipt.gateParts.bytes, Buffer.byteLength(text));
    assert.deepEqual(gate.screenshots.map(row => row.path).sort(), ['screenshots/a.png', 'screenshots/b.png']);
    assert.equal(gate.screenshots.reduce((sum, row) => sum + row.bytes, 0), 4 * 1024 ** 2);
    for (const row of gate.screenshots) { const bytes = Buffer.from(row.base64, 'base64'); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256); assert.equal(row.sha256, hash(expected), 'receipt bytes match the independently constructed job input'); }
    assert.equal(gate.screenshotsSha256, hash(JSON.stringify(gate.screenshots)));
    assert.equal(receipt.signedCompletion.screenshotsSha256, gate.screenshotsSha256);
    assert.equal(verified(receipt.signedCompletion, key), true);
    assert.equal(verified({ ...receipt.signedCompletion, screenshotsSha256: '0'.repeat(64) }, key), false);
    assert.equal(Object.hasOwn(receipt.signedCompletion, 'screenshots'), false, 'completion carries metadata only');
  }
});

test('drive.screenshot-artifacts.absent-link-and-over-cap: clause 1: missing screenshots, symlinks and sets above the unchanged cap yield no screenshot artifact and preserve the job result [C7]', { timeout: 120_000 }, async t => {
  for (const options of [{ mode: 'missing' }, { mode: 'symlink' }, { mode: 'root-link' }, { mode: 'parent-link' }, { size: 2 * 1024 ** 2 + 1 }]) {
    const { gate, receipt } = await produce(t, options);
    assert.equal(gate.green, true); assert.equal(receipt.status, 0);
    assert.equal(Object.hasOwn(gate, 'screenshots'), false);
    assert.equal(Object.hasOwn(gate, 'screenshotsSha256'), false);
    assert.equal(Object.hasOwn(receipt.signedCompletion, 'screenshotsSha256'), false);
  }
  const { receipts } = await produce(t, { reuse: true });
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].gate.screenshots.length, 2);
  assert.equal(receipts[1].startup.reused, true, 'the second job uses the same real checkout slot');
  assert.equal(Object.hasOwn(receipts[1].gate, 'screenshots'), false, 'checkout clean removes the previous job screenshots before collection');
});
