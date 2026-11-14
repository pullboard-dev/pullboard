/** @pullboard-test-input source-tree */
/**
 * A landing-gated submit runs the project's invariant tests [V4,C7].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { test } from 'node:test';
import { runLocal } from '../local.js';
import { submitWithEnv } from '../local.js';
import { project } from '../../../../tests/fixtures/submit/invariants.js';
import { change } from '../../../../tests/fixtures/submit/invariants.js';
import { unstamped } from '../../../../tests/fixtures/submit/invariants.js';

test("a landing-gated submit runs the project's invariant tests [V4,C7]", async (t) => {
  const empty = await project(t);
  change(empty.box);
  const unchanged = await submitWithEnv(t, empty.box, (...args) => runLocal(empty.box, ...args), ['--infra', 'the landing fixture edits its pullboard.json']);
  assert.equal(unchanged.code, 0, unchanged.err);
  assert.equal(existsSync(empty.marker), false, 'the empty default adds no tests');
  unstamped(empty.box);

  const mandatory = await project(t, ['test/invariant.test.js']);
  change(mandatory.box);
  const guarded = await submitWithEnv(t, mandatory.box, (...args) => runLocal(mandatory.box, ...args), ['--infra', 'the landing fixture edits its pullboard.json']);
  assert.equal(guarded.code, 0, guarded.err);
  const guardedReceipt = guarded.receipt;
  assert.equal(guardedReceipt.gate.full, true, 'the selector still reports an uncertain full fallback');
  assert.equal(guardedReceipt.gate.deferred, true);
  assert.deepEqual(guardedReceipt.gate.files, ['test/invariant.test.js'], 'receipt names only the executed invariant subset');
  assert.equal(readFileSync(mandatory.marker, 'utf8'), 'invariant\n', 'global fallback does not run unrelated selected/full tests');
  assert.match(guardedReceipt.gate.report, /submit invariants: test\/invariant\.test\.js; full suite deferred/u);
  unstamped(mandatory.box);

  const red = await project(t, ['test/invariant.test.js'], true);
  change(red.box);
  const refused = await submitWithEnv(t, red.box, (...args) => runLocal(red.box, ...args), ['--infra', 'the landing fixture edits its pullboard.json']);
  assert.notEqual(refused.code, 0, 'a failing configured invariant must refuse the submit');
  // A pulled red begins `proof failed:`; GATE_RED is the inline gate's code.
  assert.match(refused.err, /^proof failed: /u);
  assert.ok(existsSync(red.marker), 'the listed invariant actually ran');
  unstamped(red.box);
});
