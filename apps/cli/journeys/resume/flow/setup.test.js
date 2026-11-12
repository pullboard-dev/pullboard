/** Resume walks a new board through setup, drafts and starter items [I1,I2,N32,B26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { spawn } from 'node:child_process';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { takeDefaultViewPort } from '../../../tests/fixtures/view/port.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import {
  releaseFixture,
} from '../../../tests/fixtures/resume/release.js';

test('spec draft adds draft rows and resume names them [N32]', async t => {
  const box = releaseFixture(t, { freshSetup: true });
  const initial = JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout);
  assert.equal(initial.setup.step, 1);
  assert.match(initial.setup.command, /^pullboard spec draft/u);
  assert.doesNotMatch(initial.setup.command, /node -e|appendFileSync/u);
  assert.match(initial.setup.afterAnswer, /record each answer with pullboard spec draft/iu);

  const help = (await box.runLocal(box.repo, 'help', 'spec', '--json'));
  assert.equal(help.status, 0, help.failure || help.stderr);
  assert.match(JSON.parse(help.stdout).help, /spec draft <text>.*any agent: append a draft row/u);

  const first = (await box.runLocal(box.repo, 'spec', 'draft', 'Describe the first requirement', '--json'));
  const second = (await box.runLocal(box.repo, 'spec', 'draft', 'Describe the second requirement', '--aim', '--gate', 'node --test', '--json'));
  assert.equal(first.status, 0, first.failure || first.stderr);
  assert.equal(second.status, 0, second.failure || second.stderr);
  const rows = JSON.parse((await box.runLocal(box.repo, 'spec', '--json')).stdout).rows;
  assert.deepEqual(rows.filter(row => ['G1', 'G2'].includes(row.id)).map(({ id, status, tier, text, gate }) => ({ id, status, tier, text, gate })), [
    { id: 'G1', status: 'draft', tier: 'must', text: 'Describe the first requirement', gate: 'review' },
    { id: 'G2', status: 'draft', tier: 'aim', text: 'Describe the second requirement', gate: 'node --test' },
  ], 'draft appends two sequential draft rows with the requested defaults');
  assert.equal(JSON.parse(first.stdout).id, 'G1');
  assert.equal(JSON.parse(second.stdout).id, 'G2');
  const beforeEmpty = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const empty = (await box.runLocal(box.repo, 'spec', 'draft', '   ', '--json'));
  assert.notEqual(empty.status, 0);
  assert.equal(JSON.parse(empty.stdout).error.code, 'USAGE');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), beforeEmpty, 'an empty draft does not change the spec');

  const next = JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout);
  assert.equal(next.setup.step, 1);
  assert.match(next.setup.question, /waiting.*person.*approv/iu);
  assert.deepEqual(next.setup.rowIds, ['G1', 'G2']);

  const custom = releaseFixture(t, { freshSetup: true });
  const customSpec = [
    '# Existing requirements', '', '## G · Goals',
    '- G1 [approved, must] Keep the approved row. | gate: existing',
    '- G3 [retired, aim] Keep the retired row. | gate: archive',
    '- G5 [draft, must] Keep the draft row. | gate: review',
    '- G6 [wont, aim] Keep the declined row. | gate: closed', '',
    '## N · Notes', '- G2 [approved, must] Another section owns this id. | gate: existing', '',
  ].join('\r\n');
  writeFileSync(join(custom.repo, 'SPEC.md'), customSpec);
  const customDraft = (await custom.runLocal(custom.repo, 'spec', 'draft', 'Keep line endings intact', '--json'));
  assert.equal(customDraft.status, 0, customDraft.failure || customDraft.stderr);
  assert.equal(JSON.parse(customDraft.stdout).id, 'G7');
  const updatedSpec = readFileSync(join(custom.repo, 'SPEC.md'), 'utf8');
  assert.equal(updatedSpec.replaceAll('\r\n', '').includes('\n'), false, 'draft preserves the source newline style');
  assert.equal(updatedSpec, customSpec.replace('\r\n\r\n## N · Notes', '\r\n- G7 [draft, must] Keep line endings intact | gate: review\r\n\r\n## N · Notes'),
    'draft preserves every existing status row and inserts in the first section');
});

test('setup lets agents build starter items while rows wait [S1,B26]', async t => {
  const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  // Process-level case: init installs hooks stamped with the running version, and the git hooks run the fixture's copied CLI.
  const initialized = box.run(box.repo, 'init', '--blueprint', 'web-app');
  assert.equal(initialized.status, 0, initialized.failure || initialized.stderr);
  const rows = JSON.parse((await box.runLocal(box.repo, 'spec', '--json')).stdout).rows;
  const starters = JSON.parse((await box.runLocal(box.repo, 'list', '--all', '--json')).stdout).items.sort((a, b) => a.item_id - b.item_id);
  const first = starters.find(item => !item.item_after);
  assert.ok(first, 'the bundled blueprint files a starter with no dependency');
  const initial = JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout);
  assert.equal(initial.setup.waitingOn, 'person-approval');
  assert.equal(initial.setup.buildNow?.item, first.item_id, 'setup names the first starter while rows are undecided');
  assert.match(initial.setup.meanwhile, /claimed and built now.*person.*parallel/iu);
  assert.equal(initial.setup.buildNow.command, `pullboard lane add ${first.item_lane} --owns ${first.item_lane}/`,
    'a proposed lane is declared before an agent tries to join it');
  const lane = (await box.runLocal(box.repo, 'lane', 'add', first.item_lane, '--owns', `${first.item_lane}/`));
  assert.equal(lane.status, 0, lane.failure || lane.stderr);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: commit blueprint setup');
  const coordinator = (await box.runLocal(box.repo, 'resume', '--diagnostics'));
  assert.match(coordinator.stdout, /claimed and built now.*person.*parallel/iu);
  assert.ok(coordinator.stdout.includes(`#${first.item_id}`), 'prose names the same first starter');
  const prepared = JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout);
  assert.equal(prepared.setup.buildNow.command, `pullboard worktree ${first.item_lane} --model "<model name>"`);
  box.env.CODEX_THREAD_ID = 'starter-builder-session';
  const opened = (await box.runLocal(box.repo, 'worktree', first.item_lane, '--route', 'strong', '--model', 'Starter fixture', '--json'));
  assert.equal(opened.status, 0, opened.failure || opened.stderr);
  const worktree = JSON.parse(opened.stdout).path;
  const ready = JSON.parse((await box.runLocal(worktree, 'resume', '--diagnostics', '--json')).stdout);
  assert.equal(ready.setup.waitingOn, 'person-approval', 'approval remains a separate person decision');
  assert.equal(ready.setup.buildNow.item, first.item_id);
  assert.equal(ready.setup.buildNow.command, `pullboard claim ${first.item_id}`);
  assert.equal(ready.next, `pullboard claim ${first.item_id}`, 'the agent is sent to build rather than wait for approval');
  const claimed = (await box.runLocal(worktree, 'claim', String(first.item_id)));
  assert.equal(claimed.status, 0, claimed.failure || claimed.stderr);
  mkdirSync(join(worktree, first.item_lane));
  writeFileSync(join(worktree, first.item_lane, 'starter.js'), 'export const started = true;\n');
  box.git(worktree, 'add', `${first.item_lane}/starter.js`);
  box.git(worktree, 'commit', '-q', '-m', `feat(app): start the requested runner [${first.item_spec_ids}]`);
  const denied = (await box.runLocal(worktree, 'spec', 'approve', first.item_spec_ids.split(',')[0]));
  assert.equal(denied.status, 1, 'building does not give the agent approval rights');
  assert.match(denied.stderr, /B26_PERSON/u);
  assert.deepEqual(JSON.parse((await box.runLocal(worktree, 'spec', '--json')).stdout).rows, rows,
    'the real claim and build neither approve nor apply any row');
});

test("resume says setup waits on the person's approval [I1,I2]", async t => {
  const box = releaseFixture(t, { freshSetup: true });
  box.env.AI_AGENT = 'fixture-agent';
  const drafted = [
    (await box.runLocal(box.repo, 'spec', 'draft', 'The person can choose a project name.', '--json')),
    (await box.runLocal(box.repo, 'spec', 'draft', 'The person can choose a project color.', '--json')),
  ];
  for (const result of drafted) assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const ids = drafted.map(result => JSON.parse(result.stdout).id);
  assert.deepEqual(ids, ['G1', 'G2']);

  const waiting = (await box.runLocal(box.repo, 'resume', '--diagnostics'));
  assert.equal(waiting.status, 0, waiting.failure || waiting.stderr || waiting.stdout);
  assert.match(waiting.stdout, /waiting.*person.*approv/iu, 'setup waits for the person after the rows are drafted');
  for (const id of ids) assert.match(waiting.stdout, new RegExp(`\\b${id}\\b`, 'u'));
  assert.match(waiting.stdout, /agent[^\n]*may[^\n]*review[^\n]*independent approved work/iu,
    'resume names permissible independent work while approval is pending');
  assert.doesNotMatch(waiting.stdout, /^next: .*spec (?:draft|approve)/mu,
    'the agent is not told to draft again or perform the person-only approval');
  const waitingJson = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
  assert.equal(waitingJson.status, 0, waitingJson.failure || waitingJson.stderr || waitingJson.stdout);
  const card = JSON.parse(waitingJson.stdout);
  assert.equal(card.setup?.step, 1);
  assert.equal(card.setup.waitingOn, 'person-approval');
  assert.deepEqual(card.setup.rowIds, ids);
  assert.match(card.next, /^wait for the person to approve G1, G2; meanwhile pullboard spec show G1$/u);

  // Opening the real view to approve these rows cannot stand in for completing setup.
  await openSetupView(box);

  delete box.env.AI_AGENT;
  const approval = (await box.runLocal(box.repo, 'spec', 'approve', ids[0]));
  assert.equal(approval.status, 0, approval.failure || approval.stderr || approval.stdout);
  const applied = (await box.runLocal(box.repo, 'spec', 'apply'));
  assert.equal(applied.status, 0, applied.failure || applied.stderr || applied.stdout);
  const partial = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
  assert.equal(partial.status, 0, partial.failure || partial.stderr || partial.stdout);
  const pending = JSON.parse(partial.stdout);
  assert.equal(pending.setup?.step, 1, 'one approved row does not stand in for the remaining setup draft');
  assert.deepEqual(pending.setup.rowIds, [ids[1]]);
  assert.match(pending.setup.question, /Waiting for the person to approve G2/u);
  const finalApproval = (await box.runLocal(box.repo, 'spec', 'approve', ids[1]));
  assert.equal(finalApproval.status, 0, finalApproval.failure || finalApproval.stderr || finalApproval.stdout);
  const finalApply = (await box.runLocal(box.repo, 'spec', 'apply'));
  assert.equal(finalApply.status, 0, finalApply.failure || finalApply.stderr || finalApply.stdout);
  const resumed = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
  assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
  const next = JSON.parse(resumed.stdout);
  assert.equal(next.setup?.step, 2, 'person approval advances setup to its next unanswered step');
  assert.equal(next.setup.waitingOn, undefined);
});

// Process-level cases kept as processes (beside the blueprint init above): the shell-run record-answer command and the two spawned, signalled view servers below.
/** Execute the exact record-answer command offered by resume inside its private repository. */
function recordSetupAnswer(box, command) {
  const result = runFixtureChild('sh', ['-c', command], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
}

/** Open the real local view and wait for its ready line before stopping its owned child. */
async function openSetupView(box) {
  const child = spawn(process.execPath, [join(box.root, 'cli/apps/cli/pullboard.js'), 'view', '--no-open', '--port', '0'],
    { cwd: box.repo, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error(errors || output || 'view closed before ready')));
      child.stderr.on('data', bytes => { errors += bytes; });
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('Pullboard view: http://')) resolve(); });
    });
    assert.match(output, /Pullboard view: http:\/\/127\.0\.0\.1:/u);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

/** Reject stale or foreign receipt data while preserving the view's exact successful receipt. */
async function assertViewReceipt(box) {
  const receiptPath = join(box.repo, '.git/pullboard/view-bind.json');
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.type, 'pullboard.view.bound');
  for (const invalid of [{ ...receipt, boardId: 'another-board' },
    { ...receipt, setupStartedAt: '2000-01-01T00:00:00.000Z' },
    { ...receipt, boundAt: '2000-01-01T00:00:00.000Z' }]) {
    writeFileSync(receiptPath, JSON.stringify(invalid));
    assert.equal(JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout).setup?.step, 5,
      'a receipt for another board or before this setup cannot complete it');
  }
  writeFileSync(receiptPath, receiptBytes);
}

test('a reused authenticated view completes setup for its new board [N26,N32]', async t => {
  const firstBoard = releaseFixture(t);
  const lease = await takeDefaultViewPort(firstBoard.root);
  t.after(() => lease.release());
  /** Prepare a real board through the first four setup steps, leaving only its view unopened. */
  async function awaitingView(box) {
    box.env.PULLBOARD_HOME = firstBoard.env.PULLBOARD_HOME;
    box.env.PULLBOARD_MACHINE_HOME = firstBoard.env.PULLBOARD_MACHINE_HOME;
    box.env.PULLBOARD_VIEW_PORT = String(lease.port);
    delete box.env.PULLBOARD_VIEW_FOREGROUND;
    const file = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.gate = 'true';
    config.lanes = { app: { owns: ['app/'] } };
    writeFileSync(file, JSON.stringify(config));
    const added = await fixtureAdd(box.runLocal, box.repo, 'app', 'First setup item', '--specs', 'N19', '--criterion', 'The fixture has work.');
    assert.equal(added.status, 0, added.failure || added.stderr || added.stdout);
    assert.equal(JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout).setup?.step, 5);
  }
  await awaitingView(firstBoard);
  const child = spawn(process.execPath, [join(firstBoard.root, 'cli/apps/cli/pullboard.js'), 'view', '--no-open', '--json'],
    { cwd: firstBoard.repo, env: { ...firstBoard.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  const first = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.once('error', reject);
    child.once('close', code => reject(new Error(`owned view exited ${code}: ${errors}`)));
    child.stderr.on('data', bytes => { errors += bytes; });
    child.stdout.on('data', bytes => {
      output += bytes;
      try { resolve(JSON.parse(output)); } catch { /* Wait for the complete ready document. */ }
    });
  });
  assert.equal(first.port, lease.port);
  assert.equal(JSON.parse((await firstBoard.runLocal(firstBoard.repo, 'resume', '--diagnostics', '--json')).stdout).setup, null);
  const secondBoard = releaseFixture(t);
  const refusedBoard = releaseFixture(t);
  await awaitingView(secondBoard);
  await awaitingView(refusedBoard);
  const reused = (await secondBoard.runLocal(secondBoard.repo, 'view', '--no-open', '--json'));
  assert.equal(reused.status, 0, reused.failure || reused.stderr || reused.stdout);
  const second = JSON.parse(reused.stdout);
  assert.equal(second.reused, true);
  assert.equal(second.url, first.url);
  assert.equal(JSON.parse((await secondBoard.runLocal(secondBoard.repo, 'resume', '--diagnostics', '--json')).stdout).setup, null,
    'the exact offered view command completes setup on the second board');
  const receiptPath = join(secondBoard.repo, '.git/pullboard/view-reuse.json');
  const bytes = readFileSync(receiptPath);
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.type, 'pullboard.view.reused');
  assert.equal(receipt.boundAt, first.boundAt, 'reuse retains the original bind time');
  assert.equal(receipt.pid, first.pid);
  assert.equal(receipt.port, first.port);
  assert.equal(statSync(receiptPath).mode & 0o077, 0);
  assert.equal(Object.hasOwn(receipt, 'url'), false, 'the setup receipt never copies the session secret');
  for (const invalid of [{ ...receipt, boardId: 'another-board' },
    { ...receipt, setupStartedAt: '2000-01-01T00:00:00.000Z' },
    { ...receipt, openedAt: '2000-01-01T00:00:00.000Z' }]) {
    writeFileSync(receiptPath, JSON.stringify(invalid));
    assert.equal(JSON.parse((await secondBoard.runLocal(secondBoard.repo, 'resume', '--diagnostics', '--json')).stdout).setup?.step, 5,
      'another board or an observation before this setup cannot complete it');
  }
  writeFileSync(receiptPath, bytes);
  const sessionPath = join(firstBoard.env.PULLBOARD_HOME, `view-${lease.port}.json`);
  const sessionBytes = readFileSync(sessionPath);
  try {
    writeFileSync(sessionPath, JSON.stringify({ ...JSON.parse(sessionBytes), secret: 'wrong' }));
    const refused = (await refusedBoard.runLocal(refusedBoard.repo, 'view', '--no-open', '--json'));
    assert.equal(refused.status, 1, refused.failure || refused.stderr || refused.stdout);
    assert.equal(JSON.parse(refused.stdout).error.code, 'PORT_BUSY');
    assert.equal(JSON.parse((await refusedBoard.runLocal(refusedBoard.repo, 'resume', '--diagnostics', '--json')).stdout).setup?.step, 5,
      'an unauthenticated listener cannot complete setup');
  } finally { writeFileSync(sessionPath, sessionBytes); }
});

/** Drive the same actual commands a newcomer receives, with a private fixture person approval. */
async function finishSetup(box, observe = () => {}) {
  // Exercise an explicitly unconfigured gate even when init supplies a safe starter default.
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: '' }));
  /** Assert the next setup block in both the actual text and JSON CLI output. */
  async function step(number) {
    const text = (await box.runLocal(box.repo, 'resume', '--diagnostics'));
    assert.equal(text.status, 0, text.failure || text.stderr);
    assert.match(text.stdout, new RegExp(`Setting up: step ${number} of 5`));
    const json = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
    assert.equal(json.status, 0, json.failure || json.stderr);
    const setup = JSON.parse(json.stdout).setup;
    assert.equal(setup.step, number);
    assert.equal(setup.total, 5);
    assert.ok(setup.question.startsWith('Ask the person:'));
    assert.ok(text.stdout.includes(setup.command));
    observe(number, setup);
    return setup;
  }
  const requirements = await step(1);
  assert.match(requirements.afterAnswer, /person approves the returned ids in Pullboard View or runs pullboard spec approve <ids> in their own terminal/u);
  assert.match(requirements.afterAnswer, /coordinator runs pullboard spec apply/u);
  const drafted = [];
  for (const text of ['Describe the first thing the person wants.', 'Describe how the person will know it works.']) drafted.push(await box.runLocal(box.repo, 'spec', 'draft', text, '--json'));
  for (const result of drafted) assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const requirementIds = drafted.map(result => JSON.parse(result.stdout).id).join(',');
  // The person decision is recorded through the real CLI in a synthetic, private person environment.
  for (const args of [['spec', 'approve', requirementIds], ['spec', 'apply']]) {
    const result = (await box.runLocal(box.repo, ...args));
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  }
  recordSetupAnswer(box, (await step(2)).command);
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  const gate = await step(3);
  assert.match(gate.question, /Suggested: npm test/u);
  recordSetupAnswer(box, gate.command);
  recordSetupAnswer(box, (await step(4)).command);
  const view = await step(5);
  assert.equal(view.command, 'pullboard view');
  assert.match(view.afterAnswer, /person’s own terminal, or start it in the background as the agent/u);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: set up private fixture');
  const builder = (await box.runLocal(box.repo, 'worktree', 'app', '--model', 'Fixture'));
  assert.equal(builder.status, 0, builder.failure || builder.stderr);
  const stillWaiting = JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout);
  assert.equal(stillWaiting.setup?.step, 5, 'registering a builder does not stand in for the view’s own bind receipt');
  const shouted = (await box.runLocal(box.repo, 'shout', 'all', 'Opened Pullboard view for this board.'));
  assert.equal(shouted.status, 0, shouted.failure || shouted.stderr);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout).setup?.step, 5,
    'an ordinary same-text shout cannot impersonate a successful view bind');
  await openSetupView(box);
  await assertViewReceipt(box);
}

test('resume walks a new board through setup one step at a time [N32,N19]', async t => {
  const box = releaseFixture(t, { freshSetup: true });
  mkdirSync(join(box.repo, 'app'));
  const seen = [];
  await finishSetup(box, (number, setup) => {
    seen.push(number);
    if (number === 2) assert.match(setup.question, /Suggested folders: app/u);
  });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  const result = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
  assert.equal(result.status, 0, result.failure || result.stderr);
  assert.equal(JSON.parse(result.stdout).setup, null, 'actual successful view bind completes the board setup');
});

test('resume names lane add to make a lane [I1,N32]', async t => {
  const box = releaseFixture(t, { freshSetup: true });
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: '' }, null, 2));
  mkdirSync(join(box.repo, 'app'));
  const drafted = (await box.runLocal(box.repo, 'spec', 'draft', 'Describe the first thing the person wants.', '--json'));
  assert.equal(drafted.status, 0, drafted.failure || drafted.stderr || drafted.stdout);
  for (const args of [['spec', 'approve', JSON.parse(drafted.stdout).id], ['spec', 'apply']]) {
    const result = (await box.runLocal(box.repo, ...args));
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  }
  const text = (await box.runLocal(box.repo, 'resume', '--diagnostics'));
  assert.equal(text.status, 0, text.failure || text.stderr);
  const setup = JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout).setup;
  assert.equal(setup.step, 2);
  assert.equal(setup.command, 'pullboard lane add app --owns app/');
  assert.ok(text.stdout.includes(setup.command), text.stdout);
  assert.doesNotMatch(text.stdout, /node -e/u);

  // The printed command, run exactly as written, declares the lane and moves setup on.
  recordSetupAnswer(box, setup.command);
  const lanes = (await box.runLocal(box.repo, 'lanes'));
  assert.equal(lanes.status, 0, lanes.failure || lanes.stderr);
  assert.match(lanes.stdout, /^app\s+app\/(?:\s|$)/mu);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'resume', '--diagnostics', '--json')).stdout).setup?.step, 3);
});

test("a set-up board's resume prints no setup steps [N32,N19]", async t => {
  const box = releaseFixture(t, { freshSetup: true });
  await finishSetup(box);
  const result = (await box.runLocal(box.repo, 'resume', '--diagnostics'));
  assert.equal(result.status, 0, result.failure || result.stderr);
  assert.doesNotMatch(result.stdout, /Setting up: step/u);
  const json = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
  assert.equal(JSON.parse(json.stdout).setup, null);
  const proposed = (await box.runLocal(box.repo, 'spec', 'draft', 'A later proposal for the person', '--json'));
  assert.equal(proposed.status, 0, proposed.failure || proposed.stderr || proposed.stdout);
  const later = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
  assert.equal(later.status, 0, later.failure || later.stderr || later.stdout);
  assert.equal(JSON.parse(later.stdout).setup, null, 'a later proposal does not reopen completed setup');
});


test('a new preconfigured board waits for every initial approval [I1,I2]', async t => {
  const box = releaseFixture(t, { freshSetup: true });
  const marker = join(box.repo, '.git/pullboard/setup-started.json');
  const started = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(started.type, 'pullboard.setup.started');
  assert.equal(started.version, 1);
  assert.equal(statSync(marker).mode & 0o077, 0);
  // @pullboard-board-file journey: reads the board the CLI children wrote
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    assert.equal(started.boardId, store.boardId(board));
    assert.equal(started.setupStartedAt, store.listAgents(board).find(agent => agent.agent_id === 'coordinator').agent_created_at);
  } finally { store.closeBoard(board); }
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] } } }));
  for (const text of ['The person chooses the name.', 'The person chooses the color.']) {
    const draft = (await box.runLocal(box.repo, 'spec', 'draft', text));
    assert.equal(draft.status, 0, draft.failure || draft.stderr || draft.stdout);
  }
  for (const args of [['spec', 'approve', 'G1'], ['spec', 'apply'],
    ['add', 'app', 'First setup item', '--specs', 'G1', '--criterion', 'The fixture has work.']]) {
    const result = (await box.runLocal(box.repo, ...args));
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  }
  await openSetupView(box);
  const result = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const setup = JSON.parse(result.stdout).setup;
  assert.equal(setup?.step, 1, 'an early view and preconfigured answers cannot bypass the remaining initial approval');
  assert.deepEqual(setup.rowIds, ['G2']);
  const startedBytes = readFileSync(marker);
  for (const invalid of ['{', JSON.stringify({ ...started, boardId: 'another-board' }),
    JSON.stringify({ ...started, setupStartedAt: '2000-01-01T00:00:00.000Z' })]) {
    writeFileSync(marker, invalid);
    const resumed = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
    assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
    assert.deepEqual(JSON.parse(resumed.stdout).setup?.rowIds, ['G2'],
      'an invalid progress receipt is not evidence of a completed legacy setup');
  }
  writeFileSync(marker, startedBytes);
});

test('an upgraded configured board stays set up before its first resume [I1,I2]', async t => {
  const box = releaseFixture(t, { freshSetup: true });
  await finishSetup(box);
  // Legacy installations have these actual completed setup facts, but neither new lifecycle receipt.
  const stateDirectory = join(box.repo, '.git/pullboard');
  for (const name of ['setup-started.json', 'setup-complete.json']) rmSync(join(stateDirectory, name), { force: true });
  const reinitialized = (await box.runLocal(box.repo, 'init'));
  assert.equal(reinitialized.status, 0, reinitialized.failure || reinitialized.stderr || reinitialized.stdout);
  assert.throws(() => readFileSync(join(stateDirectory, 'setup-started.json')), { code: 'ENOENT' },
    'idempotent init does not classify an existing coordinator as a new enrollment');
  const proposed = (await box.runLocal(box.repo, 'spec', 'draft', 'A proposal drafted before the first upgraded resume', '--json'));
  assert.equal(proposed.status, 0, proposed.failure || proposed.stderr || proposed.stdout);
  const result = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).setup, null, 'a later draft does not reopen a legacy completed setup');
  const complete = JSON.parse(readFileSync(join(stateDirectory, 'setup-complete.json'), 'utf8'));
  const view = JSON.parse(readFileSync(join(stateDirectory, 'view-bind.json'), 'utf8'));
  assert.equal(complete.type, 'pullboard.setup.completed');
  assert.equal(complete.version, 1);
  assert.equal(complete.boardId, view.boardId);
  assert.equal(complete.setupStartedAt, view.setupStartedAt);
  assert.equal(statSync(join(stateDirectory, 'setup-complete.json')).mode & 0o077, 0);
});

test('a board building without spec rows is not told to draft the spec first [I10,B26]', async t => {
  const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = 'true';
  config.lanes = { app: { owns: ['app/'] } };
  writeFileSync(file, JSON.stringify(config));
  mkdirSync(join(box.repo, 'app'));
  writeFileSync(join(box.repo, 'app/first.txt'), 'first working item\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize the private board');
  const spec = (await box.runLocal(box.repo, 'spec', '--json'));
  assert.equal(spec.status, 0, spec.failure || spec.stderr);
  assert.deepEqual(JSON.parse(spec.stdout).rows.filter(row => row.file === 'SPEC.md'), []);
  const added = await fixtureAdd(box.runLocal, box.repo, 'app', 'Build the first useful thing', '--criterion', 'The first useful thing works.', '--json');
  assert.equal(added.status, 0, added.failure || added.stderr || added.stdout);
  assert.equal(JSON.parse(added.stdout).item.item_spec_ids, '', 'real board items need no spec rows');
  for (let repeat = 0; repeat < 2; repeat++) {
    const resumed = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
    assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
    const card = JSON.parse(resumed.stdout);
    assert.notEqual(card.setup?.step, 1, 'an active rowless board skips the required spec step');
    assert.doesNotMatch(card.next, /spec draft|decompose|person.*approv/iu,
      'the work has an actionable next step without spec approval');
    if (card.setup) {
      const specStep = card.setup.steps.find(step => step.number === 1);
      assert.equal(specStep.done, true);
      assert.match(specStep.question, /optional/iu);
      assert.match(specStep.command, /pullboard spec draft/u);
    }
    const text = (await box.runLocal(box.repo, 'resume', '--diagnostics'));
    assert.equal(text.status, 0, text.failure || text.stderr || text.stdout);
    assert.match(text.stdout, /spec rows are optional[^\n]*pullboard spec draft/iu,
      'resume offers the way to add rows without making it the work prerequisite');
    assert.doesNotMatch(text.stdout, /^next: .*spec draft/mu);
  }
  await openSetupView(box);
  for (let repeat = 0; repeat < 2; repeat++) {
    const resumed = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
    assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
    const card = JSON.parse(resumed.stdout);
    assert.equal(card.setup, null, 'the working board can finish setup without adding rows');
    assert.doesNotMatch(card.next, /spec draft|decompose|person.*approv/iu,
      'completed setup keeps directing the coordinator to the actual work');
  }
});
