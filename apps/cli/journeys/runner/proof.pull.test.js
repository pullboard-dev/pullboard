/** A pulled gate's proof runs in a real git work tree whose primary checkout names the job's main, so the proof's own repository and budget reads pass and a passing item goes to review [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

const REPO = resolve(import.meta.dirname, '../../../..');

/**
 * The stand-in proof makes the reads the real test runner makes before any test starts: the checkout's repository,
 * its primary checkout's main, and the test file budgets against that main (#5781: each refused NOT_A_REPO on a runner).
 */
const PROOF = `import { appendFileSync } from 'node:fs';
import { record } from './record.js';
import { repoInfo } from ${JSON.stringify(pathToFileURL(join(REPO, 'packages/git/index.js')).href)};
import { mainCheckout } from ${JSON.stringify(pathToFileURL(join(REPO, 'packages/git/index.js')).href)};
import { readTestFileBudgets } from ${JSON.stringify(pathToFileURL(join(REPO, 'packages/gate/src/io/test/file/policy.js')).href)};
record(process.cwd(), 'proof');
const info = repoInfo(process.cwd());
const main = mainCheckout(process.cwd());
const budgets = readTestFileBudgets(process.cwd(), ['web/proof.test.js']);
appendFileSync(process.env.PULLBOARD_FIXTURE_STEPS, JSON.stringify({ step: 'proof-reads', root: info.root, main: main?.commit ?? null, budgets: budgets.size }) + '\\n');
`;

test('clauses 1 and 2: a passing item\'s pulled gate runs its proof in a git work tree with main\'s commit, through a real runner serve process, and its green receipt sends the item to review [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  const box = await pullProject(t, 1, { tooling: { 'bin/proof.js': PROOF } });
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const main = box.git(box.repo, 'rev-parse', 'main');
  // The board API's own jobs route: a recorded receipt is applied to the item.
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const steps = join(box.runnerHome, 'steps.jsonl');
  const served = await serveOnce(box, url, 'r-proof', { PULLBOARD_FIXTURE_STEPS: steps });
  assert.equal(served.code, 0, served.output);

  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  const { receipt } = row.steps.find(step => step.name === 'receipt').payload;
  assert.equal(receipt.gate.green, true, JSON.stringify(receipt.gate).slice(0, 6000));
  assert.deepEqual(receipt.gate.phases.map(phase => [phase.role, phase.status]), [['check', 0], ['proof', 0]]);
  const reads = readFileSync(steps, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.step === 'proof-reads');
  assert.ok(reads, 'the proof read its repository, main and budgets');
  assert.equal(reads.main, main, 'the checkout\'s primary names the job\'s main, whose objects the runner fetched');
  assert.equal(reads.budgets, 1);

  const item = getItem(board, id);
  const thread = itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
  assert.deepEqual([item.item_status, item.item_commit], ['submitted', commit], `the green receipt sends the item to review at its candidate; ${thread}`);
});
