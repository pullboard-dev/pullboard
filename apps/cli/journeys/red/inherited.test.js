/** A red item check remains mandatory and compares its failed files with main for recovery guidance [V1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { FAILING_TEST } from '../../tests/fixtures/red/main-red.js';
import { RED_SPEC } from '../../tests/fixtures/red/main-red.js';
import { addItems } from '../../tests/fixtures/red/main-red.js';
import { builder } from '../../tests/fixtures/red/main-red.js';
import { cli } from '../../tests/fixtures/red/main-red.js';
import { commit } from '../../tests/fixtures/red/main-red.js';
import { fixture } from '../../tests/fixtures/red/main-red.js';
import { inheritedMessage } from '../../tests/fixtures/red/main-red.js';
import { put } from '../../tests/fixtures/red/main-red.js';
import { runCount } from '../../tests/fixtures/red/main-red.js';
import { withoutScopeNotices } from '../../tests/fixtures/red/main-red.js';

test('an inherited red names the rework that owns it [V1]', async (t) => {
  await t.test('a prioritized rework already first in its tier stays first [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST });
    const [rework, submitItem] = addItems(box, [
      { title: 'First same-tier rework', specId: 'G1' },
      { title: 'Second same-tier submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): capture inherited red [G1]');
    inheritedMessage(submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to exercise prioritized inherited rework'), { row: 'G1', item: rework });
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, rework);
  });

  await t.test('one inherited row names its open owner, reuses exact-main cache, and leads only within its tier [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST });
    const [rework, submitItem, earlier, middle] = addItems(box, [
      { title: 'Repair inherited gate', specId: 'G1' },
      { title: 'Unrelated submit', specId: 'G2' },
      { title: 'Earlier light work', specId: 'G3', route: 'light' },
      { title: 'Middle milestone work', specId: 'G4' },
    ]);
    assert.ok(rework && submitItem && earlier && middle);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--reason', 'Arrange fixture release', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Middle', '--reason', 'Arrange fixture release', '--items', String(middle)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--reason', 'Arrange fixture release', '--items', String(rework)).code, 0);

    const withoutEvidence = builder(box);
    const ordinary = withoutEvidence.run('next', '--json');
    assert.equal(ordinary.code, 0, ordinary.err);
    assert.equal(JSON.parse(ordinary.out).item.item_id, earlier, 'without current-main evidence, original milestone order remains unchanged');
    const normalMid = builder(box);
    const normalOffer = normalMid.run('next', '--json');
    assert.equal(normalOffer.code, 0, normalOffer.err);
    assert.equal(JSON.parse(normalOffer.out).item.item_id, middle, 'without evidence, same-tier milestone order remains unchanged');
    // OTHER only frees the claim: BLOCKED twice escalates the item past this mid seat (#3219), and BLOCKED or ROUTED_ELSEWHERE hide it from next for this lane and route (#3014).
    assert.equal(normalMid.run('release', String(middle), '--reason', 'OTHER', '--note', 'fixture frees the claim', '--no-next').code, 0);
    assert.equal(JSON.parse(cli(box.root, box.env, 'show', String(rework), '--json').out).item_status, 'open', 'the controlled release leaves the rework open for inherited-red attribution');

    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select inherited red [G1]');
    const before = runCount(box);
    let red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to exercise exact-main comparison caching');
    inheritedMessage(red, { row: 'G1', item: rework });
    const main = runFixtureGit(['rev-parse', 'main'], { cwd: box.root, env: box.env }).trim();
    const common = runFixtureGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: submitter.root, env: box.env }).trim();
    const cachePath = join(common, 'pullboard/main-red.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cache.entries[main]['test/inherited.test.js'].result, 'red');
    assert.equal((readFileSync(cachePath).length > 0), true);
    assert.equal(statSync(cachePath).mode & 0o077, 0, 'the result cache is private to this machine account');
    const firstCount = readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length;
    assert.equal(firstCount, before + 2, 'one selected candidate run and one exact-main run occurred');

    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// second candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): retry inherited red [G1]');
    red = submitter.run('submit', String(submitItem), '--infra', 'append a second candidate-only test marker to check exact-main cache reuse');
    inheritedMessage(red, { row: 'G1', item: rework });
    const secondCount = readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length;
    assert.equal(secondCount, firstCount + 1, 'the second submit reuses the current-main file result');

    const afterEvidence = builder(box);
    const offered = afterEvidence.run('next', '--json');
    assert.equal(offered.code, 0, offered.err);
    assert.equal(JSON.parse(offered.out).item.item_id, rework, 'the unique main-red rework leads an earlier-milestone item within the same tier');
    const middleHolder = builder(box);
    assert.equal(middleHolder.run('claim', String(middle)).code, 0, 'a different builder can claim the non-priority same-tier item');
    assert.equal(afterEvidence.run('release', String(rework), '--reason', 'OTHER', '--note', 'fixture frees the claim', '--no-next').code, 0, 'release the selected rework before asking for another claim');
    const sole = afterEvidence.run('next', '--json');
    assert.equal(sole.code, 0, sole.err);
    assert.equal(JSON.parse(sole.out).item.item_id, rework, 'the only eligible same-tier item is never removed by prioritization');
    assert.equal(afterEvidence.run('release', String(rework), '--reason', 'OTHER', '--note', 'fixture frees the claim', '--no-next').code, 0);
    assert.equal(middleHolder.run('release', String(middle), '--reason', 'OTHER', '--note', 'fixture frees the claim', '--no-next').code, 0);
    put(box.root, 'README.md', 'A new main commit has no cached comparison yet.\n');
    const newMain = commit(box.root, box.env, 'chore: advance main fixture');
    assert.notEqual(newMain, main);
    const afterMainChange = builder(box).run('next', '--json');
    assert.equal(afterMainChange.code, 0, afterMainChange.err);
    assert.equal(JSON.parse(afterMainChange.out).item.item_id, middle, 'a cache for the former main cannot reorder the current main');
  });

  await t.test('multiple approved rows never produce a guessed row or item [V1]', (sub) => {
    const spec = [
      '# Ambiguous gate fixture\n\n## G · Goals',
      '- G1 [approved, must] First gate row. | gate: test/inherited.test.js',
      '- G2 [approved, must] Second gate row. | gate: test/inherited.test.js',
      '- G3 [approved, must] Submit row. | gate: test/unrelated.test.js',
      '- G4 [approved, must] Earlier work row. | gate: test/earlier.test.js',
    ].join('\n') + '\n';
    const box = fixture(sub, { spec, source: FAILING_TEST });
    const [first, second, earlier, submitItem] = addItems(box, [
      { title: 'First possible repair', specId: 'G1' },
      { title: 'Second possible repair', specId: 'G2' },
      { title: 'Earlier milestone work', specId: 'G4' },
      { title: 'Unrelated submit', specId: 'G3' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select ambiguous inherited red [G3]');
    const red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to check ambiguous inherited row ownership');
    inheritedMessage(red);
    assert.doesNotMatch(withoutScopeNotices(red.err), new RegExp(`#${first}|#${second}`, 'u'));
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--reason', 'Arrange fixture release', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--reason', 'Arrange fixture release', '--items', `${first},${second}`).code, 0);
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, earlier, 'ambiguous rows leave next in its original milestone order');
  });

  await t.test('a row with several open owners does not prioritize either owner [V1]', (sub) => {
    const spec = [
      '# Multiple owner fixture\n\n## G · Goals',
      '- G1 [approved, must] Inherited gate row. | gate: test/inherited.test.js',
      '- G2 [approved, must] Submit row. | gate: test/unrelated.test.js',
      '- G3 [approved, must] Earlier work row. | gate: test/earlier.test.js',
    ].join('\n') + '\n';
    const box = fixture(sub, { spec, source: FAILING_TEST });
    const [first, second, earlier, submitItem] = addItems(box, [
      { title: 'First possible repair', specId: 'G1' },
      { title: 'Second possible repair', specId: 'G1' },
      { title: 'Earlier milestone work', specId: 'G3' },
      { title: 'Unrelated submit', specId: 'G2' },
    ]);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--reason', 'Arrange fixture release', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--reason', 'Arrange fixture release', '--items', `${first},${second}`).code, 0);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select multiply-owned inherited red [G2]');
    const red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to check multiple inherited rework owners');
    inheritedMessage(red);
    assert.doesNotMatch(withoutScopeNotices(red.err), new RegExp(`#${first}|#${second}`, 'u'));
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, earlier, 'several open owners leave next in its original milestone order');
  });

  await t.test('a candidate-only red keeps the old refusal text [V1]', (sub) => {
    const green = "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n";
    const box = fixture(sub, { spec: RED_SPEC, source: green });
    const [, submitItem] = addItems(box, [
      { title: 'Repair unrelated gate row', specId: 'G1' },
      { title: 'Candidate-only submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
    commit(submitter.root, box.env, 'test(core): introduce candidate-only red [G2]');
    const red = submitter.run('submit', String(submitItem), '--infra', 'introduce a candidate-only failing assertion to distinguish it from inherited failure');
    assert.equal(red.code, 1, red.out || red.err);
    assert.match(red.err, /\[GATE_RED\]/u);
    assert.doesNotMatch(red.err, /also red on main|inherited main red|main not checked/u);
  });

  await t.test('without a focused runner the old refusal names the missing config key [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST, affectedTests: '' });
    const [, submitItem] = addItems(box, [
      { title: 'Repair inherited gate', specId: 'G1' },
      { title: 'Unrelated submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select red without focused runner [G2]');
    const before = runCount(box);
    const red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to exercise missing focused-runner guidance');
    assert.equal(red.code, 1, red.out || red.err);
    assert.match(red.err, /\[GATE_RED\]/u);
    assert.match(red.err, /main not checked: no focused test runner configured \(affectedTests\)/u);
    assert.equal(runCount(box), before + 1, 'the main comparison does not run a second full gate');
  });
});
