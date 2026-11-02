/** Launch the real queued-submit process across the lib app's module graph [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../index.js';
import { HOOK_WORKER } from '../index.js';
import { submitHandoffWorkerEntrypoint } from '../index.js';
import { getItem } from '../../../packages/store/index.js';
import { submitHandoff } from '../../../packages/store/index.js';
import { writeBoardCommand } from '../../../packages/store/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { runFixtureChildAsync } from '../../../test/fixture-child.js';

/** Demand a genuine CLI success before reading its native document. */
function document(result) {
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

test('launched submit worker completes a native queued request without unsettled await [V4,H16,E18]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  const box = helpers.project('true', isolated);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }));
  writeFileSync(join(box.repo, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('web/page.txt','utf8'),'ready\\n');\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'test: queued worker fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = document(box.run(box.repo, 'add', 'web', 'Real worker process', '--specs', 'G1',
    '--criterion', 'The page is ready.', '--check', 'node check.cjs', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  const built = helpers.commitFile(box, box.web, 'web/page.txt', 'ready\n', 'feat(web): ready page [G1]');
  assert.equal(built.status, 0, built.stderr);
  const commonDir = join(box.repo, '.git');
  const board = openBoard(join(commonDir, 'pullboard/board.sqlite'), undefined, { gitRoot: box.web });
  t.after(() => board.db.close());
  const item = getItem(board, id);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  const queued = writeBoardCommand(board, 'queueSubmitHandoff', [id, {
    agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
    commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000,
  }], item.item_owner);
  const directory = join(commonDir, 'pullboard/submit-handoffs', queued.job.id);
  mkdirSync(directory, { recursive: true });
  const request = join(directory, 'request.json');
  writeFileSync(request, JSON.stringify({ item: id, job: queued.job.id, commonDir, commit }));
  // budget: the existing owned-worker hang ceiling; assertions concern exit and native results, not elapsed time.
  const result = await runFixtureChildAsync(process.execPath, [submitHandoffWorkerEntrypoint(), request],
    { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(result.status, 13, result.context);
  assert.equal(result.status, 0, result.context);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
  assert.equal(submitHandoff(board, id).state, 'green');
  assert.equal(getItem(board, id).item_status, 'submitted');
  assert.equal(getItem(board, id).item_commit, commit);
  assert.equal(JSON.parse(readFileSync(join(directory, 'submission.json'), 'utf8')).commit, commit);
  assert.equal(existsSync(join(directory, 'source')), false, 'the launched supervisor removes its owned source');
});

test('launched hook worker inspects committed work without unsettled await [I6,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document(box.run(box.repo, 'add', 'web', 'Hook process work',
    '--criterion', 'The committed work is named.', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  const built = helpers.commitFile(box, box.web, 'web/page.txt', 'ready\n', 'feat(web): ready page [G1]');
  assert.equal(built.status, 0, built.stderr);
  // budget: existing owned-child hang ceiling; successful inspection and native exit are the assertions.
  const result = await runFixtureChildAsync(process.execPath, [HOOK_WORKER, 'Stop'],
    { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(result.status, 13, result.context);
  assert.equal(result.status, 0, result.context);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
  assert.match(result.stdout, new RegExp(`Committed work on #${id} is not submitted`, 'u'));
});
