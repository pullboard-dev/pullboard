/** A runner posts a pulled gate's receipt line of any length: whole, as receiptPart calls when it is over one call (#10774) [C7,P7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const FILES = Array.from({ length: 2000 }, (_, n) => `packages/store/tests/io/queued/red/case-${n}.test.js`);
const BIG = { version: 1, green: false, proofPlan: { runner: 'node --test', files: FILES, cores: 12, account: true } };

/** Serve one pulled gate job whose run prints `gate` as its receipt line in 4 KiB writes; every queue call body is kept. refuseParts: the board answers receiptPart JOB_ACTION. */
async function serveGate(t, gate, { refuseParts = false } = {}) {
  const { root: trunk } = privateFixtureFiles('pullboard-receipt-parts-');
  const { root: cache } = privateFixtureFiles('pullboard-receipt-parts-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'file.txt'), 'one\n');
  sh('add', '.'); sh('commit', '-q', '-m', 'one');
  const commit = sh('rev-parse', 'HEAD');
  const text = `noise before the receipt\nPULLBOARD_GATE_RECEIPT ${JSON.stringify(gate)}\n`;
  const script = `const text = ${JSON.stringify(text)}; for (let at = 0; at < text.length; at += 4096) process.stdout.write(text.slice(at, at + 4096)); process.exitCode = 1;`;
  const calls = [];
  let claimed = false;
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    calls.push({ call, bytes: Buffer.byteLength(body) });
    let reply = { recorded: true };
    if (call.action === 'claim') {
      reply = claimed ? { claim: null } : { trunk, claim: { job: 'gate:parts', kind: 'gate', needs: [], candidate: commit, base: commit, attempt: 1, token: 'r:1' } };
      claimed = true;
    } else if (call.action === 'request') reply = { request: { run: [process.execPath, '-e', script], input: { main: commit } } };
    else if (call.action === 'renew') reply = { renewed: true };
    else if (call.action === 'receiptPart' && refuseParts) return { status: 400, json: async () => ({ error: { code: 'JOB_ACTION', message: 'a job queue call names its action' } }) };
    return { status: 200, json: async () => reply };
  };
  const said = [];
  await serveRunner({ git: pullGit, board: BOARD, runner: 'r-parts', capabilities: [], cache, once: true, fetchImpl, trunkPack: async () => {}, say: line => said.push(line) });
  return { calls: calls.map(row => row.call), bytes: calls.map(row => row.bytes), said };
}

test('drive.receipt-parts.over-64-kib-posts-in-parts: clause 1: a pulled gate receipt line over 100 KiB posts as receiptPart calls, each under the 100,000-byte API body, then a receipt whose gateParts join to the printed gate with every proofPlan file (#10774) [C7,P7]', { timeout: 120_000 }, // budget: one node job and a git checkout.
async t => {
  assert.ok(Buffer.byteLength(JSON.stringify(BIG)) > 100 * 1024, 'the printed receipt is over 100 KiB');
  const { calls, bytes } = await serveGate(t, BIG);
  const parts = calls.filter(call => call.action === 'receiptPart');
  const receipts = calls.filter(call => call.action === 'receipt');
  assert.ok(parts.length > 1, `the receipt went as parts, not one call: ${calls.map(call => call.action).join(' ')}`);
  assert.equal(receipts.length, 1);
  assert.ok(calls.indexOf(receipts[0]) > calls.indexOf(parts.at(-1)), 'the receipt follows its parts');
  assert.ok(Math.max(...bytes) < 100_000, 'every call body fits the board API body');
  const text = parts.sort((a, b) => a.part.index - b.part.index).map(call => call.part.text).join('');
  assert.deepEqual(receipts[0].receipt.gateParts, { count: parts.length, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  assert.equal(receipts[0].receipt.gate, undefined);
  assert.deepEqual(JSON.parse(text), BIG, 'the joined parts are the printed gate whole');
});

test('drive.receipt-parts.small-and-old-board: clause 2: a receipt that fits one call posts as one receipt call, and a board refusing receiptPart with JOB_ACTION gets a red receipt naming the size while the serve still posts (#10774) [C7,P7]', { timeout: 240_000 }, // budget: two node jobs and two git checkouts.
async t => {
  const small = await serveGate(t, { version: 1, green: true, phases: [{ role: 'check', status: 0 }] });
  assert.deepEqual(small.calls.filter(call => call.action.startsWith('receipt')).map(call => call.action), ['receipt']);
  assert.equal(small.calls.find(call => call.action === 'receipt').receipt.gate.green, true);
  const old = await serveGate(t, BIG, { refuseParts: true });
  const posted = old.calls.filter(call => call.action === 'receipt');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].receipt.gate.green, false);
  assert.match(posted[0].receipt.gate.error, /^the gate receipt is \d+ bytes, more than one queue call carries, and this board takes no receiptPart calls/u);
  assert.ok(old.said.some(line => line.startsWith('posted gate:parts')), old.said.join('\n'));
});
