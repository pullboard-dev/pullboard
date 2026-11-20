/** An automatic Rigor draft that differs from its file row in any word, a path included, is a different row [D1,S1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../../../config/index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureProjectPolicy } from '../../../../gate/tests/fixtures/testkit.js';
import { planAutomaticRigorApply } from '../../../index.js';
import { automaticRigorSource } from '../../../../store/index.js';

const OLD = 'test/relay-credential.test.js';
const RENAMED = 'apps/cli/journeys/relay/credential.test.js';
const CONFIG = { name: 'Rename fixture', gate: 'true', spec: 'SPEC.md', lanes: { app: { owns: ['src/'] } } };

/** A repo whose spec holds one draft row and no plan folder. */
function repo(rowText, more = []) {
  const { root, write } = privateFixtureFiles('pullboard-rigor-apply-');
  const spec = '# Spec\n\n## G · Goals\n- G1 [approved, must] Keep the product coherent. | gate: review\n\n'
    + `## RG · Rigor proposals\n- RG1 [draft, aim] ${rowText} | gate: review\n${more.map(row => `${row}\n`).join('')}`;
  fixtureProjectPolicy(root, { config: CONFIG, spec });
  write('DOCTRINE.md', '# Doctrine\n\n## DR · Rulings\n');
  return root;
}

/** The board draft, built the way Rigor builds it, naming the given path in its prose and its typed source. */
function draft(path, word = 'prevent') {
  const key = `test:${path}::does not leak`;
  const source = automaticRigorSource({ key, items: [{ id: 7, commits: [] }], occurrences: 3 }, [1]);
  return { id: 'RG1', target: 'spec', tier: 'aim', gate: 'review', written: false,
    text: `Review how to ${word} repeated "${key}" (#7). No remedy has been established. Source: ${source}` };
}

/** The file row the layout move left: its prose path rewritten, its encoded source tail unchanged. */
function movedRow(renamed, before) {
  return `${renamed.text.slice(0, renamed.text.indexOf(' Source: '))} Source: ${before.text.split(' Source: ')[1]}`;
}

test('rigor.auto.apply-old-path-draft-collides: clause 2: a draft naming an old path and a file row naming its renamed path are different rows, so apply lists the draft as a collision and plans no write for it [D1,S1]', () => {
  const before = draft(OLD), root = repo(movedRow(draft(RENAMED), before));
  const plan = planAutomaticRigorApply(root, loadConfig(root), [before]);
  assert.deepEqual(plan.files, [], 'no file write is planned');
  assert.deepEqual(plan.records, []);
  assert.deepEqual(plan.collisions.map(({ id, target }) => ({ id, target })), [{ id: 'RG1', target: 'spec' }]);
  assert.match(plan.collisions[0].why, /RG1 already names different spec text, gate or tier/u);
  const same = draft(RENAMED), sameRoot = repo(movedRow(same, same));
  const samePlan = planAutomaticRigorApply(sameRoot, loadConfig(sameRoot), [same]);
  assert.deepEqual(samePlan.files, [], 'a draft and a file row with the same text plan no write');
  assert.deepEqual(samePlan.collisions, []);
});

/** A spec with a colliding draft row RG1 and no row yet for the fresh draft RG2. */
function collidingRepo() {
  const before = draft(OLD);
  return { before, root: repo(movedRow(draft(RENAMED, 'avoid'), before)) };
}

/** A second draft whose id the spec does not hold yet, so it plans a fresh row. */
function freshDraft() {
  return { ...draft(RENAMED), id: 'RG2' };
}

test('rigor.auto.apply-collision-does-not-block: clause 1: a colliding draft is listed in collisions while the fresh draft still plans its row [D1,S1]', () => {
  const { before, root } = collidingRepo();
  const plan = planAutomaticRigorApply(root, loadConfig(root), [before, freshDraft()]);
  assert.equal(plan.files.length, 1, 'the fresh draft plans one file write');
  assert.match(plan.files[0].after, /^- RG2 \[draft, aim\] /mu);
  assert.deepEqual(plan.collisions.map(({ id, target }) => ({ id, target })), [{ id: 'RG1', target: 'spec' }]);
  assert.match(plan.collisions[0].why, /RG1 already names different spec text, gate or tier/u);
});

test('rigor.auto.apply-collision-never-overwrites: clause 2: a colliding draft is never written over; its file row stays byte for byte [D1,S1]', () => {
  const { before, root } = collidingRepo();
  const plan = planAutomaticRigorApply(root, loadConfig(root), [before, freshDraft()]);
  assert.ok(plan.collisions.some(({ id }) => id === 'RG1'));
  const [{ before: original, after }] = plan.files;
  const row = /^- RG1 .*$/mu.exec(original)[0];
  assert.deepEqual(after.split('\n').filter(line => line.startsWith('- RG1 ')), [row], 'the planned text keeps the colliding row exactly, with no second RG1 row');
});

test('rigor.auto.apply-collisions-apply-the-rest: clause 3: several colliding drafts are all listed while every non-colliding draft still plans its row [D1,S1]', () => {
  const before = draft(OLD), second = { ...draft(OLD), id: 'RG2' };
  const secondRow = `- RG2 [draft, aim] ${movedRow(draft(RENAMED, 'avoid'), second)} | gate: review`;
  const root = repo(movedRow(draft(RENAMED, 'avoid'), before), [secondRow]);
  const fresh = ['RG3', 'RG4'].map(id => ({ ...draft(RENAMED), id }));
  const plan = planAutomaticRigorApply(root, loadConfig(root), [before, second, ...fresh]);
  assert.deepEqual(plan.collisions.map(({ id }) => id), ['RG1', 'RG2'], 'every colliding draft is listed');
  assert.equal(plan.files.length, 1);
  const rows = plan.files[0].after.split('\n').filter(line => /^- RG\d /u.test(line)).map(line => line.slice(0, 6));
  assert.deepEqual(rows, ['- RG1 ', '- RG2 ', '- RG3 ', '- RG4 '], 'both fresh rows are planned beside the untouched colliding rows');
});
