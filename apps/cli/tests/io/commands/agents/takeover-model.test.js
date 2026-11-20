/** @pullboard-test-input source-cell apps/cli */
/** A takeover of the main checkout records the new session's model [B3,B7,O8]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { boardSnapshot } from '../../../fixtures/agents/session.js';
import { cleanupSandboxes } from '../../../fixtures/agents/session.js';
import { project } from '../../../fixtures/agents/session.js';

after(cleanupSandboxes);

/** The previous holder and the new session, named once so no call carries a literal model string. */
const PREVIOUS_MODEL = 'gpt-6';
const NEW_MODEL = 'claude-opus-5-5';

test('cli.journeys-agents-takeover-model.a-takeover-of-the-coordinator-seat: clause 1: a takeover of the coordinator seat records the new session model in whoami and the notice [B3,B7,O8]', async () => {
  const box = await project();
  const first = 'claude-session-secret-first-9509';
  const second = 'claude-session-secret-second-9509';
  const joined = await box.inProcess(box.repo, ['join', 'coordinator', '--model', PREVIOUS_MODEL, '--json'], { session: first });
  assert.equal(joined.status, 0, `${joined.stdout}${joined.stderr}`);
  const before = await box.inProcess(box.repo, ['whoami', '--json'], { session: first });
  assert.equal(JSON.parse(before.stdout).model, PREVIOUS_MODEL);

  const takeover = await box.inProcess(box.repo, ['takeover', '--json'], { session: second, extra: { PULLBOARD_MODEL: NEW_MODEL } });
  assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
  const who = await box.inProcess(box.repo, ['whoami', '--json'], { session: second, extra: { PULLBOARD_MODEL: NEW_MODEL } });
  assert.equal(who.status, 0, `${who.stdout}${who.stderr}`);
  assert.equal(JSON.parse(who.stdout).model, NEW_MODEL, 'whoami names the model now holding the seat');
  assert.equal(JSON.parse(who.stdout).displayName, `coordinator (${NEW_MODEL})`);
  const notice = boardSnapshot(box.boardFile).shout.at(-1);
  assert.match(notice.shout_text, new RegExp(`coordinator \\(${NEW_MODEL}\\) took over`), 'the notice names the new model, not the previous holder');
  assert.doesNotMatch(notice.shout_text, new RegExp(PREVIOUS_MODEL));
});
