/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/**
 * A child-process listen denial reads as sandbox blocked, with or without an explanatory message [C7,B26]
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitSettled } from './local.js';
import { childFailureSubmitBox } from '../../../tests/fixtures/submit/child-box.js';
import { childListenerTestSource } from '../../../tests/fixtures/submit/child-box.js';

test('a child process listen denial reads as sandbox blocked [C7,B26]', async (t) => {
  const explanatory = "  assert.equal(child.status, 0, `App exited before listening (code ${child.status}, signal ${child.signal}):\\n${child.stderr}`);";
  const original = childListenerTestSource();
  assert.equal(original.split(explanatory).length, 2, 'replace exactly one explanatory message');
  const box = await childFailureSubmitBox(t, original);
  const bareBox = await childFailureSubmitBox(t, original.replace(explanatory, '  assert.equal(child.status, 0, child.stderr);'));
  const [result, bare] = await Promise.all([box, bareBox].map(one => submitSettled(t, one, (...args) => one.run(...args))));
  const output = `${result.out}\n${result.err}`;
  assert.equal(result.code, 1, output);
  assert.match(output, /SANDBOX_BLOCKED/u, 'submit names the denied child-process listen');
  assert.match(output, /listen \(EPERM\)/u);
  assert.doesNotMatch(output, /GATE_RED/u);

  const bareOutput = `${bare.out}\n${bare.err}`;
  assert.equal(bare.code, 1, bareOutput);
  assert.match(bareOutput, /SANDBOX_BLOCKED/u, 'bare stderr with structured fatal fields still names the denial');
  assert.match(bareOutput, /listen \(EPERM\)/u);
  assert.doesNotMatch(bareOutput, /GATE_RED/u);
});
