/** An automatic Rigor draft that differs from its file row only by the layout move's path renames is the same row [D1,S1]. */
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

/** A repo whose spec holds one draft row, and whose rename map names the old and the renamed path. */
function repo(rowText) {
  const { root, write } = privateFixtureFiles('pullboard-rigor-apply-');
  const spec = '# Spec\n\n## G · Goals\n- G1 [approved, must] Keep the product coherent. | gate: review\n\n'
    + `## RG · Rigor proposals\n- RG1 [draft, aim] ${rowText} | gate: review\n`;
  fixtureProjectPolicy(root, { config: CONFIG, spec });
  write('DOCTRINE.md', '# Doctrine\n\n## DR · Rulings\n');
  write('packages/codemap/data/plan/renames.tsv', `${OLD}\t${RENAMED}\n`);
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

test('rigor.auto.apply-renamed-path-same-row: clause 1: a draft naming an old path and a file row naming its renamed path are the same row, so apply skips it [D1,S1]', () => {
  const before = draft(OLD), root = repo(movedRow(draft(RENAMED), before));
  const plan = planAutomaticRigorApply(root, loadConfig(root), [before]);
  assert.deepEqual(plan.files, [], 'no file write is planned');
  assert.deepEqual(plan.records, []);
});

test('rigor.auto.apply-real-text-diff-refuses: clause 2: a real text difference besides the path still throws ROW_DRAFT [D1,S1]', () => {
  const before = draft(OLD), root = repo(movedRow(draft(RENAMED, 'avoid'), before));
  assert.throws(() => planAutomaticRigorApply(root, loadConfig(root), [before]), error => error.code === 'ROW_DRAFT');
});
