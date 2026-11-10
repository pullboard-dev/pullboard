import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { proposeSentinel as nativeProposeSentinel } from '../../../../packages/sentinels/index.js';
import { decideSentinel as nativeDecideSentinel } from '../../../../packages/sentinels/index.js';
import { beginSentinelRun as nativeBeginSentinelRun } from '../../../../packages/sentinels/index.js';
import { finishSentinelRun as nativeFinishSentinelRun } from '../../../../packages/sentinels/index.js';
/** Real board watches: exact person approval, automatic execution, owner notices and replay [A6,D1,D3,H16]. */
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { eventCauses } from '../../../../packages/store/index.js';
import { rigorReport } from '../../../../packages/store/index.js';
import { executeSentinel } from '../../../../packages/sentinels/index.js';
import { runDueSentinels } from '../../../../packages/sentinels/index.js';
import { startServeSentinel } from '../../../../packages/sentinels/index.js';
import { BOARD_SENTINEL_ENGINE } from '../../../../packages/sentinels/index.js';
import { sentinelDefinition } from '../../../../packages/sentinels/index.js';
import { sentinelDigest } from '../../../../packages/sentinels/index.js';
import { dueSentinels } from '../../../../packages/sentinels/index.js';
import { sentinels } from '../../../../packages/sentinels/index.js';
import { executeMove } from '../../../../packages/api/index.js';
import { moveArgs } from '../../../../packages/person/index.js';
import {
  personRequestMove,
  preparePersonRequest,
} from '../../../../packages/person/light.js';
import {
  personRequestRecords,
  receivePersonRequest,
  requestIntentDigest,
  requestMoveProblem,
  requestStageText,
} from '../../../../packages/link/index.js';
import { PEOPLE_ENGINE } from '../../../../packages/state/light.js';
import { sentinelDraftNeeds } from '../../../../packages/sentinels/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import { frozenCriterion } from '../../../../packages/spec/index.js';
import { loadSpec } from '../../../../packages/spec/index.js';
import { parseProcessCensus } from '../../../../packages/kernel/light.js';
import { requireSupportedEngine as requirePublished55Engine } from '../../../../packages/kernel/tests/fixtures/reader.js';

/** The model the fixture seat registers with and joins as. */
const FIXTURE_MODEL = 'gpt-6.1-sol';

/** Isolate actual SQLite, Git, settings and subprocess files; due time is explicitly injected. */
function fixture(t, { agentRoute } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-board-watch-')));
  const root = join(directory, 'repo'); mkdirSync(root);
  const overrides = { PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n\n## A\n- A6 [approved, must] Watch the board. | gate: review\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Fixture\n\n## PB\n- PB1 [approved, must] Keep the fixture private. | gate: review\n');
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '-m', 'chore: private watch fixture [A6]'], { cwd: root, env });
  const settings = machineSettingsFile(); mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false } }));
  const clock = { time: Date.parse('2026-10-18T03:00:00Z'), now() { return new Date(this.time); } };
  const board = openBoard(join(root, '.git/pullboard/board.sqlite'), clock);
  store.register(board, { lane: 'coordinator', path: root });
  // A join on this seat's worktree must name the model it registered with, or join refuses ALREADY_JOINED.
  const agent = store.register(board, { lane: 'core', path: join(directory, 'agent'), route: agentRoute, model: FIXTURE_MODEL });
  /** Apply the actual ordered board engine with deterministic injected receipt time. */
  const ordered = async (operation, args) => {
    const move = prepareEngineMove(board, operation, args);
    const receipt = applyEngineMove(board, move, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString() });
    assert.equal(receipt.error, undefined, JSON.stringify(receipt)); return receipt.result;
  };
  /** Run the actual CLI against this real board; view means the explicit test person adapter. */
  const cli = async (args, personChannel, cwd = root) => {
    let output = ''; let error = '';
    const code = await main([...args, '--json'], { cwd, clock, personChannel,
      stdout: { isTTY: false, write: text => { output += text; } }, stderr: { write: text => { error += text; } } });
    return { code, document: output ? JSON.parse(output) : null, error };
  };
  t.after(() => {
    store.closeBoard(board); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { root, directory, board, agent, clock, ordered, cli, env,
    run: () => runDueSentinels({ root, board, agentId: 'coordinator', ordered, parseProcessCensus }) };
}

/** Quote only a controlled fixture path as a shell word. */
function quote(word) { return `'${word.replaceAll("'", "'\\''")}'`; }

/** Write one actual checker and return the command the person will approve. */
function checker(box, source, name = 'check.mjs') {
  const path = join(box.root, name); writeFileSync(path, source);
  return `${quote(process.execPath)} ${quote(path)}`;
}

/**
 * A cause that repeated on two real items, and two real commits that prove a check for it: the check is red where
 * the items failed and green once the fix exists (#776).
 */
function repeatedCause(box) {
  const git = (...args) => runFixtureGit(args, { cwd: box.root, env: box.env, encoding: 'utf8' });
  writeFileSync(join(box.root, 'site.txt'), 'staging is down\n');
  git('add', 'site.txt'); git('commit', '-q', '-m', 'chore: staging down [A6]');
  const red = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(box.root, 'up.txt'), 'staging is up\n');
  git('add', 'up.txt'); git('commit', '-q', '-m', 'chore: staging up [A6]');
  const green = git('rev-parse', 'HEAD').trim();
  const reviewer = store.register(box.board, { lane: 'core', path: join(box.directory, 'reviewer') });
  const config = loadConfig(box.root);
  const freeze = (item) => frozenCriterion(loadSpec(box.root, config), item, loadDoctrine(box.root, config));
  const items = [];
  for (const title of ['Staging first', 'Staging second']) {
    const id = store.addItem(box.board, { by: 'coordinator', lane: 'core', title, criterion: 'Watch the board.', specIds: ['A6'] });
    store.claim(box.board, id, { agentId: box.agent, lane: 'core', leaseMs: 3_600_000, freeze });
    submitFixture(box.board, id, { agentId: box.agent, commit: red, tree: `tree-${red}` });
    store.verify(box.board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'staging check failed', clause: 'Watch the board.', cause: 'row:A6',
      head: store.getItem(box.board, id).item_commit, digest: store.getItem(box.board, id).item_frozen_digest, policy: 'any' });
    items.push(id);
  }
  return { red, green, items, check: 'test -f up.txt' };
}

test('resume never runs a sentinel and sentinel run runs the due ones [N26,A6,D3]', async t => {
  const resumeChildren = [];
  // Register before fixture cleanup so a regression's owned process cannot outlive its files.
  t.after(async () => {
    for (const { child, detached } of resumeChildren) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, 'close');
      try {
        if (detached && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await closed;
    }
  });
  const box = fixture(t, { agentRoute: 'mid' });
  const marker = join(box.directory, 'explicit-run.json');
  writeFileSync(join(box.root, 'value.txt'), 'committed trunk input');
  writeFileSync(join(box.root, 'trunk-check.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const value=readFileSync('value.txt','utf8');
appendFileSync(${JSON.stringify(marker)},JSON.stringify({cwd:process.cwd(),value})+'\\n');
console.log('explicit trunk receipt: '+value);
`);
  runFixtureGit(['add', 'trunk-check.mjs', 'value.txt'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test: committed sentinel input [N26,A6]'], { cwd: box.root, env: box.env });
  const agentRoot = join(box.directory, 'agent');
  runFixtureGit(['worktree', 'add', '--quiet', '--detach', agentRoot, 'main'], { cwd: box.root, env: box.env });
  const joined = await box.cli(['join', 'core', '--model', FIXTURE_MODEL, '--route', 'mid'], undefined, agentRoot);
  assert.equal(joined.code, 0, joined.error || JSON.stringify(joined.document));
  writeFileSync(join(agentRoot, 'value.txt'), 'uncommitted agent input');
  const command = `${quote(process.execPath)} trunk-check.mjs`;
  const proposed = await box.cli(['sentinel', 'propose', 'trunk-check', '--check', command, '--every', 'hourly', '--owner', box.agent, '--timeout', '35000']);
  assert.equal(proposed.code, 0, proposed.error || JSON.stringify(proposed.document));
  const approved = await box.cli(['sentinel', 'approve', 'trunk-check'], 'view');
  assert.equal(approved.code, 0, approved.error || JSON.stringify(approved.document));

  assert.deepEqual(dueSentinels(box.board).map(row => row.name), ['trunk-check']);
  // This local fixture disables background workers. Observe actual process creation before child scheduling,
  // so an unref'ed checker cannot hide behind the parent returning before its marker is written.
  const spawnProcess = ChildProcess.prototype.spawn;
  /** Observe the real spawn, preserving its receiver and result while retaining exact child ownership. */
  const observedSpawn = t.mock.method(ChildProcess.prototype, 'spawn', function (options) {
    const result = Reflect.apply(spawnProcess, this, [options]);
    const record = { child: this, detached: Boolean(options.detached), args: options.args };
    this.once('error', error => { record.error = error; });
    resumeChildren.push(record);
    return result;
  });
  let resumed;
  try { resumed = await box.cli(['resume'], undefined, agentRoot); }
  finally { observedSpawn.mock.restore(); }
  assert.equal(resumed.code, 0, resumed.error || JSON.stringify(resumed.document));
  const checkerChildren = resumeChildren.filter(row => row.detached
    || JSON.stringify(row.args) !== JSON.stringify(['git', '--no-replace-objects', 'cat-file', '--batch']));
  assert.deepEqual(checkerChildren.map(row => row.args), [], 'resume starts no checker process, including a detached checker');
  assert.equal(existsSync(marker), false, 'resume neither runs the watch nor detaches a checker into the agent session');
  assert.equal(sentinels(box.board)[0].lastRun, null);
  assert.deepEqual(store.events(box.board).filter(row => ['sentinel-start', 'sentinel-run'].includes(row.event_kind)), []);
  assert.deepEqual(dueSentinels(box.board).map(row => row.name), ['trunk-check'], 'resume leaves the approved watch due');

  const run = await box.cli(['sentinel', 'run'], undefined, agentRoot);
  assert.equal(run.code, 0, run.error || JSON.stringify(run.document));
  const executions = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(executions.length, 1, 'only the explicit run executes the checker');
  const [executed] = executions;
  assert.notEqual(executed.cwd, agentRoot, 'the explicit runner never uses the agent checkout');
  assert.notEqual(executed.cwd, box.root, 'the runner prepares a separate checkout rather than using live trunk');
  assert.equal(executed.value, 'committed trunk input', 'the run reads trunk, not the dirty agent file');
  assert.equal(existsSync(executed.cwd), false, 'the prepared checkout is cleaned after its owned check finishes');
  const watched = sentinels(box.board)[0];
  assert.equal(watched.lastRun.green, true);
  assert.match(watched.lastRun.output, /explicit trunk receipt: committed trunk input/u);
  assert.equal(watched.check, command, 'the approved command is not rewritten for the new execution directory');
  assert.deepEqual(store.events(box.board).filter(row => ['sentinel-start', 'sentinel-run'].includes(row.event_kind))
    .map(row => [row.event_kind, JSON.parse(row.event_detail).name]), [['sentinel-start', 'trunk-check'], ['sentinel-run', 'trunk-check']]);
  assert.deepEqual(dueSentinels(box.board), [], 'the explicit run consumes the due watch');
  assert.equal(readFileSync(join(agentRoot, 'value.txt'), 'utf8'), 'uncommitted agent input');
  const help = await box.cli(['sentinel', 'run', '--help']);
  assert.equal(help.code, 0, help.error);
  assert.match(JSON.stringify(help.document), /cron|scheduled CI/iu);
});

test('a repeated cause can be drafted as a sentinel [A6,D1,D3]', async t => {
  const box = fixture(t);
  const cause = repeatedCause(box);
  const spec = readFileSync(join(box.root, 'SPEC.md'), 'utf8');
  const drafted = await box.cli(['rigor', 'draft', 'row:A6', '--sentinel', '--check', cause.check, '--red', cause.red, '--green', cause.green,
    '--every', 'daily', '--owner', 'core']);
  assert.equal(drafted.code, 0, drafted.error);
  const sentinel = drafted.document.sentinel;
  assert.deepEqual([sentinel.name, sentinel.status, sentinel.check, sentinel.every, sentinel.owner], ['rigor-row-a6', 'pending', cause.check, 'daily', 'core'],
    'the draft is a pending watch with its command, cadence and owner');
  assert.equal(sentinel.evidence.key, 'row:A6');
  assert.deepEqual(sentinel.evidence.items.map(item => item.id), cause.items, 'it cites both repeats');
  assert.equal(sentinel.evidence.occurrences, 2);
  assert.deepEqual([sentinel.evidence.proof.red.commit, sentinel.evidence.proof.green.commit], [cause.red, cause.green], 'and the commits that prove its check');
  assert.deepEqual(drafted.document.drafts, [], 'a sentinel draft writes no spec or doctrine row');
  assert.equal(readFileSync(join(box.root, 'SPEC.md'), 'utf8'), spec);
  const listed = await box.cli(['sentinels']);
  assert.equal(listed.document.sentinels[0].status, 'pending');
  assert.equal(listed.document.sentinels[0].evidence.key, 'row:A6');
  await box.run(); assert.equal(sentinels(box.board)[0].lastRun, null, 'a drafted watch never runs before the person approves it');
});

test('a sentinel draft waits in Needs-you with its evidence [A6,D1,D3]', async t => {
  const box = fixture(t);
  const cause = repeatedCause(box);
  assert.equal((await box.cli(['rigor', 'draft', 'row:A6', '--sentinel', '--check', cause.check, '--red', cause.red, '--green', cause.green])).code, 0);
  // Asking an agent to watch something drafts the same kind of row, with no repeat to cite.
  assert.equal((await box.cli(['sentinel', 'propose', 'staging-site', '--check', 'true', '--every', 'hourly', '--owner', 'core'])).code, 0);
  const pending = (await box.cli(['resume'])).document.needsYou.filter(entry => entry.kind === 'sentinel-draft');
  assert.deepEqual(pending.map(entry => entry.ref).sort(), ['rigor-row-a6', 'staging-site'], 'each pending watch is one Needs-you call');
  const drafted = pending.find(entry => entry.ref === 'rigor-row-a6');
  assert.equal(drafted.cause, 'row:A6');
  assert.deepEqual(drafted.evidence.items.map(item => item.id), cause.items, 'the call carries the repeats it cites');
  assert.equal(drafted.evidence.proof.green.commit, cause.green);
  assert.match(drafted.text, /^Sentinel draft: rigor-row-a6 runs test -f up\.txt hourly, reporting to coordinator$/u);
  assert.match(drafted.what, /pullboard sentinel approve rigor-row-a6/u);
  const approved = await box.cli(['sentinel', 'approve', 'rigor-row-a6'], 'view');
  assert.equal(approved.code, 0, approved.error);
  const after = (await box.cli(['resume'])).document.needsYou.filter(entry => entry.kind === 'sentinel-draft').map(entry => entry.ref);
  assert.deepEqual(after, ['staging-site'], 'the person’s approval closes the call');
  const watched = sentinels(box.board).find(row => row.name === 'rigor-row-a6');
  assert.equal(watched.status, 'approved');
  assert.equal(watched.lastRun, null, 'approval and resume leave execution to the scheduled command');
  const explicit = await box.cli(['sentinel', 'run']);
  assert.equal(explicit.code, 0, explicit.error || JSON.stringify(explicit.document));
  assert.equal(sentinels(box.board).find(row => row.name === 'rigor-row-a6').lastRun?.green, true);
});

test('an approved sentinel execution reports to its owner once [A6,D1,D3]', async t => {
  const box = fixture(t);
  mkdirSync(join(box.root, 'watch'));
  const check = checker(box, "import {existsSync,appendFileSync} from 'node:fs'; appendFileSync('runs','run\\n'); console.log('check receipt'); process.exit(existsSync('green')?0:1);");
  const proposal = await box.cli(['sentinel', 'propose', 'staging', '--check', check, '--every', '10m', '--owner', box.agent,
    '--directory', 'watch', '--next', 'repair the staging check']);
  assert.equal(proposal.code, 0, proposal.error);
  assert.equal(proposal.document.sentinel.status, 'pending');
  await box.run(); assert.equal(existsSync(join(box.root, 'watch/runs')), false, 'unapproved commands never execute');
  const approved = await box.cli(['sentinel', 'approve', 'staging'], 'view');
  assert.equal(approved.code, 0, approved.error);
  assert.equal(approved.document.sentinel.status, 'approved');
  await box.run();
  let notices = store.allShouts(box.board).filter(row => row.shout_from === 'sentinel');
  assert.equal(notices.length, 1); assert.equal(notices[0].shout_to, box.agent);
  assert.match(notices[0].shout_text, /staging[\s\S]*check receipt[\s\S]*Next: repair the staging check/u);
  assert.equal(readFileSync(join(box.root, 'watch/runs'), 'utf8'), 'run\n', 'execution uses the approved per-watch directory');
  await box.run(); assert.equal(readFileSync(join(box.root, 'watch/runs'), 'utf8'), 'run\n', 'not due means no child');
  box.clock.time += 600_001;
  await box.run();
  assert.equal(store.allShouts(box.board).filter(row => row.shout_from === 'sentinel').length, 1, 'a second red run sends no duplicate notice');
  assert.equal(store.events(box.board).filter(row => row.event_kind === 'sentinel-failure').length, 2, 'every actual red run retains its own cause receipt');
  const report = rigorReport(store.events(box.board), { person: store.PERSON });
  assert.equal(report.causes.find(row => row.key === 'sentinel:staging')?.occurrences, 2);
  writeFileSync(join(box.root, 'watch/green'), 'yes'); box.clock.time += 600_001;
  await box.run();
  notices = store.allShouts(box.board).filter(row => row.shout_from === 'sentinel');
  assert.equal(notices.length, 2); assert.match(notices[1].shout_text, /^Cleared: staging/u);
  box.clock.time += 600_001; await box.run();
  assert.equal(store.allShouts(box.board).filter(row => row.shout_from === 'sentinel').length, 2, 'staying green sends no duplicate cleared notice');
  const listed = await box.cli(['sentinels']);
  assert.equal(listed.code, 0, listed.error);
  assert.equal(listed.document.sentinels[0].lastRun.green, true);
  assert.equal(listed.document.sentinels[0].owner, box.agent);
  assert.equal(listed.document.sentinels[0].history.length, 4);
});

test('an agent cannot approve a sentinel [A6,D3,H16]', async t => {
  const box = fixture(t);
  const row = nativeProposeSentinel(box.board, { agentId: box.agent, row: { name: 'private-check', check: 'true', every: 'hourly', owner: 'core' } });
  const before = exportBoard(box.board);
  assert.throws(() => nativeDecideSentinel(box.board, { agentId: box.agent, channel: 'view', name: row.name, digest: row.digest, decision: 'approve' }), error => error.code === 'B26_PERSON_APPROVAL');
  assert.deepEqual(exportBoard(box.board), before);
  const forged = prepareEngineMove(box.board, 'decideSentinel', [{ agentId: store.PERSON, channel: 'view', name: row.name, digest: row.digest, decision: 'approve' }]);
  for (const sender of [{ kind: 'agent', agent: box.agent, userId: 'fixture' }, { kind: 'machine', machine: 'fixture', userId: 'fixture' }]) {
    const receipt = applyRelayMove(box.board, { ...forged, id: `forged-${sender.kind}` }, {
      sequence: appliedSequence(box.board) + 1, at: box.clock.now().toISOString(), kind: 'move', sender });
    assert.equal(receipt.error?.code, 'RELAY_PERSON_ONLY');
    assert.equal(sentinels(box.board)[0].status, 'pending');
  }
  const key = 'CODEX_THREAD_ID'; const previous = process.env[key]; process.env[key] = 'fixture-agent';
  try {
    const attempt = await box.cli(['sentinel', 'approve', row.name]);
    assert.equal(attempt.code, 1); assert.equal(attempt.document.error.code, 'B26_PERSON_CHANNEL');
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

test('a changed command, directory or schedule loses approval and stale receipts cannot restore it [A6,H16]', async t => {
  const box = fixture(t);
  const definition = { name: 'daily-check', check: 'true', every: 'daily', owner: 'coordinator' };
  const initial = nativeProposeSentinel(box.board, { agentId: box.agent, row: definition });
  nativeDecideSentinel(box.board, { agentId: store.PERSON, channel: 'view', name: initial.name, digest: initial.digest, decision: 'approve' });
  for (const change of [{ check: 'false' }, { directory: 'other' }, { every: 'hourly' }, { owner: 'core' }, { timeoutMs: 500 }]) {
    const changed = nativeProposeSentinel(box.board, { agentId: box.agent, row: { ...definition, ...change } });
    assert.notEqual(changed.digest, initial.digest); assert.equal(changed.status, 'pending');
    const before = exportBoard(box.board);
    assert.throws(() => nativeDecideSentinel(box.board, { agentId: store.PERSON, channel: 'view', name: initial.name, digest: initial.digest, decision: 'approve' }), error => error.code === 'STALE_SENTINEL');
    assert.deepEqual(exportBoard(box.board), before);
    assert.equal(nativeBeginSentinelRun(box.board, { agentId: box.agent, name: changed.name, digest: changed.digest, run: 'not-approved' }), null);
  }
  const current = sentinels(box.board)[0];
  nativeDecideSentinel(box.board, { agentId: store.PERSON, channel: 'view', name: current.name, digest: current.digest, decision: 'decline', reason: 'Not this check' });
  assert.equal((await box.run()).length, 0);
  assert.equal(sentinels(box.board)[0].status, 'declined');
});

test('simultaneous observers run one child and an identical approval cannot steal its lease [A6,H16]', async t => {
  const box = fixture(t);
  const check = checker(box, "import {appendFileSync} from 'node:fs'; appendFileSync('count','run\\n');");
  const row = nativeProposeSentinel(box.board, { agentId: box.agent, row: { name: 'one-child', check, every: '10m', owner: 'core' } });
  nativeDecideSentinel(box.board, { agentId: store.PERSON, channel: 'view', name: row.name, digest: row.digest, decision: 'approve' });
  await Promise.all([box.run(), box.run()]);
  assert.equal(readFileSync(join(box.root, 'count'), 'utf8'), 'run\n');
  box.clock.time += 600_001;
  const started = nativeBeginSentinelRun(box.board, { agentId: box.agent, name: row.name, digest: row.digest, run: 'claimed-run' });
  assert.ok(started);
  nativeDecideSentinel(box.board, { agentId: store.PERSON, channel: 'view', name: row.name, digest: row.digest, decision: 'approve' });
  assert.equal(nativeBeginSentinelRun(box.board, { agentId: 'coordinator', name: row.name, digest: row.digest, run: 'must-not-run' }), null);
});

test('watch timeout drains its owned child group and retains only bounded final output [A6]', async t => {
  const box = fixture(t);
  const check = checker(box, "import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync('child-pid',String(child.pid));console.log('x'.repeat(50000));console.log('final receipt');setInterval(()=>{},1000);");
  const row = sentinelDefinition({ name: 'bounded', check, every: '10m', owner: 'coordinator', timeoutMs: 3_000 }); // budget: actual checker hang ceiling, with startup room under shared CI load.
  const result = await executeSentinel(box.root, row, { parseProcessCensus });
  assert.equal(result.green, false); assert.equal(result.timedOut, true);
  assert.ok(result.output.length <= 16_384); assert.match(result.output, /final receipt/u);
  const pid = Number(readFileSync(join(box.root, 'child-pid'), 'utf8'));
  const status = runFixtureChild('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  assert.ok(status.status !== 0 || /^\s*Z/u.test(status.stdout), 'the owned descendant is gone or reaped to a non-running zombie');
});

test('a project directory symlink cannot change an approved watch into outside execution [A6]', async t => {
  const box = fixture(t); const outside = join(box.directory, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(box.root, 'escape'), 'dir');
  const row = sentinelDefinition({ name: 'inside', check: 'echo must-not-run', every: 'daily', owner: 'coordinator', directory: 'escape' });
  await assert.rejects(executeSentinel(box.root, row, { parseProcessCensus }), error => error.code === 'BAD_SENTINEL');
  assert.throws(() => sentinelDefinition({ ...row, directory: '../outside' }), error => error.code === 'BAD_SENTINEL');
});

test('a published engine-55 reader refuses a board watch before inspecting it [A6,H16]', t => {
  const box = fixture(t);
  assert.equal(BOARD_SENTINEL_ENGINE, 56, 'board watches keep the first engine released with their operations');
  const move = prepareEngineMove(box.board, 'proposeSentinel', [{ agentId: box.agent,
    row: { name: 'new-watch', check: 'false', every: 'hourly', owner: 'core' } }]);
  let payloadReads = 0;
  const unread = new Proxy(move, {
    /** Fail if version negotiation reaches operation-specific data. */
    get(target, property, receiver) {
      if (property === 'operation' || property === 'args') {
        payloadReads += 1;
        throw new Error('the released reader inspected a newer move payload');
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => requirePublished55Engine(unread), error => error.code === 'ENGINE_VERSION'
    && error.message.includes(String(move.engine)) && error.message.includes('55'));
  assert.equal(payloadReads, 0, 'the published version guard rejects before interpreting the new operation or arguments');
});

test('watch receipts replay deterministically, export without execution and keep older engines unchanged [A6,H16]', async t => {
  const box = fixture(t); const replica = openBoard(':memory:', box.clock); t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(box.board));
  const args = [{ agentId: box.agent, row: { name: 'replayed', check: 'false', every: '10m', owner: 'core' } }];
  const move = prepareEngineMove(box.board, 'proposeSentinel', args);
  const at = box.clock.now().toISOString();
  const first = applyEngineMove(box.board, move, { sequence: 1, at });
  const second = applyEngineMove(replica, move, { sequence: 1, at });
  assert.deepEqual(second, first); assert.deepEqual(exportBoard(replica), exportBoard(box.board));
  const before = exportBoard(replica);
  assert.throws(() => applyEngineMove(replica, { ...move, engine: BOARD_SENTINEL_ENGINE - 1, id: 'old-engine' }, { sequence: 2, at }), error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(replica), before);
  const legacy = { event_kind: 'sentinel-failure', event_by: 'sentinel', item_id: null,
    event_detail: JSON.stringify({ engine: BOARD_SENTINEL_ENGINE - 1, cause: 'sentinel:replayed' }) };
  assert.deepEqual(eventCauses(legacy), []);
  assert.equal(rigorReport([legacy, legacy], { person: store.PERSON }).causes.length, 0);
  assert.notEqual(sentinelDigest({ ...args[0].row, every: 'daily' }), first.result.digest);
});

test('a missing census provider cannot launch a watch or claim its ordered lease [A6,H16]', async t => {
  const box = fixture(t);
  const check = checker(box, "import {writeFileSync} from 'node:fs'; writeFileSync('unexpected-watch','launched');");
  const row = nativeProposeSentinel(box.board, { agentId: box.agent,
    row: { name: 'missing-census', check, every: 'hourly', owner: 'core' } });
  nativeDecideSentinel(box.board, { agentId: store.PERSON, channel: 'view', name: row.name, digest: row.digest, decision: 'approve' });
  const before = exportBoard(box.board);
  await assert.rejects(executeSentinel(box.root, row), error => error.code === 'SENTINEL_DRAIN');
  await assert.rejects(runDueSentinels({ root: box.root, board: box.board, agentId: 'coordinator', ordered: box.ordered }),
    error => error.code === 'SENTINEL_DRAIN');
  assert.deepEqual(exportBoard(box.board), before, 'a missing custody provider does not consume a watch lease or publish a receipt');
  assert.equal(existsSync(join(box.root, 'unexpected-watch')), false, 'no checker runs before its census provider is supplied');
});

test('an unavailable supplied census refuses the watch before releasing its start pipe [A6]', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group start handshake');
  const box = fixture(t);
  const check = checker(box, "import {writeFileSync} from 'node:fs'; writeFileSync('unexpected-watch','launched');");
  let observed = 0;
  await assert.rejects(executeSentinel(box.root, sentinelDefinition({ name: 'unavailable-census', check, every: 'hourly', owner: 'core' }), {
    parseProcessCensus: stdout => { observed++; assert.equal(typeof stdout, 'string'); return null; },
  }), error => error.code === 'SENTINEL_DRAIN');
  assert.ok(observed > 0, 'the provided parser receives the real POSIX census');
  assert.equal(existsSync(join(box.root, 'unexpected-watch')), false, 'a failed census cannot be mistaken for an empty owned group');
});

/** Read a real locale-stable child census without confusing failure with an empty process set. */
function childCensus() {
  const read = runFixtureChild('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(read.status, 0); const rows = parseProcessCensus(read.stdout); assert.ok(rows); return rows;
}

/** Compare the captured PID, group, start and executable before touching this fixture's child. */
function sameChild(left, right) {
  return left && right && left.pid === right.pid && left.pgid === right.pgid && left.started === right.started && left.processSha256 === right.processSha256;
}

test('a successful watch drains an unreferenced descendant before returning its receipt [A6]', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group drain');
  const box = fixture(t);
  const check = checker(box, "import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e',\"setInterval(()=>{},1000)\"],{stdio:'ignore'});writeFileSync('background-pid',String(c.pid));c.unref();");
  let owned;
  t.after(async () => {
    if (!owned) return;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const current = childCensus().get(owned.pid);
      if (!current || current.state.startsWith('Z')) return;
      assert.ok(sameChild(owned, current), 'fixture cleanup requires the exact captured child identity');
      try { process.kill(owned.pid, signal); } catch(error) { if(error.code !== 'ESRCH') throw error; }
      const deadline = Date.now()+2_000;
      while(Date.now()<deadline) { const child=childCensus().get(owned.pid); if(!child || child.state.startsWith('Z')) return; await new Promise(resolve=>setTimeout(resolve,25)); }
    }
    assert.fail('the positively owned fixture child did not drain');
  });
  const result = await executeSentinel(box.root, sentinelDefinition({name:'background',check,every:'hourly',owner:'coordinator'}), { parseProcessCensus });
  const pid = Number(readFileSync(join(box.root, 'background-pid'), 'utf8'));
  owned = childCensus().get(pid);
  assert.equal(result.green, true);
  assert.ok(!owned || owned.state.startsWith('Z'), 'a successful receipt must not precede its owned descendant shutdown');
});

test('watch receipts reject extra or contradictory fields without consuming the run lease [A6,H16]', t => {
  const box=fixture(t);
  const row=nativeProposeSentinel(box.board,{agentId:box.agent,row:{name:'receipt',check:'true',every:'hourly',owner:'core'}});
  nativeDecideSentinel(box.board,{agentId:store.PERSON,channel:'view',name:row.name,digest:row.digest,decision:'approve'});
  nativeBeginSentinelRun(box.board,{agentId:box.agent,name:row.name,digest:row.digest,run:'receipt-run'});
  const args={agentId:box.agent,name:row.name,digest:row.digest,run:'receipt-run'};
  const good={green:true,code:0,timedOut:false,signal:null,aborted:false,durationMs:1,output:'done'};
  for(const result of [{...good,extra:'not a receipt field'},{...good,green:false},{...good,signal:'bad signal'}, {...good,aborted:'false'}, {...good,code:-1}]) {
    const before=exportBoard(box.board);
    assert.throws(()=>nativeFinishSentinelRun(box.board,{...args,result}),error=>error.code==='BAD_SENTINEL');
    assert.deepEqual(exportBoard(box.board),before,'invalid receipts neither write events nor consume the lease');
  }
  nativeFinishSentinelRun(box.board,{...args,result:good});
  assert.equal(sentinels(box.board)[0].lastRun.green,true);
});


test('cancellation after a watch lease but before launch records no false failure [A6,H16]', async t => {
  const box=fixture(t), controller=new AbortController();
  const row=nativeProposeSentinel(box.board,{agentId:box.agent,row:{name:'cancelled',check:'true',every:'hourly',owner:'core'}});
  nativeDecideSentinel(box.board,{agentId:store.PERSON,channel:'view',name:row.name,digest:row.digest,decision:'approve'});
  await runDueSentinels({root:box.root,board:box.board,agentId:'coordinator',ordered:box.ordered,signal:controller.signal,parseProcessCensus,
    execute:async (root,definition,options)=>{controller.abort();return executeSentinel(root,definition,options);}});
  assert.equal(sentinels(box.board)[0].lastRun.aborted,true,'cancellation keeps its actual outcome');
  assert.equal(store.events(box.board).filter(event=>event.event_kind==='sentinel-failure').length,0,'shutdown does not invent a Rigor failure');
  assert.equal(store.allShouts(box.board).filter(shout=>shout.shout_from==='sentinel').length,0,'shutdown creates no failure or recovery finding');
});

test('a successful watch drains a descendant that ignores TERM before publishing its receipt [A6]', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group drain');
  const box = fixture(t);
  const childFile = join(box.root, 'stubborn-child.mjs');
  writeFileSync(childFile, "import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); writeFileSync('stubborn-pid',String(process.pid)); process.send('ready'); process.disconnect();");
  const check = checker(box, `import {spawn} from 'node:child_process'; import {once} from 'node:events'; const child=spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:['ignore','ignore','ignore','ipc']}); await once(child,'message'); child.unref();`, 'stubborn-parent.mjs');
  let owned;
  t.after(async () => {
    if (!owned) return;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const current = childCensus().get(owned.pid);
      if (!current || current.state.startsWith('Z')) return;
      assert.ok(sameChild(owned, current), 'cleanup requires the captured PID, start, group and executable');
      try { process.kill(owned.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 2_000; // budget: exact owned-child shutdown grace, not a speed assertion.
      while (Date.now() < deadline) {
        const child = childCensus().get(owned.pid);
        if (!child || child.state.startsWith('Z')) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.fail('the positively owned stubborn fixture child did not drain');
  });
  const running = executeSentinel(box.root, sentinelDefinition({ name: 'stubborn', check, every: 'hourly', owner: 'coordinator', timeoutMs: 10_000 }), { parseProcessCensus }); // budget: fixture command hang ceiling, no throughput claim.
  void running.catch(() => {});
  const pidFile = join(box.root, 'stubborn-pid');
  const readyDeadline = Date.now() + 10_000; // budget: wait for the fixture's actual child-start receipt.
  while (!existsSync(pidFile) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(existsSync(pidFile), 'the descendant installs its TERM handler before its parent exits');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  owned = childCensus().get(pid);
  const result = await running;
  assert.equal(result.green, true, 'the approved parent succeeded');
  const remaining = childCensus().get(pid);
  assert.ok(!remaining || remaining.state.startsWith('Z'), 'no receipt precedes the stubborn descendant shutdown');
});

test('the background observer leaves approved board watches for explicit runs [A6,D3]', async t => {
  const box = fixture(t);
  const check = checker(box, "import {appendFileSync} from 'node:fs'; appendFileSync('background-runs','run\\n'); console.log('background receipt'); process.exit(1);");
  const row = nativeProposeSentinel(box.board, { agentId: box.agent, row: { name: 'background', check, every: '10m', owner: box.agent } });
  let tick;
  let cancelled = false;
  const errors = [];
  const timer = { unref() {} };
  const observer = startServeSentinel({ projectRoot: box.root,
    every: (callback, interval) => { assert.equal(interval, 600_000, 'the production cadence is unchanged'); tick = callback; return timer; },
    cancel: actual => { assert.equal(actual, timer); cancelled = true; },
    onError: error => errors.push(error),
  });
  t.after(() => observer.close());
  await tick();
  const runs = join(box.root, 'background-runs');
  assert.equal(existsSync(runs), false, 'the real child cannot execute a pending proposal');
  nativeDecideSentinel(box.board, { agentId: store.PERSON, channel: 'view', name: row.name, digest: row.digest, decision: 'approve' });
  const configFile = join(box.root, 'pullboard.json');
  const config = readFileSync(configFile, 'utf8');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(config), health: { sentinel: false } }));
  await tick();
  assert.equal(existsSync(runs), false, 'the board off switch suppresses an approved watch');
  writeFileSync(configFile, config);
  const settingsFile = machineSettingsFile();
  const settings = readFileSync(settingsFile, 'utf8');
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(settings), health: { sentinel: false } }));
  await tick();
  assert.equal(existsSync(runs), false, 'the machine off switch suppresses an approved watch');
  writeFileSync(settingsFile, settings);
  await tick();
  assert.deepEqual(errors, []);
  assert.equal(existsSync(runs), false, 'the real background resume child never executes an approved watch');
  const notices = store.allShouts(box.board).filter(shout => shout.shout_text.startsWith('Sentinel failed: background'));
  assert.equal(notices.length, 0, 'resume cannot invent a result or owner alert');
  assert.equal(sentinels(box.board)[0].lastRun, null);
  assert.equal(store.events(box.board).some(row => row.event_kind === 'sentinel-start'), false);
  await tick();
  assert.equal(existsSync(runs), false, 'a second health callback still leaves the watch to its scheduled command');
  await observer.close();
  assert.equal(cancelled, true);
});


test('a person approves or declines a sentinel by its exact proposal [N26,P6]', async t => {
  const box = fixture(t);
  const proposal = nativeProposeSentinel(box.board, { agentId: box.agent,
    row: { name: 'view-watch', check: 'true', directory: '.', every: 'hourly', owner: 'core' } });
  const draft = sentinelDraftNeeds(sentinels(box.board))[0];
  assert.deepEqual([draft.check, draft.directory, draft.every, draft.owner, draft.digest],
    [proposal.check, proposal.directory, proposal.every, proposal.owner, proposal.digest],
    'the person sees the exact command, directory, schedule, owner and proposal digest');
  /** Exercise the existing API-to-CLI adapter on this actual private person-view board. */
  const act = (intent, channel = 'view') => executeMove(box.root, intent,
    (argv, streams) => main(argv, { ...streams, clock: box.clock }), undefined, channel, undefined, apiBoardOpeners);
  const approval = personRequestMove({ verb: 'sentinel-approve', args: { name: proposal.name, digest: proposal.digest } });
  assert.deepEqual(moveArgs(approval), ['sentinel', 'approve', `--digest=${proposal.digest}`, '--json', '--', proposal.name]);
  for (const args of [{ name: proposal.name }, { ...approval.args, digest: 'not-a-digest' }, { ...approval.args, as: 'person' }]) {
    assert.throws(() => personRequestMove({ verb: 'sentinel-approve', args }), error => error.code === 'BAD_REQUEST');
  }
  const approved = await act(approval);
  assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.equal(sentinels(box.board)[0].status, 'approved');
  const replacement = nativeProposeSentinel(box.board, { agentId: box.agent, row: { ...proposal, check: 'false' } });
  const beforeStale = exportBoard(box.board);
  const stale = await act(approval);
  assert.equal(stale.body.error?.code, 'STALE_SENTINEL');
  assert.deepEqual(exportBoard(box.board), beforeStale, 'an old tap neither approves the replacement nor writes a decision');
  const decline = personRequestMove({ verb: 'sentinel-decline', args: { name: replacement.name,
    digest: replacement.digest, reason: '  Not this command  ' } });
  assert.deepEqual(moveArgs(decline), ['sentinel', 'decline', `--digest=${replacement.digest}`,
    '--reason=  Not this command  ', '--json', '--', replacement.name]);
  const declined = await act(decline);
  assert.equal(declined.status, 200, JSON.stringify(declined));
  assert.equal(sentinels(box.board)[0].status, 'declined');
  assert.equal(sentinels(box.board)[0].reason, 'Not this command');
  for (const intent of [approval, decline]) {
    const beforeAgent = exportBoard(box.board);
    const refused = await act(intent, 'agent');
    assert.equal(refused.body.error?.code, 'B26_PERSON_CHANNEL');
    assert.deepEqual(exportBoard(box.board), beforeAgent, 'an agent API channel never makes a person decision');
  }
  const relayed = nativeProposeSentinel(box.board, { agentId: box.agent,
    row: { name: 'relay-watch', check: 'true', every: 'daily', owner: 'core' } });
  const intent = { verb: 'sentinel-approve', args: { name: relayed.name, digest: relayed.digest } };
  /** Receive only through the ordinary durable authenticated request intake. */
  const receive = (id, sender, requested = intent) => receivePersonRequest(box.board, preparePersonRequest(requested, id),
    { sequence: appliedSequence(box.board) + 1, at: box.clock.now().toISOString(), sender });
  assert.equal(receive('agent-sentinel', { kind: 'agent', agent: box.agent, userId: 'fixture-person' }).error?.code, 'RELAY_PERSON_ONLY');
  assert.equal(receive('member-sentinel', { kind: 'person', userId: 'fixture-person', approver: false }).error?.code, 'NOT_APPROVER');
  const person = { kind: 'person', userId: 'fixture-person', approver: true, login: 'phone-person', engine: PEOPLE_ENGINE };
  const record = receive('person-sentinel', person);
  assert.equal(record.status, 'waiting');
  /** Bind each ordinary effect to the exact authenticated document under the existing receipt verifier. */
  const tagged = (operation, args, phase, id, requested = record) => {
    const move = prepareEngineMove(box.board, operation, args, { id });
    move.personRequest = { id: requested.id, executor: 'fixture-device', phase, digest: requestIntentDigest(requested) };
    return move;
  };
  /** The elected machine may carry the person's exact request, never mint another person action. */
  const replay = move => applyRelayMove(box.board, move, { sequence: appliedSequence(box.board) + 1,
    at: box.clock.now().toISOString(), kind: 'move', sender: { kind: 'machine', machine: 'fixture-device',
      userId: 'fixture-person', login: 'executor-person', engine: PEOPLE_ENGINE } });
  const claim = tagged('shout', [{ from: 'person', to: 'coordinator', text: requestStageText(record, 'claim'), lanes: ['core'] }], 'claim', 'sentinel-claim');
  assert.equal(replay(claim).error, undefined);
  const decision = { agentId: store.PERSON, channel: 'view', name: relayed.name,
    digest: relayed.digest, decision: 'approve', reason: '' };
  for (const [index, change] of [{ name: 'view-watch' }, { digest: proposal.digest }, { decision: 'decline', reason: 'not requested' },
    { reason: 'not requested' }, { agentId: box.agent }, { channel: 'terminal' }].entries()) {
    const badMove = tagged('decideSentinel', [{ ...decision, ...change }], 'execute', `sentinel-bad-${index}`);
    assert.equal(requestMoveProblem(box.board, badMove)?.code, 'PERSON_REQUEST_RECEIPT');
    assert.equal(replay(badMove).error?.code, 'RELAY_PERSON_ONLY', 'an invalid receipt never grants the machine person authority');
    assert.equal(sentinels(box.board).find(row => row.name === relayed.name).status, 'pending');
    assert.equal(personRequestRecords(box.board).find(row => row.id === record.id).status, 'waiting');
  }
  const applied = replay(tagged('decideSentinel', [decision], 'execute', 'sentinel-exact'));
  assert.equal(applied.error, undefined, JSON.stringify(applied));
  assert.equal(sentinels(box.board).find(row => row.name === relayed.name).status, 'approved');
  assert.equal(personRequestRecords(box.board).find(row => row.id === record.id).status, 'done');
  assert.equal(JSON.parse(box.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='sentinel-decision' ORDER BY event_id DESC LIMIT 1").get().event_detail).person,
    person.login, 'the decision belongs to the initiating phone person, not its executor');
  const nextProposal = nativeProposeSentinel(box.board, { agentId: box.agent, row: { ...relayed, check: 'false' } });
  const declineIntent = { verb: 'sentinel-decline', args: { name: nextProposal.name,
    digest: nextProposal.digest, reason: '  Requested decline  ' } };
  const declineRecord = receive('person-sentinel-decline', person, declineIntent);
  assert.equal(declineRecord.status, 'waiting');
  const declineClaim = tagged('shout', [{ from: 'person', to: 'coordinator',
    text: requestStageText(declineRecord, 'claim'), lanes: ['core'] }], 'claim', 'sentinel-decline-claim', declineRecord);
  assert.equal(replay(declineClaim).error, undefined);
  const declineDecision = { agentId: store.PERSON, channel: 'view', name: nextProposal.name,
    digest: nextProposal.digest, decision: 'decline', reason: declineIntent.args.reason.trim() };
  const wrongReason = tagged('decideSentinel', [{ ...declineDecision, reason: 'A different reason' }],
    'execute', 'sentinel-decline-wrong-reason', declineRecord);
  assert.equal(requestMoveProblem(box.board, wrongReason)?.code, 'PERSON_REQUEST_RECEIPT');
  assert.equal(replay(wrongReason).error?.code, 'RELAY_PERSON_ONLY');
  assert.equal(sentinels(box.board).find(row => row.name === nextProposal.name).status, 'pending');
  assert.equal(personRequestRecords(box.board).find(row => row.id === declineRecord.id).status, 'waiting');
  const exactDecline = replay(tagged('decideSentinel', [declineDecision], 'execute', 'sentinel-decline-exact', declineRecord));
  assert.equal(exactDecline.error, undefined, JSON.stringify(exactDecline));
  const declinedRelay = sentinels(box.board).find(row => row.name === nextProposal.name);
  assert.equal(declinedRelay.status, 'declined');
  assert.equal(declinedRelay.reason, 'Requested decline');
  assert.equal(personRequestRecords(box.board).find(row => row.id === declineRecord.id).status, 'done');
  assert.equal(JSON.parse(box.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='sentinel-decision' ORDER BY event_id DESC LIMIT 1").get().event_detail).person,
    person.login, 'the authenticated decline preserves its initiating person');
});
