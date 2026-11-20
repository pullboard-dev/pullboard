/** A genuinely checked main merge passes the complete native/relay reader oracle [C7,V4,H16]. */
import { selectAffectedTests } from '../../../../../gate/heavy.js';
import { selectTestTreeGuards } from '../../../../../gate/heavy.js';
import { runnerExecutionServices } from '../../../../../runners/index.js';
import { landingExecutionServices } from '../../../../index.js';

/** The same real providers the production composition roots bind, built here so the fixture needs no app file [CD12]. */
const executionServices = Object.freeze({ runners: runnerExecutionServices(), landing: landingExecutionServices() });
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../../../git/index.js';
import { runSubmitGate } from '../../../../../gate/heavy.js';
import { mainPolicy } from '../../../../../sandbox/index.js';
import { withSourceComposition } from '../../../../../merge/index.js';
import { captureSourceAdvanceBasis } from '../../../../../sandbox/index.js';
import { boardReceiptStore } from '../../../../../gate/heavy.js';
import { readGateReceipt } from '../../../../../gate/heavy.js';
import { prepareSourceAdvance } from '../../../../../sandbox/index.js';

/** Build real fixture commits and execute the declared exact-tree test before covering the native move. */
export async function seedSourceAdvance({ board, box, store, exercise, agent, claim, submitFixture }) {
  const root = box.root;
  const configFile = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const check = 'node --test --test-reporter=tap test/source-advance-parity.test.mjs';
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test/source-advance-parity.test.mjs'), [
    "import {test} from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import {readFileSync} from 'node:fs';",
    "test('both independently committed source branches survive composition',()=>{",
    "assert.equal(readFileSync('source-candidate.txt','utf8'),'candidate\\n');",
    "assert.equal(readFileSync('source-trunk.txt','utf8'),'trunk\\n');",
    '});', '',
  ].join('\n'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: check, affectedTests: 'node --test --test-reporter=tap',
    staticChecks: '', submitInvariants: [], registryGuards: [] }, null, 2) + '\n');
  git(root, ['add', '--', 'pullboard.json', 'test/source-advance-parity.test.mjs']);
  const baseTree = git(root, ['write-tree']);
  const previous = git(root, ['rev-parse', 'HEAD']);
  // Immutable Git objects are synthetic fixture input; only the subsequent real gate is execution evidence.
  const base = git(root, ['commit-tree', baseTree, '-p', previous, '-m', 'fixture: source advance policy']);
  git(root, ['reset', '--hard', base]);
  writeFileSync(join(root, 'source-candidate.txt'), 'candidate\n');
  git(root, ['add', '--', 'source-candidate.txt']);
  const candidateTree = git(root, ['write-tree']);
  const candidate = git(root, ['commit-tree', candidateTree, '-p', base, '-m', 'fixture: source advance candidate']);
  git(root, ['reset', '--hard', base]);
  writeFileSync(join(root, 'source-trunk.txt'), 'trunk\n');
  git(root, ['add', '--', 'source-trunk.txt']);
  const trunk = git(root, ['commit-tree', git(root, ['write-tree']), '-p', base, '-m', 'fixture: source advance trunk']);
  git(root, ['reset', '--hard', trunk]);
  const frozen = JSON.stringify({ check, policy: { version: 1, commit: trunk, verify: { policy: 'any', family: 'off' } } });
  const digest = createHash('sha256').update(frozen).digest('hex');
  const id = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Source advance reader parity',
    criterion: 'The genuine checked merge preserves both committed files in both complete readers.' });
  store.claim(board, id, { ...claim, freeze: () => ({ text: frozen, digest }) });
  submitFixture(board, id, { agentId: agent, commit: candidate, tree: candidateTree });
  const item = store.getItem(board, id);
  const basis = captureSourceAdvanceBasis(root, board, item);
  const inheritedContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { await withSourceComposition(root, candidate, trunk, async (composition, custody) => {
    custody.started();
    const gate = await runSubmitGate(composition.directory, mainPolicy(root).config, { executionServices, base: candidate,
      changed: composition.changed, check, agent: 'coordinator', item: String(id), sourceAdvance: true,
      proofContext: { item: id, frozenDigest: digest, seat: 'coordinator', kind: 'submit' },
      onWait(state) { process.stderr.write(`parity source-advance admission ${JSON.stringify({ admitted: state.admitted === true, position: state.position ?? null })}\n`); } });
    assert.equal(gate.cleanupUnverified, undefined, 'the admitted child returned without unknown custody');
    custody.terminal();
    assert.equal(gate.isGreen, true, gate.output);
    assert.equal(gate.proofReceiptIds.length, 2, 'both declared phases actually ran');
    for (const receiptId of gate.proofReceiptIds) {
      const receipt = readGateReceipt(boardReceiptStore(board), receiptId);
      assert.deepEqual(receipt?.proof.counts, { passed: 1, failed: 0, skipped: 0 }, 'empty recursive --test is never genuine parity evidence');
    }
    assert.match(gate.check.profile.tests[0]?.name ?? '', /both independently committed source branches survive composition/u);
    const request = prepareSourceAdvance(root, board, item, composition, gate, basis, { selectAffectedTests, selectTestTreeGuards });
    const advanced = await exercise('advanceItemSource', () => board.enginePorts.store.advanceItemSource(board, id, request));
    assert.ok(advanced, 'only the actual source-advance mutation counts as parity coverage');
    assert.equal(store.getItem(board, id).item_effective_head, composition.head);
    assert.equal(store.getItem(board, id).item_commit, candidate);
  }); } finally {
    if (inheritedContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = inheritedContext;
  }
}
