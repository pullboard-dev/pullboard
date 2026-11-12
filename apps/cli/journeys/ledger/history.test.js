/** Real mixed Git history retains complete citations without mistaking previews for requirements [C7,S8]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { commitCitations } from '../../src/io/spec.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  frozenCriterion,
  parseSpec,
} from '../../../../packages/spec/index.js';
import { rowEvidence } from '../../../../packages/verify/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Build ordinary Git history without installing hooks that would prohibit legacy-format fixtures. */
function historyFixture() {
  const box = e2e.sandbox();
  const root = join(box.dir, 'history');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'SPEC.md'), '# Spec\n\n## G · Goals\n- G1 [approved, must] Preserve history. | gate: test\n');
  box.git(root, 'add', 'SPEC.md');
  box.git(root, 'commit', '-q', '-m', 'chore: establish the spec [G1]');
  const first = box.git(root, 'rev-parse', 'HEAD').trim();
  /** Make a real commit and return the same short object name the public history reader reports. */
  function commit(message) {
    box.git(root, 'commit', '-q', '--allow-empty', '-m', message);
    return box.git(root, 'rev-parse', '--short', 'HEAD').trim();
  }
  return { box, root, first, commit };
}

test('mixed old and new Git commits retain full trailer rows and legacy header citations [C7,S8]', () => {
  const { root, first, commit } = historyFixture();
  const old = commit('fix(core): legacy requirements [G2, G3]');
  const modern = commit('feat(merge): a short preview [G4,+2]\n\nPullboard-Item: #4\nPullboard-Rows: G4,G5,G6');
  const found = commitCitations(root, first);
  assert.deepEqual([...found.keys()].sort(), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
  for (const id of ['G2', 'G3']) assert.equal(found.get(id), 'commit ' + old);
  for (const id of ['G4', 'G5', 'G6']) assert.equal(found.get(id), 'commit ' + modern);
  assert.equal(found.has('+2'), false, 'a preview count is never a spec row');
});

test('a final rows trailer takes precedence over header citations and retains newest attribution [C7,S8]', () => {
  const { root, first, commit } = historyFixture();
  commit('fix(core): older requirement [G7]');
  const latest = commit('fix(merge): header is only a preview [G8]\n\nPullboard-Item: #7\nPullboard-Rows: G7,G9');
  const found = commitCitations(root, first);
  assert.equal(found.get('G7'), 'commit ' + latest);
  assert.equal(found.get('G9'), 'commit ' + latest);
  assert.equal(found.has('G8'), false, 'a trailer-bearing commit never adds a second header-derived row set');
});

test('body examples and post-trailer prose do not invent historical rows [C7,S8]', () => {
  const { root, first, commit } = historyFixture();
  commit('fix(core): legacy body example [G2]\n\nPullboard-Rows: G99\nThis paragraph is explanatory prose.');
  commit('fix(core): legacy trailing prose [G3]\n\nPullboard-Rows: G98\n\nText after the trailers.');
  const found = commitCitations(root, first);
  assert.deepEqual([...found.keys()].sort(), ['G1', 'G2', 'G3']);
});

test('a legacy preview without full trailers preserves only the rows actually named [C7,S8]', () => {
  const { root, first, commit } = historyFixture();
  commit('fix(core): incomplete historical preview [G2,+4]');
  const found = commitCitations(root, first);
  assert.deepEqual([...found.keys()].sort(), ['G1', 'G2']);
});


test('mixed Git history cannot replace show, ledger or coverage board authority [C7,S8,B3]', async () => {
  const { box, root, first, commit } = historyFixture();
  const spec = '# Spec\n\n## G · Goals\n- G1 [approved, must] Board requirement. | gate: test\n- G2 [approved, must] Historical requirement. | gate: test\n';
  writeFileSync(join(root, 'SPEC.md'), spec);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', spec: 'SPEC.md',
    lanes: { web: { owns: ['web/'], specs: ['G'] } } }));
  box.git(root, 'add', 'SPEC.md', 'pullboard.json');
  box.git(root, 'commit', '-q', '-m', 'chore: configure historical fixture');
  commit('test: legacy citation [G1]');
  commit('test(merge): historic item [G2]\n\nPullboard-Item: #1\nPullboard-Rows: G2');
  const source = box.git(root, 'rev-parse', 'HEAD').trim();
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  let id;
  let item;
  try {
    id = store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: 'Board rows remain authoritative',
      criterion: 'Keep the live and frozen requirement.', specIds: ['G1'] });
    assert.equal(id, 1);
    store.claim(board, id, { agentId: 'coordinator', lane: 'coordinator', leaseMs: 60_000,
      freeze: () => frozenCriterion(parseSpec(spec), store.getItem(board, id)), head: source });
    // Synthetic historical submission proves a reader contract, not successful gate execution.
    submitFixture(board, id, { agentId: 'coordinator', commit: source,
      tree: box.git(root, 'rev-parse', source + '^{tree}').trim() });
    item = store.getItem(board, id);
    const coverage = rowEvidence(root, 'G1', { items: [item], testFiles: [] });
    assert.equal(coverage.awaiting, true);
    assert.equal(rowEvidence(root, 'G2', { items: [item], testFiles: [] }).awaiting, false);
  } finally { store.closeBoard(board); }
  const shown = await box.runLocal(root, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err);
  const detail = JSON.parse(shown.out);
  assert.equal(detail.item_spec_ids, 'G1');
  assert.deepEqual(JSON.parse(detail.item_frozen).rows.map(row => row.id), ['G1']);
  const ledger = await box.runLocal(root, 'ledger', '--json');
  assert.equal(ledger.code, 0, ledger.err);
  assert.equal(JSON.parse(ledger.out).items.find(entry => entry.item_id === id).item_spec_ids, 'G1');
  assert.deepEqual([...commitCitations(root, first).keys()].sort(), ['G1', 'G2']);
});
