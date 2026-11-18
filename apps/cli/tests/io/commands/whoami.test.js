/** whoami warns when PULLBOARD_MODEL differs from the seat's recorded model, and keeps the recorded model [C7,#11018]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const box = e2e.project();

/** Run `pullboard whoami --json` in the joined seat with PULLBOARD_MODEL set to `model` (or unset for null). */
async function whoami(model) {
  const saved = box.env.PULLBOARD_MODEL;
  if (model === null) delete box.env.PULLBOARD_MODEL; else box.env.PULLBOARD_MODEL = model;
  try {
    const run = await box.runLocal(box.web, 'whoami', '--json');
    assert.equal(run.code, 0, run.err + run.out);
    const text = await box.runLocal(box.web, 'whoami');
    return { json: JSON.parse(run.out), text: text.out };
  } finally { box.env.PULLBOARD_MODEL = saved; }
}

test('cli.io-commands-whoami.warns-on-model-mismatch: clause 1: whoami prints one line naming both models and the worktree command when PULLBOARD_MODEL differs, and --json carries modelMismatch [C7]', async () => {
  const { json, text } = await whoami('another-model');
  const lines = text.split('\n').filter(line => line.includes('differs from this seat'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /another-model/);
  assert.match(lines[0], /pullboard worktree \S+ --model another-model/);
  assert.deepEqual(json.modelMismatch, { env: 'another-model', seat: json.model });
});

test('cli.io-commands-whoami.silent-when-models-match: clause 1: whoami prints nothing extra and --json has no modelMismatch when the models match or the variable is unset [C7]', async () => {
  const matching = await whoami(box.env.PULLBOARD_MODEL);
  assert.ok(!matching.text.includes('differs'));
  assert.equal(matching.json.modelMismatch, undefined);
  const unset = await whoami(null);
  assert.ok(!unset.text.includes('differs'));
  assert.equal(unset.json.modelMismatch, undefined);
});

test('cli.io-commands-whoami.keeps-recorded-model: clause 2: whoami still names the recorded model when the variable differs [C7]', async () => {
  const { json } = await whoami('another-model');
  assert.notEqual(json.model, 'another-model');
  assert.equal(json.model, box.env.PULLBOARD_MODEL);
});
