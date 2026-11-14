/** Hidden failures, edited tier manifests and no-op runners stay visible to selection [C7,CS4,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChildTests } from '../../../../../packages/gate/tests/fixtures/child-tests.js';
import { runSubmitGate } from '../../../../../packages/gate/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { executionServices } from '../../../tests/fixtures/gate/execution.js';
import {
  json,
  commit,
  calls,
  fixture,
  build,
} from '../../../tests/fixtures/test/selection.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';

test('hiding a real broken package from the supplied selection fails the run [C7,CS4,V4]', async t => {
  const box = fixture(t), entry = build(box, 'beta', 'broken');
  const actual = runChildTests(['test/beta.test.js'], { cwd: entry.root, env: box.env });
  assert.equal(actual.status, 1, 'the hidden change really breaks its unit contract: ' + actual.stdout + actual.stderr);
  await assert.rejects(runSubmitGate(entry.root, loadConfig(entry.root), { executionServices, base: box.base, trunk: box.base,
    changed: [], check: 'node check.cjs beta', agent: 'web-1', item: String(entry.id) }),
  error => error.code === 'TEST_SELECTION_INCOMPLETE' && error.message.includes('packages/beta/index.js'));
});

test('an edited tier manifest cannot hide a real failing unit [C7,CS4,V4]', async t => {
  const box = fixture(t), entry = build(box, 'beta', 'broken');
  const path = join(entry.root, 'packages/gate/data/tests/tiers.json');
  const hidden = JSON.parse(readFileSync(path, 'utf8'));
  hidden.files = hidden.files.filter(row => row.file !== 'test/beta.test.js');
  writeFileSync(path, JSON.stringify(hidden));
  commit(box, entry.root, 'test: hide the broken unit from declared tiers [G1]');
  const result = await box.runLocal(entry.root, 'submit', String(entry.id), '--no-next', '--json');
  const settled = await settleSubmit(t, box, JSON.parse(result.out));
  assert.notEqual(settled.gate.green, true, 'the hidden unit still fails the pulled gate');
  assert.equal(settled.gate.phases.find(phase => phase.role === 'proof').status, 1);
  assert.deepEqual(calls(box, 'beta'), ['beta:"broken"', 'beta:1'], 'the omitted candidate unit fails and its exact main comparison passes');
  assert.equal(json(box, box.repo, 'show', String(entry.id)).item_status, 'claimed');
});

test('a runner that ignores selected units cannot report a false green [C7,V4]', async t => {
  const box = fixture(t);
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.affectedTests = 'true';
  writeFileSync(path, JSON.stringify(config));
  commit(box, box.repo, 'test: configure a no-op focused runner [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const entry = build(box, 'beta', 'broken');
  // The no-op runner exits 0 with no test account; the pulled gate refuses it by name, as the controller gate does.
  const settled = await settleSubmit(t, box, JSON.parse((await box.runLocal(entry.root, 'submit', String(entry.id), '--no-next', '--json')).out));
  assert.notEqual(settled.gate.green, true, 'a runner that ran none of the selected units is not green');
  const refused = settled.gate.analysis.refusals.find(row => row.code === 'TEST_SELECTION_UNVERIFIED');
  assert.match(refused?.message ?? '', /test\/beta\.test\.js/u, JSON.stringify(settled.gate.analysis.refusals));
  assert.deepEqual(calls(box, 'beta'), []);
  assert.equal(json(box, box.repo, 'show', String(entry.id)).item_status, 'claimed');
});
