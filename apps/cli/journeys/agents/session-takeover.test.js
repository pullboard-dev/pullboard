/** @pullboard-test-input source-cell apps/cli packages/api packages/person packages/resources */
/** Checkout-session takeover: the view shout is recorded as the person, and takeover waits for an active write [B3,B7,B26,N26]. */
import assert from 'node:assert/strict';
import { fixtureChildMessage } from "../../tests/fixtures/child.js";
import { runFixtureChild } from "../../tests/fixtures/child.js";
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { boardSnapshot } from "../../tests/fixtures/agents/session.js";
import { cleanupSandboxes } from "../../tests/fixtures/agents/session.js";
import { project } from "../../tests/fixtures/agents/session.js";
import { startFixtureChild as spawn } from "../../tests/fixtures/child.js";
import { reportFixtureChildFailure } from "../../tests/fixtures/child.js";
import { existsSync } from 'node:fs';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
import { listResources } from "../../../../packages/resources/index.js";
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import { BIN } from "../../tests/fixtures/agents/session.js";
import { CONFIG } from "../../tests/fixtures/agents/session.js";

after(cleanupSandboxes);

test('cli.journeys-agents-session-takeover.a-shout-from-the-local-view: clause 1: a shout from the local view as the person is recorded as the person [N26,B26,B3,B7]', async () => {
  const box = await project();
  const owner = (await box.inProcess(box.repo, ['shout', 'web', 'agent owns this checkout', '--json'], { session: 'view-owner-session-273' }));
  assert.equal(owner.status, 0, owner.stdout + owner.stderr);
  assert.equal(boardSnapshot(box.boardFile).shout.at(-1).shout_from, 'coordinator', 'an agent-shell shout keeps the coordinator as author');
  const file = resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-dir'), 'pullboard-checkout-session.json');
  const before = readFileSync(file);
  const apiModule = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/api/src/io/main.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/native.js')).href;
  const source = `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const { openBoard, openBoardForRead } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const { moveArgs } = await import(${JSON.stringify(new URL('../../../../packages/person/index.js', import.meta.url).href)});
    const apiBoardOpeners = { moveArgs, openBoard, openBoardForRead };
    const response = await executeMove(process.cwd(), { verb: 'shout', args: { to: 'web', text: 'actual view action' } }, main, undefined, undefined, undefined, apiBoardOpeners);
    const asAgent = await executeMove(process.cwd(), { verb: 'shout', agent: 'web-1', args: { to: 'coordinator', text: 'Which path should web-1 use?', kind: 'question' } }, main, undefined, undefined, undefined, apiBoardOpeners);
    process.stdout.write(JSON.stringify({ ...response, asAgent }));
  `;
  const response = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: { ...box.base, CODEX_THREAD_ID: 'other-process-view-session-273' }, encoding: 'utf8',
  });
  assert.equal(response.status, 0, fixtureChildMessage(response));
  const document = JSON.parse(response.stdout);
  assert.equal(document.status, 200, response.stdout);
  assert.equal(document.body.event.event_kind, 'shout');
  assert.equal(document.body.event.event_by, 'person');
  const shouts = boardSnapshot(box.boardFile).shout;
  assert.equal(shouts.at(-2).shout_text, 'actual view action');
  assert.equal(shouts.at(-2).shout_from, 'person', 'the view as the coordinator records the person');
  assert.equal(document.asAgent.status, 200, response.stdout);
  assert.equal(shouts.at(-1).shout_from, 'web-1', 'the view acting as a named agent still records that agent');
  assert.deepEqual(readFileSync(file), before, 'the authenticated view does not alter the local agent-session binding');
});

test('cli.journeys-agents-session-takeover.takeover-waits-for-an-active-write: clause 2: takeover waits for an active write and then refuses the old session [B3,B7]', { timeout: 90_000 }, async t => {
  const box = await project();
  const started = join(box.dir, 'gate-started');
  const release = join(box.dir, 'gate-release');
  const gateFile = join(box.dir, 'holding-gate.cjs');
  writeFileSync(gateFile, `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); } }, 10);
    setTimeout(() => process.exit(19), 20000).unref();
  `);
  fixtureProjectPolicy(box.repo, { config: { ...CONFIG, gate: `node '${gateFile.replaceAll("'", "'\\''")}'` } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure holding gate');
  box.git(box.web, 'merge', '--quiet', 'main');
  const claim = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: 'active-write-273', sessionKey: 'CODEX_SESSION_ID' }));
  assert.equal(claim.status, 0, claim.stdout + claim.stderr);
  writeFileSync(join(box.web, 'web/page.txt'), 'changed for the claimed item\n');
  box.git(box.web, 'add', 'web/page.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): change the page [G1]');
  /** Start a real CLI write with a durable closed-process observation. */
  function launch(session, ...args) {
    const command = process.execPath;
    const childArgs = [BIN, ...args, '--json'];
    const childEnv = { ...box.base, CODEX_SESSION_ID: session };
    const startedAt = performance.now();
    const child = spawn(command, childArgs, { cwd: box.web, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { output += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.closed = new Promise((resolveClose) => child.once('close', (code, signal) => {
      const failure = code === 0 && !signal && !spawnError ? null : reportFixtureChildFailure({ command, args: childArgs,
        status: code, signal, elapsedMs: performance.now() - startedAt, stderr, env: childEnv,
        detail: spawnError?.message ?? '' });
      resolveClose({ code, signal, output, stderr, failure });
    }));
    return child;
  }
  /** Wait on an actual private fixture observation, with an assertion if it never becomes true. */
  async function observed(predicate, label) {
    const deadline = Date.now() + 40_000; // a loaded runner takes 18 s just to authorize a submit
    while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.ok(predicate(), label);
  }
  /** Observe the takeover waiting for the active write: it holds the checkout and has written its intent. */
  function queued() {
    return existsSync(resolve(box.web, box.git(box.web, 'rev-parse', '--git-dir'), 'pullboard-checkout-takeover'))
      && listResources({ scope: 'repo', root: box.repo }).some((resource) => resource.name.startsWith('checkout-session:') && resource.holders.length > 0);
  }
  // Pull dispatch: submit queues the gate and returns at once, so its write is short; the held gate runs on the local runner.
  const submission = launch('active-write-273', 'submit', '1');
  let takeover;
  try {
    const submitted = await submission.closed;
    assert.equal(submitted.code, 0, submitted.failure ?? submitted.output);
    takeover = launch('next-write-273', 'takeover');
    const taken = await takeover.closed;
    assert.equal(taken.code, 0, taken.failure ?? taken.output);
    writeFileSync(release, 'release');
    const view = { repo: box.repo, env: box.base, run: async (cwd, ...args) => { const r = await box.inProcess(cwd, args, { agent: false }); return { code: r.status, out: r.stdout, err: r.stderr }; } };
    await settleSubmit(t, view, JSON.parse(submitted.output));
    assert.equal(boardSnapshot(box.boardFile).item[0].item_status, 'submitted');
    const beforeRefusal = boardSnapshot(box.boardFile);
    const old = (await box.inProcess(box.web, ['shout', 'coordinator', 'old session cannot write', '--json'], { session: 'active-write-273', sessionKey: 'CODEX_SESSION_ID' }));
    assert.equal(old.status, 1);
    assert.equal(JSON.parse(old.stdout).error.code, 'NOT_YOUR_CHECKOUT');
    assert.deepEqual(boardSnapshot(box.boardFile), beforeRefusal);
  } finally {
    writeFileSync(release, 'release');
    if (submission.exitCode === null) submission.kill('SIGTERM');
    if (takeover?.exitCode === null) takeover.kill('SIGTERM');
    await submission.closed;
    if (takeover) await takeover.closed;
  }
});
