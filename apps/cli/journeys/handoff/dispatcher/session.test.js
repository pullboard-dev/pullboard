import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../../lib/index.js';
import {
  closeBoard,
  getItem,
  agentParent,
  proofReceipts,
  submitHandoff,
} from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

/** Read only the native item, queue state and gate receipts from the private fixture board. */
function nativeState(box, id) {
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const item = getItem(board, id);
    return { item, job: submitHandoff(board, id), parentSession: item.item_owner ? agentParent(board, item.item_owner) : null,
      receipts: proofReceipts(board, id) };
  } finally { closeBoard(board); }
}

test('detached handoff dispatcher and worker drop inherited session ids while the native receipt keeps the submitter seat session [C7,H16]', async t => {
  const helpers = createE2eHelpers();
  const box = helpers.sandbox();
  box.env.PULLBOARD_MODEL = 'Synthetic handoff session fixture';
  box.env.CLAUDECODE = '1';
  const submitterSession = 'handoff-submitter-session';
  const parentSession = 'handoff-submitter-parent';
  const codexHome = join(box.dir, 'codex-home');
  const sessionDir = join(codexHome, 'sessions', '2026', '11', '03');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'fixture-handoff-submitter-session.jsonl'), `${JSON.stringify({
    type: 'session_meta', payload: { id: submitterSession, parent_thread_id: parentSession },
  })}\n`);
  box.env.CODEX_HOME = codexHome;
  box.env.CODEX_THREAD_ID = submitterSession;
  delete box.env.CLAUDE_CODE_SESSION_ID;
  delete box.env.CODEX_SESSION_ID;
  let itemId;
  t.after(async () => {
    if (itemId) await helpers.waitFor(() => { // budget: bounded cleanup ceiling for this test's actual detached worker.
      const job = nativeState(boxProject, itemId).job;
      return !job || !existsSync(join(boxProject.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source'));
    }, 'owned handoff worker cleanup', 120000);
    helpers.cleanup();
  });
  const gateEnv = join(box.dir, 'gate-session.json');
  const gate = join(box.dir, 'gate-session.cjs');
  writeFileSync(gate, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(gateEnv)}, JSON.stringify(Object.fromEntries(['CLAUDE_CODE_SESSION_ID','CODEX_THREAD_ID','CODEX_SESSION_ID'].filter(key => process.env[key]).map(key => [key,process.env[key]]))));`,
  ].join('\n'));
  const boxProject = helpers.project('true', box);
  const configFile = join(boxProject.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }, null, 2) + '\n');
  boxProject.git(boxProject.repo, 'add', 'pullboard.json');
  boxProject.git(boxProject.repo, 'commit', '-q', '-m', 'chore: enable the native handoff fixture');
  boxProject.git(boxProject.web, 'merge', '-q', '--ff-only', 'main');

  // The submitting seat stays in its original session while a stale unrelated ID simulates the dispatcher starter.
  boxProject.env.CODEX_SESSION_ID = 'fake-dispatcher-session';
  const added = fixtureAdd(boxProject.run, boxProject.repo, 'web', 'Handoff session receipt', '--specs', 'G1',
    '--criterion', 'The queued gate retains native seat provenance.', '--check', `${process.execPath} ${gate}`,
    '--brief', 'Files: web/session.txt\nChange: bind the handoff session\nTest: the queued gate retains native seat provenance', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = itemId = JSON.parse(added.out).item.item_id;
  const claimed = boxProject.run(boxProject.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, `${claimed.err}\n${claimed.out}`);
  assert.equal(helpers.commitFile(boxProject, boxProject.web, 'web/session.txt', 'session-bound\n', 'feat(web): bind handoff session [G1]').status, 0);
  const seatBeforeSubmit = nativeState(boxProject, id);
  const submitter = seatBeforeSubmit.item.item_owner;
  const submitterParent = seatBeforeSubmit.parentSession;

  const submitted = boxProject.run(boxProject.web, 'submit', String(id), '--no-next', '--json');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  const queued = JSON.parse(submitted.out);
  assert.equal(queued.queued, true, 'the native submit actually starts a detached dispatcher and worker');
  await helpers.waitFor(() => existsSync(gateEnv), 'the captured gate to record its process session environment', 120000); // budget: bounded observation ceiling for real detached gate progress.
  await helpers.waitFor(() => nativeState(boxProject, id).job?.state === 'green', 'the native gate receipt', 120000); // budget: bounded observation ceiling for real native receipt completion.

  assert.deepEqual(JSON.parse(readFileSync(gateEnv, 'utf8')), {}, 'neither detached process passes a session identifier into the gate');
  const completed = nativeState(boxProject, id);
  assert.ok(submitterParent, 'the native seat had a recorded parent session before submit');
  assert.equal(completed.receipts.at(-1)?.seat, submitter, 'the authentic gate receipt belongs to the submitting seat');
  assert.equal(completed.receipts.at(-1)?.parentSession, submitterParent, 'the authentic gate receipt names the submitting seat session');
});
