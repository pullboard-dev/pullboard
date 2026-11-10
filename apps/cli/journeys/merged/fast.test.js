/**
 * `pullboard merged` on a commit already on main records in seconds, whatever its checks cost [C7]. On 9 Nov each hand
 * landing's `merged` waited 15+ minutes on a runner smoke and plan check before writing anything. Here the machine
 * sends every check to a runner that never comes, so a check run before the record would hold the command for minutes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  BIN,
  machine,
  project,
} from '../../tests/fixtures/cockpit/machine.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';

/** The record's ceiling: the 9 Nov target for recording a merge of an on-main commit. */
const RECORD_LIMIT_MS = 5_000;

/** A project with open item 1, main's tip as its hand landing, and a runner-only machine with no runner. */
function handLanded() {
  const box = machine(), alpha = project(box, 'merged-fast');
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'A hand-landed fixture item', check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
    run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  // A runner that is never reachable: any runner check waits out this deadline before it could refuse.
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gateSlots: 1, browserSlots: 1, runners: [], gate: { runnersOnly: true, memoryFloorMB: 0, runnerWaitMs: 600_000 } });
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD');
  /** Run the CLI in the project and time it. */
  const run = (...args) => {
    const started = performance.now();
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: alpha.repo, env: box.env, encoding: 'utf8', timeout: 120_000 });
    return { ...result, ms: performance.now() - started };
  };
  return { box, head, run };
}

test('clause 1: a forced merge of an on-main commit records in under 5 s and runs no check [C7]', { timeout: 180_000 }, async () => {
  const { box, head, run } = handLanded();
  const forced = run('merged', '1', head, '--forced', 'landed by hand');
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.ok(forced.ms < RECORD_LIMIT_MS, `merged --forced took ${Math.round(forced.ms)} ms`); // budget: declared ceiling, the 9 Nov 5 s target for recording a merge.
  assert.equal(JSON.parse(run('show', '1', '--json').stdout).item_merged_commit, head);
  const log = join(box.env.PULLBOARD_MACHINE_HOME, 'merged-checks.log');
  await waitForCondition(() => existsSync(log) && /follow-up (done|red)/u.test(readFileSync(log, 'utf8')), 'the forced follow-up finishes');
  assert.match(readFileSync(log, 'utf8'), /checks skipped: forced/u);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /smoke|plan check/u, 'a forced merge runs no check, before or after the record');
});

test('clause 2: an unforced merge of an on-main commit answers in under 5 s without waiting on a runner check [C7]', { timeout: 180_000 }, () => {
  const { head, run } = handLanded();
  const plain = run('merged', '1', head);
  assert.notEqual(plain.status, 0, 'an unverified item is still refused');
  assert.match(plain.stdout + plain.stderr, /NOT_VERIFIED/u);
  assert.ok(plain.ms < RECORD_LIMIT_MS, `merged took ${Math.round(plain.ms)} ms to answer`); // budget: declared ceiling; before this change it waited on the runner smoke first.
});
