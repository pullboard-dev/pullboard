/** @pullboard-test-input source-cell apps/cli packages/resources */
/** Session independence on review, the claim ledger and helper seats [V1,B3,N2,B13]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import { FIXTURE_MODEL } from "../../tests/fixtures/testkit.js";
import { requireSessionIndependence } from "../../tests/fixtures/testkit.js";
import { waitForCondition } from "../../tests/fixtures/runner/holders.js";
import { assertNoRawSession } from "../../tests/fixtures/agents/session.js";
import { boardSnapshot } from "../../tests/fixtures/agents/session.js";
import { cleanupSandboxes } from "../../tests/fixtures/agents/session.js";
import { project } from "../../tests/fixtures/agents/session.js";

after(cleanupSandboxes);

async function waitForReviewComparison(box) {
  const jobs = resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-common-dir'), 'pullboard', 'review-comparisons');
  const finished = () => existsSync(jobs) && readdirSync(jobs).some((job) => existsSync(join(jobs, job, 'result.json')));
  await waitForCondition(finished, 'the submitted item\'s review comparison finishes',
    { signal: AbortSignal.timeout(60_000), state: () => existsSync(jobs) ? readdirSync(jobs) : 'no comparison jobs' });
}

test('clause 1: review.independence session: a verdict from the agent session that built the item is refused under any seat [V1,B3]', { timeout: 120_000 }, async t => {
  const box = await project();
  const builder = 'codex-thread-secret-builder-921';
  const build = (args) => box.inProcess(box.web, args, { session: builder, sessionKey: 'CODEX_THREAD_ID' });
  assert.equal((await build(['claim', '1', '--json'])).status, 0);
  writeFileSync(join(box.web, 'web', 'page.txt'), 'built\n');
  box.git(box.web, 'commit', '-qam', 'feat(web): build the fixture item [G1]');
  const submitted = await build(['submit', '1', '--json']);
  assert.equal(submitted.status, 0, `${submitted.stdout}${submitted.stderr}`);
  await settleSubmit(t, { repo: box.repo, env: box.base, run: async (cwd, ...args) => { const r = await box.inProcess(cwd, args, { agent: false }); return { code: r.status, out: r.stdout, err: r.stderr }; } }, JSON.parse(submitted.stdout));
  // The same session opens a review seat of its own: a different seat name, the same session.
  const review = join(box.dir, 'review-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, box.git(box.web, 'rev-parse', 'HEAD'));
  requireSessionIndependence(review);
  const reviewAs = (session, args) => box.inProcess(review, args, { session, sessionKey: 'CODEX_THREAD_ID' });
  assert.equal((await reviewAs(builder, ['join', 'web', '--family', 'Fixture-Reviewer', '--route', 'strong', '--json'])).status, 0);
  const before = boardSnapshot(box.boardFile);
  const own = await reviewAs(builder, ['verify', '1', 'accept', '--note', 'checked the page', '--json']);
  assert.notEqual(own.status, 0, 'the building session cannot accept its own item from another seat');
  const error = JSON.parse(own.stdout).error;
  assert.equal(error.code, 'SELF_SESSION_VERIFY');
  assert.match(error.message, /this agent session built or submitted #1/u);
  assert.match(error.next, /start the review in a separate process or session: run pullboard next --verify from a different agent session/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'the refused verdict records nothing');
  assertNoRawSession(box, box.web, [builder], 'CODEX_THREAD_ID');
  const ledger = readFileSync(resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-common-dir'), 'pullboard', 'item-sessions.jsonl'), 'utf8');
  assert.equal(ledger.includes(builder), false, 'the local item ledger keeps only the session digest');
  // Another session takes over that review seat and gives the verdict.
  const other = 'codex-thread-secret-reviewer-921';
  assert.equal((await reviewAs(other, ['takeover', '--json'])).status, 0);
  const accepted = await reviewAs(other, ['verify', '1', 'accept', '--note', 'checked the page', '--json']);
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
});

test('clause 1: a session whose claims cannot be recorded is refused before it moves, never let through [V1,B3]', async () => {
  const box = await project();
  const ledger = resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-common-dir'), 'pullboard', 'item-sessions.jsonl');
  writeFileSync(ledger, '', { mode: 0o400 });
  chmodSync(ledger, 0o400);
  const before = boardSnapshot(box.boardFile);
  const claim = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: 'codex-thread-secret-unrecorded-921', sessionKey: 'CODEX_THREAD_ID' }));
  assert.notEqual(claim.status, 0, 'an unrecordable claim is refused');
  const error = JSON.parse(claim.stdout).error;
  assert.equal(error.code, 'SESSION_LEDGER');
  assert.match(error.next, /chmod u\+rw/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'the refused claim moved nothing');
  chmodSync(ledger, 0o600);
  assert.equal((await box.inProcess(box.web, ['claim', '1', '--json'], { session: 'codex-thread-secret-unrecorded-921', sessionKey: 'CODEX_THREAD_ID' })).status, 0, 'a writable ledger lets it through');
  assert.match(readFileSync(ledger, 'utf8'), /"move":"claim"/u);
});

/** Open a helper seat from the web seat inside an agent session, returning the CLI result and the helper's Git directory. */
async function openHelper(box, session, { agent = true, from = box.web } = {}) {
  const made = (await box.inProcess(from, ['worktree', 'web', '--model', FIXTURE_MODEL, '--json'], { session, sessionKey: 'CODEX_THREAD_ID', agent }));
  assert.equal(made.status, 0, `${made.stdout}${made.stderr}`);
  const result = JSON.parse(made.stdout);
  const gitDir = resolve(result.path, box.git(result.path, 'rev-parse', '--git-dir'));
  return { result, gitDir, file: join(gitDir, 'pullboard-parent-session.json') };
}

test('clause 1: a helper seat records the agent that opened it [N2,B13]', async () => {
  const box = await project();
  const parent = JSON.parse((await box.inProcess(box.web, ['whoami', '--json'], { agent: false })).stdout).id;
  const session = 'codex-thread-secret-parent-800';
  const helper = await openHelper(box, session);
  assert.equal(existsSync(helper.file), true, 'opening the seat inside an agent session records its parent with no flag');
  const record = JSON.parse(readFileSync(helper.file, 'utf8'));
  assert.equal(record.parent, parent, 'the record names the agent that opened the seat');
  assert.equal(record.digest, createHash('sha256').update(JSON.stringify(['CODEX_THREAD_ID', session])).digest('hex'));
  assert.equal(readFileSync(helper.file, 'utf8').includes(session), false, 'the record keeps only the session digest');
  const lone = await openHelper(box, undefined, { agent: false });
  assert.equal(existsSync(lone.file), false, 'a seat a person opens has no parent');
  // The link never borrows a claim: the helper claims as itself, and the parent holds nothing.
  const claimed = (await box.inProcess(helper.result.path, ['claim', '1', '--json'], { session: 'codex-thread-secret-helper-800', sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(claimed.status, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.equal(JSON.parse((await box.inProcess(box.web, ['show', '1', '--json'], { agent: false })).stdout).item_owner, helper.result.agent);
});

test('clause 1: agents lists each agent with its helpers [N2,B13]', async () => {
  const box = await project();
  const parent = JSON.parse((await box.inProcess(box.web, ['whoami', '--json'], { agent: false })).stdout).id;
  const helper = await openHelper(box, 'codex-thread-secret-parent-800');
  assert.equal((await box.inProcess(helper.result.path, ['claim', '1', '--json'], { session: 'codex-thread-secret-helper-800', sessionKey: 'CODEX_THREAD_ID' })).status, 0);
  const listed = (await box.inProcess(box.web, ['agents', '--json'], { agent: false }));
  assert.equal(listed.status, 0, `${listed.stdout}${listed.stderr}`);
  const agents = JSON.parse(listed.stdout).agents;
  const top = agents.find((agent) => agent.id === parent);
  assert.ok(top, 'the opening agent is listed');
  assert.deepEqual(top.helpers.map((agent) => agent.id), [helper.result.agent], 'its helper is listed under it');
  assert.deepEqual(top.helpers[0].holds.map((hold) => hold.item), [1], 'the helper shows what it holds');
  assert.deepEqual(top.holds, [], 'the parent holds nothing the helper claimed');
  assert.equal(agents.some((agent) => agent.id === helper.result.agent), false, 'a helper is listed only under its parent');
  const text = (await box.inProcess(box.web, ['agents'], { agent: false }));
  assert.equal(text.status, 0);
  assert.match(text.stdout, new RegExp(`${helper.result.agent}[^\\n]*#1`, 'u'), 'the text view shows the helper and its item');
});

test('clause 1: agents gives the coordinator a row with the helpers it opened [N2,B13]', async () => {
  const box = await project();
  const helper = await openHelper(box, 'codex-thread-coordinator-800', { from: box.repo });
  assert.equal(JSON.parse(readFileSync(helper.file, 'utf8')).parent, 'coordinator', 'the main checkout is recorded as the parent');
  const listed = JSON.parse((await box.inProcess(box.repo, ['agents', '--json'], { agent: false })).stdout).agents;
  const top = listed.find((agent) => agent.id === 'coordinator');
  assert.ok(top, 'the coordinator has its own row');
  assert.deepEqual(top.helpers.map((agent) => agent.id), [helper.result.agent], 'its helper is nested under it');
  assert.equal(listed.some((agent) => agent.id === helper.result.agent), false, 'the helper is not a top-level agent');
  const lines = (await box.inProcess(box.repo, ['agents'], { agent: false })).stdout.split(/\r?\n/u);
  const at = lines.findIndex((line) => line.startsWith('coordinator'));
  assert.ok(at >= 0, 'the text view has a coordinator line');
  assert.match(lines[at + 1] ?? '', new RegExp(`^ {2}\\S.*${helper.result.agent}|^ {2}.*\\(web lane\\)`, 'u'), 'the helper is indented under it');
});
