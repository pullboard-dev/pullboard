/** With submit.proofOnly on, an all-proof item with every clause ticked submits with no change; off, it is refused EMPTY_SUBMIT [C7,#9105]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proofOnlyTicked } from '../../src/io/empty.js';
import { requireNonEmptySubmit } from '../../src/io/empty.js';
import { runFixtureGit } from '../fixtures/child.js';
import { settingsInventory } from '../../../../packages/config/index.js';
import { runLocal } from '../fixtures/submit/local.js';
import { coordinatorLocal } from '../fixtures/submit/local.js';
import { fixtureSettledMachine } from '../fixtures/testkit.js';
import { builderRepo } from '../fixtures/submit/gate.js';
import { privateRepo } from '../fixtures/submit/gate.js';
import { put } from '../fixtures/submit/gate.js';

/** A claimed item whose clauses are all proof kinds, each ticked, and whose seat holds no commit beyond main. */
async function proofBox(t, { on, kinds = ['command', 'reasoning'] }) {
  let box = privateRepo(t);
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { submit: { proofOnly: Boolean(on) } });
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', shared: ['pullboard.json'] }));
  box = builderRepo(box);
  const criterion = kinds.map((kind, index) => `${index + 1}. The fixture proves part ${index + 1} [${kind}]`).join(' ');
  const added = await coordinatorLocal(box, 'add', 'build', 'Proof only fixture', '--check', 'true', '--criterion', criterion);
  assert.equal(added.code, 0, added.err + added.out);
  const claimed = await runLocal(box, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  return box;
}

/** Tick clause `number` of the fixture item with its declared kind. */
async function tick(box, number, kind) {
  const done = await runLocal(box, 'fact', '1', 'note', `clause ${number} [${kind}]: recorded at the current main`);
  assert.equal(done.code, 0, done.err + done.out);
}

test('cli.io-submit-proof-only.with-submit-proofonly-on-an-item-whose: clause 1: with submit.proofOnly on, an item whose clauses are all command or reasoning and all ticked submits with no diff [C7,#9105]', async (t) => {
  const box = await proofBox(t, { on: true });
  await tick(box, 1, 'command');
  await tick(box, 2, 'reasoning');
  const submitted = await runLocal(box, 'submit', '1', '--json');
  assert.doesNotMatch(submitted.err + submitted.out, /EMPTY_SUBMIT/u);
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const shown = await runLocal(box, 'show', '1');
  assert.match(shown.out, /#1\s+\S+ .*\(in the gate\)|#1\s+(?:submitted|verified)/iu, 'the item went into the gate');
});

test('cli.io-submit-proof-only.with-the-setting-on-a-test-clause: clause 1: with the setting on, a [test] clause or an unticked clause still needs a change [C7,#9105]', async (t) => {
  const withTest = await proofBox(t, { on: true, kinds: ['command', 'test'] });
  await tick(withTest, 1, 'command');
  const refusedTest = await runLocal(withTest, 'submit', '1', '--json');
  assert.notEqual(refusedTest.code, 0);
  assert.match(refusedTest.err + refusedTest.out, /EMPTY_SUBMIT|CLAUSE_UNTICKED/u);
  const unticked = await proofBox(t, { on: true });
  await tick(unticked, 1, 'command');
  const refused = await runLocal(unticked, 'submit', '1', '--json');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /EMPTY_SUBMIT|CLAUSE_UNTICKED/u);
});

test('cli.io-submit-proof-only.with-submit-proofonly-off-the-default-the: clause 2: with submit.proofOnly off, the default, the same item is refused EMPTY_SUBMIT as on main [C7,#9105]', async (t) => {
  const box = await proofBox(t, { on: false });
  await tick(box, 1, 'command');
  await tick(box, 2, 'reasoning');
  const refused = await runLocal(box, 'submit', '1', '--json');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /EMPTY_SUBMIT/u);
});

test('cli.io-submit-proof-only.submit-proofonly-is-a-described-setting-off: clause 2: submit.proofOnly is a described setting, off by default [C7,#9105]', (t) => {
  const box = privateRepo(t);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const row = settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'submit.proofOnly');
  assert.equal(typeof row.default, 'boolean');
  assert.equal(typeof row.value, 'boolean');
  assert.match(row.description ?? '', /empty/u, 'the row carries a description naming an empty submit');
  assert.ok(row.label, 'the row carries a plain label');
});

test('cli.io-submit-proof-only.off-refusal-names-the-setting: clause 1: with submit.proofOnly off, a proof-only item ticked at the head is refused EMPTY_SUBMIT naming submit.proofOnly [C7,#10834]', async (t) => {
  const box = await proofBox(t, { on: false, kinds: ['command', 'measurement', 'reasoning'] });
  await tick(box, 1, 'command');
  await tick(box, 2, 'measurement');
  await tick(box, 3, 'reasoning');
  const refused = await runLocal(box, 'submit', '1', '--json');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /EMPTY_SUBMIT/u);
  assert.match(refused.err + refused.out, /submit\.proofOnly/u);
});

test('cli.io-submit-proof-only.test-clause-keeps-old-text: clause 2: with submit.proofOnly off, an item with a [test] clause keeps the existing EMPTY_SUBMIT text, which does not name submit.proofOnly [C7,#10834]', async (t) => {
  const box = await proofBox(t, { on: false, kinds: ['command', 'test'] });
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root });
  const item = { item_criterion: '1. The fixture proves part 1 [command] 2. The fixture proves part 2 [test]', item_owner: 'seat' };
  assert.equal(proofOnlyTicked(item, [], head), false, 'a [test] clause is never proof-only');
  assert.throws(() => requireNonEmptySubmit(box.root, 1, head, head, { proofShaped: () => proofOnlyTicked(item, [], head) }), (error) => {
    assert.equal(error.code, 'EMPTY_SUBMIT');
    assert.doesNotMatch(error.message, /submit\.proofOnly/u);
    return true;
  });
});
