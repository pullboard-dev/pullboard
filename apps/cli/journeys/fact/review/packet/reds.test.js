/** A gate red only in cases main fails by name stores its review packet, with those reds kept apart [V4,C7]. */
import '../../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/submit/red.js';
import { cli } from '../../../../tests/fixtures/submit/red.js';
import { source } from '../../../../tests/fixtures/submit/red.js';
import { BIN } from '../../../../tests/fixtures/submit/red.js';
import { runFixtureChild } from '../../../../tests/fixtures/child.js';

/** The folder where the board keeps one item's review packets. */
function packetDir(box) {
  return join(box.root, '.git', 'pullboard', 'review-packets', String(box.item));
}

test("clause 1: a submit red only on main's named reds gets a review packet [V4,C7]", { timeout: 240_000 }, t => {
  const box = fixture(t);
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const report = JSON.parse(submitted.stdout);
  assert.equal(report.gate.green, false, 'the proof stays red: its only red is the case main also fails');
  assert.equal(report.gate.knownMainFailures.main, box.main);
  const stored = readdirSync(packetDir(box)).filter(name => name.endsWith('.json'));
  assert.deepEqual(stored, [`${report.commit}.json`], 'the board stores the packet at the submitted head');
  const packet = JSON.parse(readFileSync(join(packetDir(box), stored[0]), 'utf8'));
  assert.equal(packet.head, report.commit);
  assert.equal(packet.gate, 'red only in main reds');
  assert.deepEqual(packet.failures, [], "main's named reds are not listed as the item's own failures");
  assert.equal(packet.excusedMainReds.length, 1, JSON.stringify(packet.excusedMainReds));
  const [red] = packet.excusedMainReds;
  assert.deepEqual({ file: red.file, name: red.name, main: red.main, repair: red.repair },
    { file: 'test/inherited.test.js', name: 'shared failure [G1]', main: box.main, repair: box.rework });
  assert.match(red.mainReceipt ?? '', /^[a-f0-9-]{36}$/u, `the excused red names its main receipt: ${JSON.stringify(red)}`);
  const receipt = JSON.parse(readFileSync(join(box.root, '.git', 'pullboard', 'gate-receipts', `${red.mainReceipt}.json`), 'utf8'));
  assert.equal(receipt.kind, 'main-red');
  assert.equal(receipt.head, box.main, 'the main receipt ran the known main commit');
  assert.ok(receipt.failures.some(row => row.file === red.file && row.name === red.name), 'the main receipt records that exact case failing');
  const shown = cli(box, box.root, 'show', String(box.item), '--review');
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.equal(JSON.parse(shown.stdout).excusedMainReds[0].mainReceipt, red.mainReceipt, 'show --review reads the stored packet');
  const text = runText(box, ['show', String(box.item), '--review']);
  const clauses = text.indexOf('clauses:');
  const heading = text.indexOf('excused main reds');
  assert.ok(clauses >= 0 && heading > clauses, `the excused reds sit under their own heading after the clauses:\n${text}`);
  assert.match(text.slice(heading), new RegExp(`test/inherited\\.test\\.js :: shared failure \\[G1\\]: red on main ${box.main.slice(0, 12)}, main receipt ${red.mainReceipt.slice(0, 8)}`, 'u'));
  assert.match(text, /failures at head: none/u, 'the item itself shows no failure of its own');
});

test('clause 2: any other red still has no packet [V4,C7]', { timeout: 240_000 }, t => {
  const box = fixture(t, { candidate: source('shared failure [G1]') + source('new item failure [G1]').split('\n').slice(2).join('\n') });
  const refused = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'GATE_RED', 'a case main does not fail by name refuses the submit');
  assert.equal(existsSync(packetDir(box)), false, 'no review packet is stored for that head');
  const shown = cli(box, box.root, 'show', String(box.item), '--review');
  assert.equal(shown.status, 1, shown.stdout + shown.stderr);
  assert.equal(JSON.parse(shown.stdout).error.code, 'NO_REVIEW_PACKET', 'show --review builds no packet for the red head either');
});

/** The plain-text output of one real CLI command, read the way a reviewer reads the packet. */
function runText(box, args) {
  const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
