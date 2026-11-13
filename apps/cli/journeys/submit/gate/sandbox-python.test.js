/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/**
 * A Python-style child denial reads as sandbox blocked, with or without an explanatory message [C7,B26]
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitSettled } from './local.js';
import { childFailureSubmitBox } from '../../../tests/fixtures/submit/child-box.js';
import { childPythonTestSource } from '../../../tests/fixtures/submit/child-box.js';

test('a Python-style child denial reads as sandbox blocked [C7,B26]', async (t) => {
  const pythonSource = childPythonTestSource();
  const pythonExplanation = "  assert.equal(child.status, 0, `Child process exited with code ${child.status}:\\n${child.stderr}`);";
  assert.equal(pythonSource.split(pythonExplanation).length - 1, 1, 'the bare Python counter changes exactly one parent message');
  const pythonBox = await childFailureSubmitBox(t, pythonSource, { deniedFile: 'outside-python-denial.txt' });
  const barePythonBox = await childFailureSubmitBox(t, pythonSource.replace(pythonExplanation, '  assert.equal(child.status, 0, child.stderr);'), { deniedFile: 'outside-bare-python-denial.txt' });
  const [python, barePython] = await Promise.all([pythonBox, barePythonBox].map(one => submitSettled(t, one, (...args) => one.run(...args))));
  const pythonOutput = `${python.out}\n${python.err}`;
  assert.equal(python.code, 1, pythonOutput);
  assert.match(python.err, /SANDBOX_BLOCKED/u, 'submit names a scanner-known denial from a child traceback');
  assert.match(python.err, /file access .*\(EACCES\)/u);
  assert.match(python.err, /ask the coordinator to bring (?:it|this operation) to the person/iu);
  assert.match(python.err, /pullboard shout coordinator .*--decision/u);
  assert.doesNotMatch(python.err, /\bask the person\b/iu);
  assert.doesNotMatch(python.err, /GATE_RED/u);

  const barePythonOutput = `${barePython.out}\n${barePython.err}`;
  assert.equal(barePython.code, 1, barePythonOutput);
  assert.match(barePython.err, /SANDBOX_BLOCKED/u, 'complete bare Python stderr still names the known denial');
  assert.match(barePython.err, /file access .*\(EACCES\)/u);
  assert.doesNotMatch(barePythonOutput, /GATE_RED/u);
});
