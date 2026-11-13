import { recordTrainLanding } from '../../../../index.js';
/** A real native producer feeds the unchanged complete reader oracle; acceptance alone is synthetic [H5,H16,C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { runGate } from '../../../../../gate/index.js';
import { runnerExecutionServices } from '../../../../../runners/index.js';
import { landingExecutionServices } from '../../../../index.js';
import { readGateReceipt } from '../../../../../gate/index.js';
import { receiptStore } from '../../../../../gate/index.js';
import { prepareTrainLanding } from '../../../../index.js';
import { invalidateGitFacts } from '../../../../../git/index.js';
import { mainPolicy } from '../../../../../sandbox/index.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';

/** Keep all changes in the existing private parity Git/SQLite fixture, never the person's board or config. `cli` is the CLI file the `pullboard` shim runs, named by the app that owns it [CD12]. */
export async function seedNativeTrain(context, { cli }) {
  const { board, box, store, exercise, agent, reviewer, submitFixture } = context;
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  // Commit an explicitly tiny real gate as this private fixture's accepted policy, not invented receipt bytes.
  config.gate = 'node --input-type=module -e "import {test} from \'node:test\'; test(\'native parity train [C7]\',()=>{});"';
  writeFileSync(file, JSON.stringify(config));
  const shim = join(dirname(box.root), 'native-train-bin');
  mkdirSync(shim, { recursive: true });
  const executable = join(shim, 'pullboard');
  writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
  chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, GIT_AUTHOR_NAME: 'Private Parity Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Private Parity Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  // init's real generated files were untracked in this metadata-only fixture; receipts require all source committed.
  runFixtureGit(['add', '-A'], { cwd: box.root, env });
  process.stderr.write('parity train policy commit begin\n');
  runFixtureGit(['commit', '-m', 'test: accept the private parity native gate'], { cwd: box.root, env });
  process.stderr.write('parity train policy commit complete\n');
  // The fixture Git adapter runs outside the production mutation adapter and must invalidate its cached facts.
  invalidateGitFacts();
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env }).trim();
  assert.equal(mainPolicy(box.root).commit, head, 'the producer reads the fixture accepted policy after the real commit');
  assert.equal(mainPolicy(box.root).config.gate, config.gate, 'the producer keeps the exact committed command');
  assert.equal(runFixtureGit(['status', '--porcelain', '--untracked-files=all'], { cwd: box.root, env }).trim(), '',
    'the real native producer starts from a fully committed private source');
  const tree = runFixtureGit(['rev-parse', 'HEAD^{tree}'], { cwd: box.root, env }).trim();
  const frozen = { text: '{"rows":[]}', digest: 'parity-native-train-frozen' };
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane,
    title: 'Native train receipt parity', criterion: 'Both complete readers retain the actual native train result' });
  store.claim(board, item, { agentId: agent, lane: box.lane, leaseMs: 3600000, head, freeze: () => frozen });
  submitFixture(board, item, { agentId: agent, commit: head, tree });
  store.reserveReview(board, item, { agentId: reviewer, lane: 'tests', leaseMs: 3600000, policy: 'any' });
  store.verify(board, item, { agentId: reviewer, decision: 'ACCEPT', head, digest: frozen.digest,
    policy: 'any', familyPolicy: 'off', note: 'Synthetic acceptance only; gate bytes below are native.',
    review: { commit: head, head, trunk: head, paths: [] } });
  process.stderr.write('parity train gate begin\n');
  const run = await runGate(box.root, config, { trustStamp: false, landing: true, agent: 'coordinator',
    onWait(state) { process.stderr.write(`parity train admission ${JSON.stringify({ admitted: state.admitted === true, position: state.position ?? null })}\n`); },
    executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() } });
  process.stderr.write(`parity train gate complete ${JSON.stringify({ green: run.isGreen, hasNodeTestContext: process.env.NODE_TEST_CONTEXT !== undefined })}\n`);
  assert.equal(run.isGreen, true, run.output);
  const receipt = readGateReceipt(receiptStore(box.root), run.receiptId);
  assert.ok(receipt, 'the actual native producer stored a receipt');
  assert.equal(receipt.head, head);
  assert.equal(receipt.tree, tree);
  const request = prepareTrainLanding(box.root, board, [item], head, receipt.id);
  await exercise('recordTrainLanding', () => recordTrainLanding(board, request));
  assert.equal(store.getItem(board, item).item_merged_commit, head);
}
