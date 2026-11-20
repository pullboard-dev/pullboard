/** A candidate stacked on an unverified item is refused cheaply, before any cell scan or gate [V4,V17,C7]. */
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARK } from '../../fixtures/submit/fail.js';
import { inProcess } from '../../fixtures/submit/fail.js';
import { project } from '../../fixtures/submit/fail.js';
import { submitAndSettle } from '../../fixtures/submit/fail.js';
import { commitAll } from '../../fixtures/submit/gate.js';
import { put } from '../../fixtures/submit/gate.js';

test('cli.journeys-submit-fail-gate-stacked.submit-precheck-refuses-a-candidate-stacked: submit precheck refuses a candidate stacked on an unverified item without scanning cells or running a gate [V4,V17,C7]', async t => {
  const { box, markers } = await project(t);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): the first item changes the source [G1]');
  const first = await submitAndSettle(t, box);
  assert.equal(first.gate?.green, true, JSON.stringify(first.gate));
  const firstCommit = JSON.parse((await inProcess(box, box.root, 'show', '1', '--json')).out).item_commit;
  assert.match(firstCommit, /^[0-9a-f]{40}$/u);
  const added = await inProcess(box, join(box.dir, 'repo'), 'add', 'build', 'Stacked fixture', '--criterion', 'the stacked change is refused cheaply', '--check', MARK(markers.item), '--wait', '--accept-green', 'the fixture check keeps passing', '--not-duplicate-of', '1 fail fast fixture');
  assert.equal(added.code, 0, added.out + added.err);
  assert.equal((await inProcess(box, box.root, 'claim', '2')).code, 0);
  put(box.root, 'src/b.js', 'export const other = 1;\n');
  commitAll(box, 'feat(core): the stacked item adds a source [G1]');
  // Only runs from here on count: the first submit and the second add ran the markers on purpose.
  for (const path of Object.values(markers)) rmSync(path, { force: true });
  const receiptDir = join(box.dir, 'repo', '.git', 'pullboard', 'gate-receipts');
  const receipts = () => existsSync(receiptDir) ? readdirSync(receiptDir).sort() : [];
  const before = receipts();
  const result = (await inProcess(box, box.root, 'submit', '2', '--precheck', '--json'));
  assert.equal(result.code, 1, result.out + result.err);
  const error = JSON.parse(result.out).error;
  assert.equal(error.code, 'STACKED_ON_UNVERIFIED', result.out);
  assert.ok(error.message.includes(firstCommit), error.message);
  assert.doesNotMatch(result.out + result.err, /submit cells inventory|submit cells:/u, 'the stack refusal precedes any cell scan');
  assert.deepEqual(receipts(), before, 'precheck writes no gate receipt');
  for (const marker of Object.values(markers)) assert.equal(existsSync(marker), false, 'no check or gate ran');
});
