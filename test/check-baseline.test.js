/** Check baselines run against main and travel with deterministic board moves [V2,H3,H16,N23]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild as spawnSync, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { openBoard, closeBoard, getItem } from '../src/board.js';
import { checkBaseline, prepareCheckBaseline } from '../src/check-baseline.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const BOARD_FILE = '.git/pullboard/board.sqlite';
const TEMP_DIRS = [];
const SPEC = `# Check baseline fixture\n\n## G · Goals\n- G1 [approved, must] The fixture keeps its board. | gate: true\n`;

/** Remove each private fixture after node:test has stopped its child processes. */
function cleanupFixtures() {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

after(cleanupFixtures);

/** Quote one shell word without allowing fixture paths or source to become syntax. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Create private Git, CLI and machine-home settings without inheriting repository selectors. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-check-baseline-'));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Check baseline fixture',
    GIT_AUTHOR_EMAIL: 'check-baseline@example.invalid',
    GIT_COMMITTER_NAME: 'Check baseline fixture',
    GIT_COMMITTER_EMAIL: 'check-baseline@example.invalid',
  });
  /** Run Git with only this fixture's config and identity. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env });
  }
  /** Run a real pullboard CLI process with optional stdin. */
  function run(cwd, args, input, options = {}) {
    return runFixtureChild(process.execPath, [BIN, ...args], {
      cwd, env, encoding: 'utf8',
      ...(input === undefined ? {} : { input }), ...options,
    });
  }
  return { dir, env, git, run };
}

/** Initialize an isolated repo and optional real web/review worktrees. */
function project({ gate = 'true', content = 'green', commit = true, worktrees = false } = {}) {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'result.txt'), `${content}\n`);
  const initialized = box.run(repo, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const configFile = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, `${JSON.stringify({
    ...config,
    gate,
    spec: 'SPEC.md',
    lanes: {
      web: { owns: ['web/'], specs: ['G1'] },
      review: { owns: [], specs: ['G1'] },
    },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  if (commit) {
    box.git(repo, 'add', '-A');
    box.git(repo, 'commit', '-q', '-m', 'chore: set up check baseline fixture');
  }
  const fixture = { ...box, repo, web: null, review: null };
  if (worktrees) {
    fixture.web = addWorktree(fixture, 'web', 'web/agent');
    fixture.review = addWorktree(fixture, 'review', 'review/agent');
  }
  return fixture;
}

/** Create and join one real worktree for the requested fixture lane. */
function addWorktree(box, lane, branch) {
  const path = join(box.dir, lane);
  box.git(box.repo, 'worktree', 'add', '-q', path, '-b', branch);
  const joined = box.run(path, ['join', lane]);
  assert.equal(joined.status, 0, joined.stderr);
  return path;
}

/** Build a command that records its execution location and checks one tracked value. */
function fileCheck(expected, marker = 'check-marker.txt', observations = null) {
  const script = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    ...(observations ? [`fs.appendFileSync(${JSON.stringify(observations)}, process.cwd() + '\\n');`] : []),
    `process.exit(fs.readFileSync('web/result.txt', 'utf8').trim() === ${JSON.stringify(expected)} ? 0 : 1);`,
  ].join('');
  return `${shellWord(process.execPath)} -e ${shellWord(script)}`;
}

/** Add a check-bearing item as coordinator and return its JSON result and item id. */
function addChecked(box, title, check) {
  const result = box.run(box.repo, ['add', 'web', title, '--specs', 'G1', '--criterion', 'the check is measured on main', '--check', check, '--wait', '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', 'add writes no baseline diagnostics to stderr');
  return { result, item: JSON.parse(result.stdout).item };
}

/** Read the item's JSON view so tests inspect its public baseline shape. */
function showItem(box, id, cwd = box.repo) {
  const result = box.run(cwd, ['show', String(id), '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { result, item: JSON.parse(result.stdout) };
}

/** Await an actual fixture state, with a deadline used only to prevent a stranded child. */
async function waitForState(read, description) {
  const deadline = Date.now() + 30_000;
  while (!read() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
  assert.ok(read(), description);
}

/** Build a check held on a release file; its finite fallback lets a blocking mutant finish red. */
function heldCheck(box, name) {
  const started = join(box.dir, `${name}-started.json`);
  const finished = join(box.dir, `${name}-finished`);
  const release = join(box.dir, `${name}-release`);
  const script = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({cwd:process.cwd(),content:fs.readFileSync('web/result.txt','utf8').trim()}));`,
    `const until=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);`,
    `fs.writeFileSync(${JSON.stringify(finished)},'finished');`,
  ].join('');
  return { started, finished, release, command: `${shellWord(process.execPath)} -e ${shellWord(script)}` };
}

test('[V2,H16] add and edit return while isolated background checks are held, then publish their results', async (t) => {
  const box = project({ content: 'committed' });
  const originalMain = box.git(box.repo, 'rev-parse', 'main');
  writeFileSync(join(box.repo, 'web/result.txt'), 'dirty live checkout\n');
  const addition = heldCheck(box, 'add-background');
  const edit = heldCheck(box, 'edit-background');
  t.after(() => {
    writeFileSync(addition.release, 'release');
    writeFileSync(edit.release, 'release');
  });
  const added = box.run(box.repo, ['add', 'web', 'Background check', '--check', addition.command, '--json']);
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  assert.equal(existsSync(addition.finished), false, 'add returns before its baseline finishes');
  const item = JSON.parse(added.stdout).item;
  assert.equal(item.item_check_baseline.result, 'pending');
  assert.equal(item.item_check_baseline.main, originalMain);
  await waitForState(() => existsSync(addition.started), 'the detached add worker runs after the caller exits');
  const observed = JSON.parse(readFileSync(addition.started, 'utf8'));
  assert.notEqual(observed.cwd, box.repo);
  assert.equal(observed.content, 'committed', 'the baseline sees committed main, never dirty live content');
  writeFileSync(addition.release, 'release');
  await waitForState(() => withBoard(join(box.repo, BOARD_FILE), (board) => getItem(board, item.item_id).item_check_baseline?.result === 'green'), 'the background add result is recorded');
  assert.equal(existsSync(observed.cwd), false, 'the isolated checkout is removed after its check');
  assert.match(box.run(box.repo, ['show', String(item.item_id)]).stdout, /CRITERION_PROVES_NOTHING/u);
  const edited = box.run(box.repo, ['edit', String(item.item_id), '--check', edit.command, '--json']);
  assert.equal(edited.status, 0, `${edited.stdout}${edited.stderr}`);
  assert.equal(existsSync(edit.finished), false, 'edit returns before its changed check finishes');
  assert.equal(JSON.parse(edited.stdout).item.item_check_baseline.result, 'pending');
  await waitForState(() => existsSync(edit.started), 'the detached edit worker starts');
  writeFileSync(edit.release, 'release');
  await waitForState(() => withBoard(join(box.repo, BOARD_FILE), (board) => getItem(board, item.item_id).item_check_baseline?.result === 'green'), 'the background edit result is recorded');
  const final = showItem(box, item.item_id).item;
  assert.equal(final.item_check_baseline.command, edit.command);
  assert.equal(final.item_check_baseline.warning, 'CRITERION_PROVES_NOTHING');
  assert.equal(readFileSync(join(box.repo, 'web/result.txt'), 'utf8'), 'dirty live checkout\n');
});

test('[V2,H16] --wait keeps the check blocking and the captured base survives a later main commit', (t) => {
  const box = project({ content: 'original' });
  const held = heldCheck(box, 'wait-background');
  t.after(() => writeFileSync(held.release, 'release'));
  const waited = box.run(box.repo, ['add', 'web', 'Wait for check', '--check', held.command, '--wait', '--json']);
  assert.equal(waited.status, 0, `${waited.stdout}${waited.stderr}`);
  assert.equal(existsSync(held.finished), true, '--wait returns only after the held check finishes');
  assert.equal(JSON.parse(waited.stdout).item.item_check_baseline.result, 'green');
  const command = fileCheck('original', 'captured-base-marker.txt');
  const captured = prepareCheckBaseline(box.repo, command);
  writeFileSync(join(box.repo, 'web/result.txt'), 'new main\n');
  box.git(box.repo, 'add', 'web/result.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'test: change captured main fixture');
  const completed = checkBaseline(box.repo, command, { main: captured.main });
  assert.notEqual(captured.main, box.git(box.repo, 'rev-parse', 'main'));
  assert.equal(completed.main, captured.main);
  assert.equal(completed.result, 'green', 'a later main cannot change the queued observation');
  assert.equal(existsSync(join(box.repo, 'captured-base-marker.txt')), false);
});

test('[V2,H3,H16] baseline comes from committed main while manual check uses the branch', async function baselineUsesMain() {
  const box = project({ content: 'red', worktrees: true });
  const main = box.git(box.repo, 'rev-parse', 'refs/heads/main');
  writeFileSync(join(box.repo, 'web', 'result.txt'), 'green\n');
  writeFileSync(join(box.web, 'web', 'result.txt'), 'green\n');
  const before = box.git(box.repo, 'status', '--porcelain');
  const marker = 'baseline-command-ran.txt';
  const observations = join(box.dir, 'baseline-executions.txt');
  const check = fileCheck('green', marker, observations);
  const { item } = addChecked(box, 'Main baseline is red', check);
  assert.equal(item.item_check_baseline.command, check);
  assert.equal(item.item_check_baseline.main, main);
  assert.equal(item.item_check_baseline.result, 'red', 'the stored result describes committed main, not the dirty green worktree');
  assert.ok(Number.isFinite(item.item_check_baseline.seconds), 'the baseline includes its measured run time');
  assert.equal(item.item_check_baseline.warning, undefined, 'a red baseline does not say the criterion already passes');
  assert.equal(existsSync(join(box.repo, marker)), false, 'baseline execution never writes into the live main checkout');
  assert.equal(existsSync(join(box.web, marker)), false, 'baseline execution never writes into the live agent checkout');
  assert.equal(box.git(box.repo, 'status', '--porcelain'), before, 'baseline capture preserves the dirty live main checkout');
  const locations = readFileSync(observations, 'utf8').trim().split('\n');
  assert.equal(locations.length, 1, 'the newly supplied check runs exactly once');
  assert.ok(locations[0] !== box.repo && locations[0] !== box.web, 'it runs in neither live checkout');
  assert.equal(existsSync(locations[0]), false, 'the temporary checkout is removed after recording the result');

  const manual = box.run(box.web, ['check', String(item.item_id), '--yes', '--json']);
  assert.equal(manual.status, 0, `${manual.stdout}${manual.stderr}`);
  assert.equal(JSON.parse(manual.stdout).green, true, 'manual check runs against the green branch');
  assert.equal(readFileSync(join(box.web, marker), 'utf8'), 'ran');
  const after = showItem(box, item.item_id, box.web).item;
  assert.deepEqual(after.item_check_baseline, item.item_check_baseline, 'manual branch success does not rewrite the main baseline');
});

test('[V2,H3,H16] green baseline warns through add edit show and private next verify', async function greenBaselineWarnings() {
  const box = project({ content: 'green', worktrees: true });
  const check = fileCheck('green', 'first-check-marker.txt');
  const { result: added, item } = addChecked(box, 'Green baseline warning', check);
  assert.match(added.stdout, /CRITERION_PROVES_NOTHING/u);
  assert.equal(item.item_check_baseline.result, 'green');
  assert.equal(item.item_check_baseline.main, box.git(box.repo, 'rev-parse', 'refs/heads/main'));
  assert.equal(existsSync(join(box.repo, 'first-check-marker.txt')), false, 'the passing baseline ran in its temporary clone');

  const changedCheck = fileCheck('green', 'edited-check-marker.txt');
  const edited = box.run(box.repo, ['edit', String(item.item_id), '--check', changedCheck, '--wait', '--json']);
  assert.equal(edited.status, 0, `${edited.stdout}${edited.stderr}`);
  assert.equal(edited.stderr, '', 'edit writes no baseline diagnostics to stderr');
  assert.match(edited.stdout, /CRITERION_PROVES_NOTHING/u);
  assert.equal(JSON.parse(edited.stdout).item.item_check_baseline.command, changedCheck);
  assert.equal(existsSync(join(box.repo, 'edited-check-marker.txt')), false, 'the edited baseline also ran in a temporary clone');

  const shown = box.run(box.repo, ['show', String(item.item_id)]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /CRITERION_PROVES_NOTHING/u);
  const textAdded = box.run(box.repo, ['add', 'web', 'Text baseline warning', '--check', check, '--wait']);
  assert.equal(textAdded.status, 0, textAdded.stderr);
  assert.match(textAdded.stdout, /warning: \[CRITERION_PROVES_NOTHING\]/u);
  const textEdited = box.run(box.repo, ['edit', String(item.item_id), '--check', `${changedCheck}\n# a distinct command`, '--wait']);
  assert.equal(textEdited.status, 0, textEdited.stderr);
  assert.match(textEdited.stdout, /warning: \[CRITERION_PROVES_NOTHING\]/u);

  const claimed = box.run(box.web, ['next']);
  assert.equal(claimed.status, 0, `${claimed.stdout}${claimed.stderr}`);
  writeFileSync(join(box.web, 'web', 'proof.txt'), 'submitted\n');
  box.git(box.web, 'add', 'web/proof.txt');
  box.git(box.web, 'commit', '-q', '-m', 'test: submit green check baseline fixture');
  const submitted = box.run(box.web, ['submit', String(item.item_id)]);
  assert.equal(submitted.status, 0, `${submitted.stdout}${submitted.stderr}`);

  const review = box.run(box.review, ['next', '--verify']);
  assert.equal(review.status, 0, `${review.stdout}${review.stderr}`);
  assert.match(review.stdout, /CRITERION_PROVES_NOTHING/u);
});

test('[V2,H3,H16] repo gates skip command execution and baselines preserve clear and missing-main states', async function baselineTransitions() {
  const box = project({ content: 'green' });
  const gateMarker = join(box.dir, 'repo-gate-marker.txt');
  const gate = fileCheck('green', gateMarker);
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), gate }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: set the fixture gate');
  const { item: gated } = addChecked(box, 'Gate check', gate);
  assert.deepEqual(gated.item_check_baseline, {
    command: gate,
    main: box.git(box.repo, 'rev-parse', 'refs/heads/main'),
    result: 'green',
    reason: 'repo gate',
    warning: 'CRITERION_PROVES_NOTHING',
  });
  assert.equal(existsSync(gateMarker), false, 'an exact gate match never runs its command, even in the temporary clone');

  const metadataEdit = box.run(box.repo, ['edit', String(gated.item_id), '--brief', 'updated brief', '--json']);
  assert.equal(metadataEdit.status, 0, `${metadataEdit.stdout}${metadataEdit.stderr}`);
  assert.deepEqual(JSON.parse(metadataEdit.stdout).item.item_check_baseline, gated.item_check_baseline,
    'an edit that leaves the check unchanged retains the measured baseline');

  const changedExecutions = join(box.dir, 'changed-check-executions.txt');
  const changedCheck = fileCheck('green', 'changed-check-marker.txt', changedExecutions);
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), gate: changedCheck }));
  const changed = box.run(box.repo, ['edit', String(gated.item_id), '--check', changedCheck, '--wait', '--json']);
  assert.equal(changed.status, 0, `${changed.stdout}${changed.stderr}`);
  const changedBaseline = JSON.parse(changed.stdout).item.item_check_baseline;
  assert.equal(changedBaseline.command, changedCheck);
  assert.equal(changedBaseline.main, gated.item_check_baseline.main);
  assert.equal(changedBaseline.result, 'green');
  assert.equal(changedBaseline.reason, undefined, 'a dirty config cannot turn a new check into the committed main gate');
  assert.equal(readFileSync(changedExecutions, 'utf8').trim().split('\n').length, 1, 'the dirty-config check really runs once at main');
  assert.equal(existsSync(join(box.repo, 'changed-check-marker.txt')), false, 'changed checks run only in the temporary main clone');

  const cleared = box.run(box.repo, ['edit', String(gated.item_id), '--check', '', '--json']);
  assert.equal(cleared.status, 0, `${cleared.stdout}${cleared.stderr}`);
  assert.equal(JSON.parse(cleared.stdout).item.item_check, '');
  assert.equal(Object.hasOwn(JSON.parse(cleared.stdout).item, 'item_check_baseline'), false, 'clearing a check clears its baseline');
  assert.ok(!snapshotFile(join(box.repo, BOARD_FILE)).tables.board_meta.some((row) => row.meta_key === `item_check_baseline_${gated.item_id}`), 'clearing also removes the persisted baseline metadata');

  const unborn = project({ commit: false });
  const noMainCheck = fileCheck('green', 'unborn-check-marker.txt');
  const { item: unavailable } = addChecked(unborn, 'Unborn main baseline', noMainCheck);
  assert.deepEqual(unavailable.item_check_baseline, {
    command: noMainCheck, main: null, result: 'unavailable', reason: 'no main',
  }, 'an unborn main reports unavailable without refusing item creation');
  assert.equal(existsSync(join(unborn.repo, 'unborn-check-marker.txt')), false, 'no-main handling never falls back to the live checkout');
});

/** Open a board file and always close it after returning a synchronous result. */
function withBoard(file, callback) {
  const board = openBoard(file);
  try { return callback(board); } finally { closeBoard(board); }
}

/** Import one native snapshot into a separate real SQLite replica. */
function importReplica(file, snapshot) {
  withBoard(file, (board) => importBoard(board, snapshot));
}

/** Read a native snapshot from a replica, including its event and metadata tables. */
function snapshotFile(file) {
  return withBoard(file, exportBoard);
}

/** Apply a captured move in a separate Node process so each replica has its own cwd and env. */
function applyInReplica(file, replicaDir, moveFile, env, at = '2026-10-07T12:00:00.000Z') {
  const boardUrl = new URL('../src/board.js', import.meta.url).href;
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const source = [
    `import { openBoard, closeBoard } from ${JSON.stringify(boardUrl)};`,
    `import { applyEngineMove } from ${JSON.stringify(engineUrl)};`,
    "import { readFileSync } from 'node:fs';",
    'const board = openBoard(process.argv[1]);',
    'try { applyEngineMove(board, JSON.parse(readFileSync(process.argv[2], "utf8")), { sequence: Number(process.argv[3]), at: process.argv[4] }); }',
    'finally { closeBoard(board); }',
  ].join('\n');
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file, moveFile, String(env.sequence), at], {
    cwd: replicaDir, env, encoding: 'utf8',
  });
}

test('[H3,H16] captured add and edit baselines replay identically without running shell checks', async function baselineMoveReplay() {
  const box = project();
  const baseFile = join(box.repo, BOARD_FILE);
  const seed = snapshotFile(baseFile);
  const senderFile = join(box.dir, 'sender.sqlite');
  importReplica(senderFile, seed);
  const senderDir = join(box.dir, 'sender');
  const replicaA = join(box.dir, 'replica-a');
  const replicaB = join(box.dir, 'replica-b');
  for (const dir of [senderDir, replicaA, replicaB]) mkdirSync(dir);
  const fileA = join(replicaA, 'board.sqlite');
  const fileB = join(replicaB, 'board.sqlite');
  importReplica(fileA, seed);
  importReplica(fileB, seed);
  const markerA = join(replicaA, 'must-not-run');
  const markerB = join(replicaB, 'must-not-run');
  const shellCheck = `${shellWord(process.execPath)} -e ${shellWord(`require('node:fs').writeFileSync(process.cwd() + '/must-not-run', 'ran')`)}`;
  const baseline = {
    command: shellCheck,
    main: 'a'.repeat(40),
    result: 'red',
  };
  let move;
  withBoard(senderFile, (sender) => {
    move = prepareEngineMove(sender, 'addItem', [{
      by: 'coordinator', lane: 'web', title: 'Replayed baseline', criterion: 'the baseline stays captured',
      check: shellCheck, checkBaseline: baseline,
    }], { id: 'check-baseline-add' });
  });
  assert.deepEqual(move.args[0].checkBaseline, baseline, 'the measured object is embedded in the sender-authored move');
  withBoard(senderFile, (sender) => applyEngineMove(sender, move, { sequence: 1, at: '2026-10-07T12:00:00.000Z' }));
  const moveFile = join(box.dir, 'add-move.json');
  writeFileSync(moveFile, JSON.stringify(move));
  const envA = { ...box.env, CHECK_REPLICA: 'a', sequence: '1' };
  const envB = { ...box.env, CHECK_REPLICA: 'b', sequence: '1' };
  const appliedA = applyInReplica(fileA, replicaA, moveFile, envA);
  const appliedB = applyInReplica(fileB, replicaB, moveFile, envB);
  assert.equal(appliedA.status, 0, `${appliedA.stdout}${appliedA.stderr}`);
  assert.equal(appliedB.status, 0, `${appliedB.stdout}${appliedB.stderr}`);
  assert.equal(existsSync(markerA), false, 'replica A stores the captured result without running the command');
  assert.equal(existsSync(markerB), false, 'replica B stores the captured result without running the command');
  assert.deepEqual(snapshotFile(fileA), snapshotFile(fileB), 'both SQLite replicas commit the same item, baseline, event and receipt');

  const editBaseline = { ...baseline, command: `${shellCheck} --edited`, result: 'green' };
  let edit;
  withBoard(senderFile, (sender) => {
    const item = sender.db.prepare("SELECT item_id FROM item WHERE item_title='Replayed baseline'").get();
    edit = prepareEngineMove(sender, 'editItem', [item.item_id, {
      agentId: 'coordinator', check: editBaseline.command, checkBaseline: editBaseline,
    }], { id: 'check-baseline-edit' });
  });
  assert.deepEqual(edit.args[1].checkBaseline, editBaseline, 'the edited measurement is captured before replay too');
  withBoard(senderFile, (sender) => applyEngineMove(sender, edit, { sequence: 2, at: '2026-10-07T12:00:01.000Z' }));
  const editFile = join(box.dir, 'edit-move.json');
  writeFileSync(editFile, JSON.stringify(edit));
  const editedA = applyInReplica(fileA, replicaA, editFile, { ...envA, sequence: '2' }, '2026-10-07T12:00:01.000Z');
  const editedB = applyInReplica(fileB, replicaB, editFile, { ...envB, sequence: '2' }, '2026-10-07T12:00:01.000Z');
  assert.equal(editedA.status, 0, `${editedA.stdout}${editedA.stderr}`);
  assert.equal(editedB.status, 0, `${editedB.stdout}${editedB.stderr}`);
  assert.equal(existsSync(markerA), false);
  assert.equal(existsSync(markerB), false);
  assert.deepEqual(snapshotFile(fileA), snapshotFile(fileB), 'replayed edits preserve equal baseline and event metadata');
  assert.deepEqual(snapshotFile(senderFile), snapshotFile(fileA), 'sender and both receiving databases share the same add/edit history');
});
